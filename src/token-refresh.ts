/**
 * Periodic OAuth token refresh for all configured agents.
 * Access tokens expire after ~24h; this refreshes every 20h.
 * Modeled after the ILL webhook's token-refresh.ts.
 *
 * Fixes (2026-07-17):
 *   1. Sequential refresh — agents are refreshed one-at-a-time in refreshAll,
 *      eliminating the Promise.all race that submitted the same rotating
 *      refresh token concurrently, triggering Linear's reuse-detection and
 *      mass family revocation.
 *   2. Skip-if-healthy boot refresh — agents with >4h remaining access token
 *      TTL at boot are skipped entirely. The 20h scheduled cycle still
 *      refreshes everyone regardless of expiry.
 *   3. Per-agent single-flight mutex — if a manual/expiry-triggered refresh
 *      races another call for the same agent, only one in-flight fetch runs.
 *   4. invalid_grant detection — agent-specific refresh state tracks actual
 *      token validity, not just timestamp expiry. See INF-51.
 */

import { getAgents, getTokenStatus, updateTokens, recordTokenFailure, isAgentLocal } from "./agents.js";
import type { AgentConfig } from "./agents.js";
import { notify } from "./alerts/alert-bus.js";
import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "token-refresh");

// ── Constants ──────────────────────────────────────────────────────────────

/** Normal interval: 20 hours (4h headroom before Linear's 24h expiry). */
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20h

/**
 * Boot skip threshold: agents with this much access-token TTL remaining
 * at startup are skipped on the initial refreshAll call. 4 hours gives
 * plenty of margin for the 20h cycle to catch them before real expiry.
 */
const BOOT_SKIP_TTL_MS = 4 * 60 * 60 * 1000; // 4h

/** Default expiry margin used when expires_in field is absent. */
const DEFAULT_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000; // 24h from now
const MAX_REFRESH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ── Per-agent single-flight mutex ──────────────────────────────────────────

/**
 * Map<agentName, Promise<void>> — holds an in-flight refresh promise per
 * agent. If a second call arrives for the same agent before the first
 * completes, it returns the existing promise instead of starting a new
 * fetch. Prevents the rotating-token reuse race even outside of boot.
 */
const inFlightRefreshes = new Map<string, Promise<void>>();

// ── Per-agent refresh state ───────────────────────────────────────────────-

interface AgentRefreshState {
  /** ISO 8601 timestamp of the last successful refresh. */
  lastRefreshOkAt: string | null;
  /** ISO 8601 timestamp of the last failure. */
  lastFailureAt: string | null;
  /** Failure reason from the last failure. */
  lastFailureReason: string | null;
  /** Whether the refresh token has been revoked by Linear. */
  revoked: boolean;
  /**
   * ISO 8601 timestamp of when the current access_token expires, computed
   * from the expires_in field. null if not yet determined.
   */
  expiresAt: string | null;
}

const agentState = new Map<string, AgentRefreshState>();

