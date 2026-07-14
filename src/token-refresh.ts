/**
 * Periodic OAuth token refresh for all configured agents.
 * Access tokens expire after ~24h; this refreshes every 20h.
 * Modeled after the ILL webhook's token-refresh.ts.
 *
 * A single transient upstream failure (e.g. a Linear HTTP 503) must not be
 * allowed to skip a refresh cycle — the next scheduled attempt is ~20h out,
 * which can land after the current token expires and start 401ing every
 * proxied Linear call for that agent (AI-1907 / AI-1911). So each cycle
 * retries with jittered backoff before giving up, and only escalates to a
 * visible alert once every attempt has failed.
 */

import { getAgents, updateTokens, recordTokenFailure, isAgentLocal, isPolledForLinear } from "./agents.js";
import type { AgentConfig } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(), "token-refresh");
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours

// Retry policy for a single agent's refresh within one cycle. A transient
// upstream 503 should self-heal in seconds-to-minutes, well before the ~24h
// token lifetime — so we retry a couple of times with jittered backoff rather
// than waiting out the full 20h interval.
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries
const BASE_BACKOFF_MS = 30_000; // first retry ~30s, then ~60s (exponential)
const BACKOFF_JITTER = 0.2; // ±20% to avoid thundering-herd across agents

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/** Result of one refresh attempt. */
type AttemptResult =
  | { ok: true }
  | { ok: false; retriable: boolean; reason: string };

export interface RefreshOptions {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests pass a no-op to avoid real backoff waits). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for jitter (tests). Defaults to Math.random. */
  rng?: () => number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Backoff for the Nth retry (1-based), exponential with ±BACKOFF_JITTER jitter. */
function backoffMs(retry: number, base: number, rng: () => number): number {
  const raw = base * Math.pow(2, retry - 1);
  const jitter = 1 + (rng() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(raw * jitter);
}

/** Perform a single refresh attempt. Never throws — failures are returned. */
async function refreshAgentOnce(
  agent: AgentConfig,
  fetchImpl: typeof fetch,
): Promise<AttemptResult> {
  try {
    const params = new URLSearchParams({
      client_id: agent.clientId,
      client_secret: agent.clientSecret,
      refresh_token: agent.refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetchImpl("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      // 4xx (except 429) is a hard failure — bad/revoked refresh token, retrying
      // won't help. 5xx and 429 are transient upstream conditions worth a retry.
      const retriable = res.status >= 500 || res.status === 429;
      recordTokenFailure(agent.name, res.status, retriable, `HTTP ${res.status} ${text}`);
      return { ok: false, retriable, reason: `HTTP ${res.status} ${text}` };
    }

    const data = (await res.json()) as TokenResponse;
    updateTokens(agent.name, data.access_token, data.refresh_token ?? agent.refreshToken, data.expires_in);
    log.info(`Token refresh OK for ${agent.name}: ${data.access_token.slice(0, 20)}...`);
    return { ok: true };
  } catch (err) {
    // Network/parse errors are transient — retry.
    const reason = err instanceof Error ? err.message : String(err);
    recordTokenFailure(agent.name, 0, true, reason);
    return {
      ok: false,
      retriable: true,
      reason,
    };
  }
}

async function refreshAgent(agent: AgentConfig, opts: RefreshOptions = {}): Promise<void> {
  // Skip agents whose OpenClaw workspace doesn't exist on this host
  if (!isAgentLocal(agent)) {
    log.info(`Skipping token refresh for ${agent.name}: not a local agent`);
    return;
  }

  log.info(`Refreshing token for ${agent.name}...`);

  // Skip refresh if no refresh token available (newly added agent)
  if (!agent.refreshToken || agent.refreshToken === "") {
    log.warn(`Skipping token refresh for ${agent.name}: no refresh token available yet`);
    return;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const rng = opts.rng ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const baseBackoffMs = opts.baseBackoffMs ?? BASE_BACKOFF_MS;

  let last: AttemptResult = { ok: false, retriable: true, reason: "no attempt made" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await refreshAgentOnce(agent, fetchImpl);
    if (last.ok) return;

    // A non-retriable failure (e.g. revoked token) won't heal on retry — stop.
    if (!last.retriable) {
      log.error(`Token refresh failed for ${agent.name} (non-retriable): ${last.reason}`);
      break;
    }

    if (attempt < maxAttempts) {
      const wait = backoffMs(attempt, baseBackoffMs, rng);
      log.warn(
        `Token refresh attempt ${attempt}/${maxAttempts} failed for ${agent.name}: ${last.reason}. Retrying in ${Math.round(wait / 1000)}s...`,
      );
      await sleep(wait);
    }
  }

  // Every attempt failed. Record the final failure and escalate.
  // Also record non-retriable failures that broke the loop early.
  recordTokenFailure(agent.name, 0, last.retriable, last.reason);
  log.error(
    `Token refresh exhausted all ${maxAttempts} attempts for ${agent.name}: ${last.ok ? "" : last.reason}`,
  );

  const agentCfg = getAgents().find((a) => a.name === agent.name);
  const deadline = agentCfg?.expiresAt
    ? ` — token expires at ${agentCfg.expiresAt}`
    : " — no expiry recorded (token may already be expired or was never refreshed)";

  notify({
    severity: "critical",
    source: "token-refresh",
    title: `Linear OAuth refresh failed for ${agent.name} after ${maxAttempts} attempts${deadline}`,
    detail: last.ok ? undefined : last.reason,
    agent: agent.name,
  });
}

async function refreshAll(opts: RefreshOptions = {}): Promise<void> {
  const agents = getAgents().filter(isPolledForLinear);
  log.info(`Refreshing ${agents.length} agent(s) (${getAgents().length - agents.length} skipped via status)...`);
  await Promise.all(agents.map((a) => refreshAgent(a, opts)));
}

export function startTokenRefresh(): void {
  // Initial refresh shortly after startup
  setTimeout(() => void refreshAll(), 5000);
  // Then every 20 hours
  setInterval(() => void refreshAll(), REFRESH_INTERVAL_MS);
  log.info(
    `Token refresh scheduled every ${REFRESH_INTERVAL_MS / 3600000}h for ${getAgents().length} agent(s)`,
  );
}

// Exported for tests.
export { refreshAgent, refreshAll, refreshAgentOnce, backoffMs, type TokenResponse };