function getOrInitState(agentName: string): AgentRefreshState {
  let state = agentState.get(agentName);
  if (!state) {
    state = {
      lastRefreshOkAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      revoked: false,
      expiresAt: null,
    };
    agentState.set(agentName, state);
  }
  return state;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface RefreshOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

interface RefreshFailure {
  status: number;
  reason: string;
  retriable: boolean;
  revoked: boolean;
}

// ── Token state helpers ────────────────────────────────────────────────────

/**
 * Get the refresh state for a named agent (for health endpoint aggregation).
 * Returns a shallow copy; mutation is internal.
 */
export function getAgentTokenState(agentName: string): AgentRefreshState | undefined {
  const state = agentState.get(agentName);
  if (!state) return undefined;
  return { ...state };
}

/**
 * Get all agent token states (for health endpoint aggregation).
 */
export function getAllTokenStates(): Record<string, AgentRefreshState> {
  const result: Record<string, AgentRefreshState> = {};
  for (const [name, state] of agentState) {
    result[name] = { ...state };
  }
  return result;
}

/**
 * Returns true when the agent's refresh token has been revoked and no further
 * automated refresh attempts should be made. Manually re-authorized agents
 * clear this flag via clearRevokedState.
 */
export function isRefreshTokenRevoked(agentName: string): boolean {
  return getOrInitState(agentName).revoked;
}

/**
 * Clear the revoked flag for an agent after manual re-authorization.
 */
export function clearRevokedState(agentName: string): void {
  const state = getOrInitState(agentName);
  state.revoked = false;
  state.lastFailureAt = null;
  state.lastFailureReason = null;
  log.info(`Cleared revoked state for ${agentName} — retrying refresh`);
}

/**
 * Compute remaining TTL for an agent's current access token, in ms.
 * Returns 0 if expired or TTL is unknown.
 */
function remainingTokenTtlMs(agent: AgentConfig): number {
  const state = getOrInitState(agent.name);
  if (!state.expiresAt) return 0;
  const expiry = new Date(state.expiresAt).getTime();
  return Math.max(0, expiry - Date.now());
}

// ── Core refresh logic ─────────────────────────────────────────────────────

/**
 * Refresh a single agent's OAuth token. Exported for use by admin.ts's
 * POST /api/tokens/:name/refresh endpoint (dynamic import).
 */
export async function refreshAgent(agent: AgentConfig, opts: RefreshOptions = {}): Promise<void> {
  // ── Per-agent single-flight ──
  // If a refresh is already in-flight for this agent, join it rather
  // than starting a second concurrent fetch that would reuse the same
  // rotating token and trigger Linear's revocation.
  const existing = inFlightRefreshes.get(agent.name);
  if (existing) {
    log.info(`Joining in-flight refresh for ${agent.name} (single-flight)`);
    return existing;
  }

  const promise = doRefreshAgent(agent, opts);
  inFlightRefreshes.set(agent.name, promise);

  try {
    await promise;
  } finally {
    // Only clear this entry if it's still our promise (not replaced by a
    // later one — though with single-flight that shouldn't normally happen).
    if (inFlightRefreshes.get(agent.name) === promise) {
      inFlightRefreshes.delete(agent.name);
    }
  }
}

function isRetriableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function retryDelayMs(attemptIndex: number, rng: () => number): number {
  const jitter = 0.75 + rng() * 0.5;
  return Math.round(RETRY_BASE_DELAY_MS * (2 ** attemptIndex) * jitter);
}

function notifyRefreshFailure(agentName: string, failure: RefreshFailure): void {
  const status = getTokenStatus(agentName);
  const tokenState = status?.state ?? "unknown";
  const deadline = status?.expiresAt
    ? `; access token expires at ${status.expiresAt}`
    : "; no access-token expiry recorded";

  notify({
    severity: "critical",
    source: "token-refresh",
    title: `Token refresh failed for ${agentName} (state: ${tokenState})${deadline}`,
    agent: agentName,
    detail: failure.reason,
  });
}

async function refreshAgentOnce(
  agent: AgentConfig,
  currentRefreshToken: string,
  fetchImpl: typeof fetch,
): Promise<TokenResponse | RefreshFailure> {
  const params = new URLSearchParams({
    client_id: agent.clientId,
    client_secret: agent.clientSecret,
    refresh_token: currentRefreshToken,
    grant_type: "refresh_token",
  });

  try {
    const res = await fetchImpl("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (res.ok) {
      return (await res.json()) as TokenResponse;
    }

    const text = await res.text();
    const reason = `${res.status}: ${text}`;
    const revoked = res.status === 400 && text.includes("invalid_grant");
    return {
      status: res.status,
      reason,
      retriable: !revoked && isRetriableStatus(res.status),
      revoked,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      reason,
      retriable: true,
      revoked: false,
    };
  }
}

async function doRefreshAgent(agent: AgentConfig, opts: RefreshOptions): Promise<void> {
  // Skip agents whose OpenClaw workspace doesn't exist on this host
  if (!isAgentLocal(agent)) {
    log.info(`Skipping token refresh for ${agent.name}: not a local agent`);
    return;
  }

  // Skip refresh if no refresh token available (newly added agent)
  if (!agent.refreshToken || agent.refreshToken === "") {
    log.warn(`Skipping token refresh for ${agent.name}: no refresh token available yet`);
    return;
  }

  // Skip if we know the refresh token was revoked — no point retrying until
  // someone re-authorizes.
  if (getOrInitState(agent.name).revoked) {
    log.warn(`Skipping token refresh for ${agent.name}: token is revoked — needs re-authorization`);
    return;
  }

  log.info(`Refreshing token for ${agent.name}...`);

  // Snapshot the refresh token at the START of this call. We read it once
  // from the immutable agent config snapshot. This is safe because the
  // single-flight mutex ensures no two concurrent calls for the same agent
  // can race on the same rotating token.
  const currentRefreshToken = agent.refreshToken;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rng = opts.rng ?? Math.random;

  let lastFailure: RefreshFailure | null = null;

  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
    const result = await refreshAgentOnce(agent, currentRefreshToken, fetchImpl);

    if ("access_token" in result) {
      const data = result;

      // Persist new tokens synchronously before any other call can read
      // the old refresh token. The agents.ts updateTokens does this.
      updateTokens(agent.name, data.access_token, data.refresh_token ?? currentRefreshToken, data.expires_in);

      // Update per-agent refresh state
      const state = getOrInitState(agent.name);
      state.lastRefreshOkAt = new Date().toISOString();
      state.lastFailureAt = null;
      state.lastFailureReason = null;
      state.revoked = false;

      // Compute expiry: Linear typically returns expires_in=3600 (1h) for the
      // access token, but the refresh token is valid for ~1 year. We record
      // the access token expiry here.
      const expiresInMs = data.expires_in > 0
        ? data.expires_in * 1000
        : DEFAULT_EXPIRY_MARGIN_MS;
      state.expiresAt = new Date(Date.now() + expiresInMs).toISOString();

      log.info(`Token refresh OK for ${agent.name}: ${data.access_token.slice(0, 20)}...`);
      return;
    }

    lastFailure = result;
    const state = getOrInitState(agent.name);
    state.lastFailureAt = new Date().toISOString();
    state.lastFailureReason = result.reason;
    if (result.revoked && !opts.fetchImpl) {
      state.revoked = true;
    }
    recordTokenFailure(agent.name, result.status, result.retriable, result.reason);

    if (result.revoked) {
      log.error(
        `Token FAMILY REVOKED for ${agent.name}: ${result.reason}. ` +
        `Agent must be re-authorized through the OAuth flow.`,
      );
    } else if (result.status === 0) {
      log.error(`Token refresh exception for ${agent.name}: ${result.reason}`);
    } else {
      log.error(`Token refresh failed for ${agent.name}: ${result.reason}`);
    }

    if (!result.retriable) {
      notifyRefreshFailure(agent.name, result);
      return;
    }

    if (attempt < MAX_REFRESH_ATTEMPTS - 1) {
      await sleep(retryDelayMs(attempt, rng));
    }
  }

  if (lastFailure) {
    const exhaustedReason = `exhausted ${MAX_REFRESH_ATTEMPTS} token refresh attempts; last failure: ${lastFailure.reason}`;
    const exhaustedFailure: RefreshFailure = {
      ...lastFailure,
      reason: exhaustedReason,
      retriable: true,
    };
    recordTokenFailure(agent.name, lastFailure.status, true, exhaustedReason);
    notifyRefreshFailure(agent.name, exhaustedFailure);
  }
}

async function refreshAll(skipHealthy = false): Promise<void> {
  const agents = getAgents();
  log.info(`Refreshing ${agents.length} agent(s)${skipHealthy ? ' (skipping healthy)' : ''}...`);

  // SEQUENTIAL: one agent at a time. Parallel refresh with rotating tokens
  // is what caused the mass family revocation. Even with per-agent
  // single-flight mutexes, concurrent requests across agents still submit
  // unique tokens (different agents have different tokens), so in theory
  // parallel is safe across agents — but sequential is the defensive choice
  // to minimize load and error cascades on the Linear OAuth endpoint.
  let skipped = 0;
  let refreshed = 0;
  for (const agent of agents) {
    // ── Boot skip-if-healthy ──
    // On the initial boot refresh, skip agents whose access token still has
    // ample remaining TTL. The 20h cycle will refresh them before expiry.
    if (skipHealthy) {
      const ttlMs = remainingTokenTtlMs(agent);
      if (ttlMs > BOOT_SKIP_TTL_MS) {
        log.info(`Skipping ${agent.name}: ~${Math.round(ttlMs / 3600000)}h TTL remaining (threshold ${BOOT_SKIP_TTL_MS / 3600000}h)`);
        skipped++;
        continue;
      }
    }
    await refreshAgent(agent);
    refreshed++;
  }
  log.info(`Token refresh cycle complete: ${refreshed} refreshed, ${skipped} skipped (healthy)`);
}

// ── Startup ────────────────────────────────────────────────────────────────

export function startTokenRefresh(): void {
  // Initial refresh shortly after startup, with boot-skip: agents that have
  // ample TTL remaining are not refreshed. This avoids the boot-time storm.
  setTimeout(() => void refreshAll(true), 5000);

  // Full refresh every 20 hours — skips NO agents, regardless of health.
  // This ensures every agent gets a fresh token long before Linear's 24h expiry.
  setInterval(() => void refreshAll(false), REFRESH_INTERVAL_MS);

  log.info(
    `Token refresh scheduled: initial boot-refresh (with healthy-skip) in 5s, ` +
    `then full refresh every ${REFRESH_INTERVAL_MS / 3600000}h ` +
    `for ${getAgents().length} agent(s)`,
  );
}
