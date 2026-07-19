/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { resolveStatePath } from "./state-dir.js";
import {
  getAgentWorkspaceDir,
  getLinearSecretPath,
} from "fancy-openclaw-linear-skill-cli";
import { createLogger, componentLogger } from "./logger.js";
import { recordSuccess, recordFailure } from "./config-health.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(), "agents");

export interface AgentConfig {
  name: string;
  /** Human-readable display label for the admin console (AI-2140). */
  displayName?: string;
  linearUserId: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  openclawAgent?: string;
  host?: "ishikawa" | "local";
  /** Path to write LINEAR_OAUTH_TOKEN when tokens refresh */
  secretsPath?: string;
  /**
   * Opaque per-agent broker credential. When set, this — NOT the real Linear
   * OAuth token — is what gets written into the agent's environment. The agent
   * presents it as its Authorization; the proxy resolves the agent from it and
   * swaps in the vaulted `accessToken` for the upstream call. A proxy token is
   * useless against api.linear.app directly, so an agent cannot bypass the gate
   * by hitting Linear without the proxy. The real token stays only in this file.
   */
  proxyToken?: string;
  /** Proxy GraphQL URL written into the agent env alongside the proxy token. */
  proxyUrl?: string;
  /** Per-agent OpenClaw hooks URL override (e.g. for agents in a different fleet/gateway) */
  hooksUrl?: string;
  /** Per-agent OpenClaw hooks token override */
  hooksToken?: string;
  /**
   * AI-2420: Per-agent OpenClaw Gateway OpenAI-compatible API URL (e.g.
   * `http://10.10.0.105:18820/v1/chat/completions`). When set together with
   * `gatewayToken`, delivery routes through the gateway `/v1` API using the
   * trusted `x-openclaw-session-key` header for per-ticket session routing,
   * instead of the hook payload `sessionKey` field — which lets the fleet flip
   * `hooks.allowRequestSessionKey` to `false` (AI-2111/AI-2112).
   *
   * The fleet is **multi-gateway**: each agent runs its own gateway, so this
   * MUST be the agent's own URL. Never populate it from a global env URL — that
   * points at a single gateway and strands every other agent as "Unknown agent"
   * (see the trap note in `src/webhook/index.ts`).
   *
   * AI-2515 — **writing this field (with `gatewayToken`) is a live cutover for
   * this agent, not inert prep.** This file hot-reloads and delivery selects the
   * gateway path on presence of the two fields alone. No enable flag gates it;
   * `REQUIRE_GATEWAY_DELIVERY` does not gate it either — despite the name, that
   * flag only controls whether an *unpopulated* agent refuses. Every delivery
   * path for this agent moves at once (dispatch, wake-ups, managing-wake,
   * stuck-delegate-detector, stale-session re-poke). Selection is per-agent, so
   * populate one agent at a time to canary. See `src/delivery/deliver.ts`.
   */
  gatewayUrl?: string;
  /** AI-2420: Per-agent operator token for the gateway `/v1` API (sent as `Authorization: Bearer <token>`).
   *  AI-2515: second half of the live switch — see the cutover note on `gatewayUrl`. */
  gatewayToken?: string;
  /** Maximum concurrent sessions this agent can handle. Overrides the global default. */
  maxConcurrent?: number;
  /**
   * ISO-8601 timestamp of when the current access token expires.
   * Computed from `expires_in` on the OAuth refresh response and persisted
   * through updateTokens so the /health block and console token panel can
   * surface real deadlines, not assumed ~24h. (AI-1908 AC4)
   */
  expiresAt?: string;
  /** ISO-8601 timestamp of the last successful token refresh. */
  lastRefreshOkAt?: string;
  /** Details of the last failed token refresh attempt, if any. */
  lastFailure?: TokenFailure;
  /**
   * Linear connector registration status. Controls whether this agent's
   * pollers and token refresher contact Linear on its behalf.
   *
   * - `"active"` (default when absent): polled normally.
   * - `"off-linear"`: deliberately decommissioned from Linear; all pollers,
   *   token refresh, and credential checks skip this agent.
   * - `"never-onboarded"`: never set up (e.g. blocked on host-side OAuth);
   *   same skip behaviour, but semantically distinct.
   *
   * The registry is the single source of truth for decommission state.
   * See AI-2346.
   */
  status?: "active" | "off-linear" | "never-onboarded";
  /**
   * Explicit opt-in for the legacy direct-token write path.
   *
   * When set to `true`, syncWorkspaceSecrets will write the raw upstream
   * `accessToken` into the agent's linear.env when no proxyToken is present.
   * This is the pre-AI-2304 behavior and should only be used for agents that
   * cannot use the broker proxy model.
   *
   * Default (absent/false): syncWorkspaceSecrets writes NOTHING when there is
   * no proxyToken — preserving any existing file and logging a loud error.
   *
   * The proxy-fleet-sweep.py asserts this flag has zero consumers.
   */
  allowDirectToken?: boolean;
}

export interface TokenFailure {
  at: string;
  status: number;
  retriable: boolean;
  reason: string;
}

interface AgentsFile {
  agents: AgentConfig[];
}

interface EncryptedAgentsFile {
  version: 2;
  alg: "AES-256-GCM";
  iv: string;
  tag: string;
  ct: string;
}

// AI-2263: fall back to the state dir (OPENCLAW_LINEAR_CONNECTOR_STATE) when
// set, else cwd. AGENTS_FILE (seeded from the same state dir at bootstrap) still
// wins in getAgentsPath(); this keeps the standalone default consistent.
const DEFAULT_AGENTS_PATH = resolveStatePath("agents.json");
const ENCRYPTED_AGENTS_VERSION = 2;
const ENCRYPTED_AGENTS_ALG = "AES-256-GCM";

function getAgentsPath(): string {
  return process.env.AGENTS_FILE ?? DEFAULT_AGENTS_PATH;
}

function isEncryptedAgentsFile(data: unknown): data is EncryptedAgentsFile {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<EncryptedAgentsFile>;
  return candidate.version === ENCRYPTED_AGENTS_VERSION &&
    candidate.alg === ENCRYPTED_AGENTS_ALG &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.ct === "string";
}

function resolveEncryptionKey(): Buffer | undefined {
  const keyValue = process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY ??
    (process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE
      ? fs.readFileSync(process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE, "utf8").trim()
      : undefined);

  if (!keyValue) return undefined;

  const key = Buffer.from(keyValue, "base64");
  if (key.length !== 32) {
    throw new Error(
      "LINEAR_CONNECTOR_ENCRYPTION_KEY must be base64-encoded 32 bytes for AES-256-GCM",
    );
  }
  return key;
}

function encryptAgentsFile(data: AgentsFile, key: Buffer): EncryptedAgentsFile {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: ENCRYPTED_AGENTS_VERSION,
    alg: ENCRYPTED_AGENTS_ALG,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  };
}

function decryptAgentsFile(data: EncryptedAgentsFile, key: Buffer): AgentsFile {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(data.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(data.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(data.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as AgentsFile;
}

function parseAgentsFile(raw: string, filePath: string): AgentsFile {
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedAgentsFile(parsed)) {
    return parsed as AgentsFile;
  }

  const key = resolveEncryptionKey();
  if (!key) {
    throw new Error(
      `Encrypted agents file present at ${filePath} but no LINEAR_CONNECTOR_ENCRYPTION_KEY or LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE is configured`,
    );
  }
  return decryptAgentsFile(parsed, key);
}

function load(): AgentConfig[] {
  const filePath = getAgentsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = parseAgentsFile(raw, filePath);
    recordSuccess("agents");
    return data.agents ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to load agents from ${filePath}: ${message}`);
    recordFailure("agents", message);
    throw err;
  }
}

function save(agents: AgentConfig[]): void {
  const data: AgentsFile = { agents };
  const key = resolveEncryptionKey();
  const serialized = key
    ? JSON.stringify(encryptAgentsFile(data, key), null, 2) + "\n"
    : JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(getAgentsPath(), serialized, "utf8");
  fs.chmodSync(getAgentsPath(), 0o600);
}

// In-memory cache, kept in sync with disk via file watcher
let _agents: AgentConfig[] = load();

// Listeners fired after every SUCCESSFUL hot-reload (not the boot-time load).
// Used by the registry⇄policy cross-check to re-assert on registry edits.
type AgentsReloadedListener = () => void;
let _reloadListeners: AgentsReloadedListener[] = [];

/** Subscribe to successful agents.json hot-reloads. Returns an unsubscribe fn. */
export function onAgentsReloaded(listener: AgentsReloadedListener): () => void {
  _reloadListeners.push(listener);
  return () => {
    _reloadListeners = _reloadListeners.filter((l) => l !== listener);
  };
}

/**
 * Reload the registry from disk, keeping the previous in-memory registry on
 * failure. A malformed hot edit must never take the running connector down
 * (audit #15: load() rethrows inside the watch debounce timer = uncaught
 * exception = process crash; boot-time load stays strict on purpose).
 * Exported for tests.
 */
export function safeReloadAgents(): boolean {
  try {
    const reloaded = load();
    const added = reloaded.filter((r) => !_agents.some((a) => a.name === r.name));
    const removed = _agents.filter((a) => !reloaded.some((r) => r.name === a.name));
    _agents = reloaded;
    log.info(`agents.json reloaded: ${_agents.length} agent(s)` +
      (added.length ? ` — added: ${added.map((a) => a.name).join(", ")}` : "") +
      (removed.length ? ` — removed: ${removed.map((a) => a.name).join(", ")}` : ""));
    for (const listener of _reloadListeners) {
      try {
        listener();
      } catch (err) {
        log.error(`agents-reloaded listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`agents.json hot-reload failed — keeping previous registry (${_agents.length} agent(s)): ${message}`);
    notify({
      severity: "critical",
      source: "config-health",
      title: "agents.json hot-reload failed — running on last-good registry until the file is fixed",
      detail: message,
      dedupKey: "agents|reload-failed",
    });
    return false;
  }
}

/** Start watching agents.json for external changes (e.g. manual edits). */
export function watchAgentsFile(): void {
  const filePath = getAgentsPath();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === "change") {
        // Debounce — editors often write in multiple steps
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          safeReloadAgents();
        }, 250);
      }
    });
    watcher.on("error", () => {
      // File doesn't exist yet or was deleted — that's fine, will retry on next access
      log.warn(`Could not watch ${filePath} for changes`);
    });
  } catch {
    // fs.watch not supported in this environment — non-fatal
  }
}

export function reloadAgents(): void {
  _agents = load();
}

export function getAgents(): AgentConfig[] {
  return _agents;
}

/** Check whether an agent is managed by this connector instance.
 *  An explicit `secretsPath` means the agent's secrets live outside the
 *  default host workspace dir (e.g. a container mount) but this connector
 *  is still responsible for refreshing and syncing its tokens.
 *  Falls back to checking whether the host workspace dir exists.
 */
export function isAgentLocal(agent: AgentConfig): boolean {
  if (agent.secretsPath) return true;
  const wsName = agent.openclawAgent ?? agent.name;
  return fs.existsSync(getAgentWorkspaceDir(wsName));
}

/** Build linearUserId → agentName map for routing */
export function buildAgentMap(): Record<string, string> {
  return Object.fromEntries(_agents.map((a) => [a.linearUserId, a.name]));
}

/** Get current access token for a named agent */
export function getAccessToken(agentName: string): string | undefined {
  return _agents.find((a) => a.name === agentName)?.accessToken;
}

/** Get agent config by name */
export function getAgent(agentName: string): AgentConfig | undefined {
  return _agents.find((a) => a.name === agentName);
}

/**
 * Resolve an agent by its opaque broker proxy token. This is the authenticated
 * identity path: the token can only have come from the agent's own env, so the
 * proxy trusts it over the spoofable X-Openclaw-Agent header. Returns undefined
 * for an unrecognized token (legacy/direct-token callers fall through).
 */
export function getAgentByProxyToken(token: string): AgentConfig | undefined {
  if (!token) return undefined;
  return _agents.find((a) => a.proxyToken && a.proxyToken === token);
}

/** Get the OpenClaw agent name for routing */
/**
 * Whether this agent should be polled for Linear activity (managing poller,
 * stuck-delegate detector, token refresh, etc.).
 *
 * Agents whose `status` is undefined or `"active"` are polled. Agents marked
 * `"off-linear"` or `"never-onboarded"` are skipped — no Linear API calls are
 * made on their behalf, and no 401 noise is produced.
 *
 * This is the single gate — every poller and refresher should use this helper
 * rather than scattering `status === "active"` string checks across modules.
 * See AI-2346.
 */
export function isPolledForLinear(agent: AgentConfig): boolean {
  return (agent.status ?? "active") === "active";
}

/**
 * Reconcile an agent's registration status against whether it actually holds a
 * credential, and return the entry the registry may store (AI-2444).
 *
 * `active` with no refresh token is not a state the registry is allowed to
 * hold. It is a fourth, unnamed state that reads as *intent* — "should be
 * enrolled but isn't" — which nothing forces anyone to resolve. It generated
 * nine credential tickets: the hourly proxy probe finds an agent that is
 * supposed to be on Linear, correctly diagnoses that it isn't, files a ticket,
 * and the ambiguity survives to the next pass. The registry vocabulary already
 * has a name for every legitimate case, so this collapses onto it:
 *
 * - no credential      -> `never-onboarded`: a pending intent, not yet set up
 * - credential present -> `active`, promoted from `never-onboarded` on onboard
 * - `off-linear`       -> a decision; never reconciled in either direction
 *
 * `status` absent means `active` (see `isPolledForLinear`), so an entry written
 * with no status and no token is that same ambiguous state and coerces too —
 * which is exactly how both onboard paths create their pre-OAuth entries.
 *
 * Coercion is loud rather than rejecting: the onboard flows legitimately write
 * a token-less entry before OAuth completes, and landing it as
 * `never-onboarded` is the intended destination for it, not an error.
 *
 * Naming the state is what earns it the watchdog skip. Do not instead widen
 * `isPolledForLinear` to skip any credential-less agent: that would fold
 * active-with-no-token into `/health`'s `offLinearAgentNames`, and the probe
 * would skip it as "revoked on purpose" *before* reaching the missing-token
 * warning — silently deleting the signal AI-2231 added to surface it.
 */
function reconcileStatusWithCredential(agent: AgentConfig): AgentConfig {
  // A deliberate decommission is a decision, not a pending intent. A credential
  // arriving or going missing must never silently overturn it.
  if (agent.status === "off-linear") return agent;

  const hasCredential = Boolean(agent.refreshToken);
  const effectiveStatus = agent.status ?? "active";

  if (effectiveStatus === "active" && !hasCredential) {
    log.warn(
      `Roster agent "${agent.name}" is ${agent.status ? "set" : "defaulting"} to ` +
        `status "active" with no stored refresh token — coercing to ` +
        `"never-onboarded". An active agent with no credential pages the ` +
        `hourly credential-liveness probe forever and resolves to nobody. ` +
        `Complete OAuth to promote it back to "active", or mark it ` +
        `"off-linear" if it is decommissioned. (AI-2444)`,
    );
    return { ...agent, status: "never-onboarded" };
  }

  // A credential means onboarding finished, so "never set up yet" is no longer
  // true of this agent regardless of who wrote it. Promote (AC2).
  if (effectiveStatus === "never-onboarded" && hasCredential) {
    log.info(
      `Roster agent "${agent.name}" onboarded: refresh token stored — ` +
        `promoting "never-onboarded" -> "active". (AI-2444)`,
    );
    return { ...agent, status: "active" };
  }

  return agent;
}

export function getOpenclawAgentName(agentName: string): string {
  const agent = _agents.find((a) => a.name === agentName);
  return agent?.openclawAgent ?? agentName;
}

/**
 * Resolve the Linear user ID for an OpenClaw agent ID (the value returned by
 * `getOpenclawAgentName`). Returns undefined for unrecognized agents.
 */
export function getLinearUserIdForAgent(openclawAgentId: string): string | undefined {
  return _agents.find((a) => (a.openclawAgent ?? a.name) === openclawAgentId)?.linearUserId;
}

/** Update tokens for an agent and persist to disk */
export interface TokenStatus {
  agentId: string;
  lastRefreshOkAt: string | null;
  expiresAt: string | null;
  lastFailure: {
    at: string;
    status: number;
    retriable: boolean;
    reason: string;
  } | null;
  state: "healthy" | "stale" | "expired" | "failing" | "unconfigured";
}

export function updateTokens(
  agentName: string,
  accessToken: string,
  refreshToken: string,
  expiresIn?: number,
): void {
  const now = new Date().toISOString();
  const expiresAt = expiresIn != null
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : undefined;

  _agents = _agents.map((a) =>
    a.name === agentName
      ? {
          ...a,
          accessToken,
          refreshToken,
          ...(expiresAt ? { expiresAt } : {}),
          lastRefreshOkAt: now,
          // Clear any previous failure on success
          lastFailure: undefined,
        }
      : a,
  );
  save(_agents);
  syncWorkspaceSecrets(agentName, accessToken);
  log.info(`Tokens updated for ${agentName}: ${accessToken.slice(0, 20)}...`);
}

export function recordTokenFailure(
  agentName: string,
  status: number,
  retriable: boolean,
  reason: string,
): void {
  const now = new Date().toISOString();
  _agents = _agents.map((a) =>
    a.name === agentName
      ? { ...a, lastFailure: { at: now, status, retriable, reason } }
      : a,
  );
  save(_agents);
}

export function getTokenStatus(agentName: string): TokenStatus | undefined {
  const agent = _agents.find((a) => a.name === agentName);
  if (!agent) return undefined;

  const now = Date.now();
  const expiresAt = agent.expiresAt ? new Date(agent.expiresAt).getTime() : null;

  let state: TokenStatus["state"];
  if (agent.lastFailure && !agent.lastRefreshOkAt) {
    // Never successfully refreshed — always failing
    state = "failing";
  } else if (expiresAt != null && now >= expiresAt) {
    state = "expired";
  } else if (agent.lastFailure) {
    // Has a failure but also has a recent successful refresh
    state = expiresAt != null && now >= expiresAt - 2 * 60 * 60 * 1000
      ? "stale"
      : "healthy";
  } else if (agent.lastRefreshOkAt == null && expiresAt == null) {
    // Never onboarded: no successful refresh, no expiry, no failure recorded.
    // Previously fell through to "healthy", masking dead/never-configured creds
    // that 401 in practice (AI-2231). A failed never-refreshed cred is caught
    // by the "failing" branch above; this catches the silent never-configured case.
    state = "unconfigured";
  } else {
    state = "healthy";
  }

  return {
    agentId: agentName,
    lastRefreshOkAt: agent.lastRefreshOkAt ?? null,
    expiresAt: agent.expiresAt ?? null,
    lastFailure: agent.lastFailure ?? null,
    state,
  };
}

export function getAllTokenStatuses(): TokenStatus[] {
  return _agents.map((a) => getTokenStatus(a.name)!).filter(Boolean);
}

/**
 * Symlink target of `p`, or null if `p` is absent or a regular file.
 * lstat, not stat: stat resolves the link and would report the target's type.
 */
function readSymlinkTarget(p: string): string | null {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch {
    // ENOENT (nothing there yet) is the normal first-write case.
    return null;
  }
}

/** Sync access token to the agent's workspace secrets file */
function syncWorkspaceSecrets(agentName: string, accessToken: string): void {
  const agent = _agents.find((a) => a.name === agentName);
  if (!agent) return;

  const wsName = agent.openclawAgent ?? agent.name;
  let secretsPath: string;
  if (agent.secretsPath) {
    secretsPath = agent.secretsPath;
  } else if (process.env.SECRETS_DIR) {
    secretsPath = path.join(process.env.SECRETS_DIR, wsName, "linear.env");
  } else {
    // Canonical path comes from the shared helper so the writer here
    // and the reader in the Linear skill CLI can never disagree.
    secretsPath = getLinearSecretPath(wsName);
  }

  // Broker model: once an agent is provisioned with a proxy token, its env must
  // NEVER receive the real Linear OAuth token. Write the opaque proxy token plus
  // the proxy URL so the CLI routes through the connector (which swaps in the
  // vaulted real token). The real accessToken update lands only in agents.json
  // via save(). This also runs on every token refresh, so we re-emit the proxy
  // URL line here to keep it from being clobbered.
  //
  // Agents with no proxyToken AND no explicit `allowDirectToken` opt-in get
  // NOTHING written — the implicit raw-token else branch is dead (AI-2304).
  // With minting at creation (AI-2308), every properly-onboarded agent has a
  // proxyToken from the moment its record exists, so this early-return is a
  // no-op under normal conditions. It exists as a containment hard-stop.
  if (!agent.proxyToken && !agent.allowDirectToken) {
    log.error(
      `Refusing to write accessToken to ${secretsPath} for "${agentName}" — ` +
        `no proxyToken and no allowDirectToken opt-in. This is a provisioning ` +
        `bug; the agent must have a proxyToken minted at creation (AI-2308). ` +
        `Leaving any existing credential file untouched.`,
    );
    return;
  }

  let contents: string;
  if (agent.proxyToken) {
    const lines = [`LINEAR_OAUTH_TOKEN=${agent.proxyToken}`];
    if (agent.proxyUrl) lines.push(`LINEAR_PROXY_URL=${agent.proxyUrl}`);
    contents = lines.join("\n") + "\n";
  } else {
    // The only way to reach here is allowDirectToken: true (the guard above
    // prevents the implicit path). This is the legacy direct-token write
    // (mode 600, atomic — reuses the AI-2289/AI-2288 writer below).
    contents = `LINEAR_OAUTH_TOKEN=${accessToken}\n`;
  }

  // Backstop: an empty token is never a credential, so publishing `LINEAR_OAUTH_TOKEN=`
  // can only ever destroy access — it cannot grant it. Callers reach here with a blank
  // token by merging a partial record over a good one (admin.ts did exactly that:
  // AI-2309), and the write would then land an empty env over a live linear.env and
  // brick the agent. Whatever is already on disk is strictly better than nothing, so
  // fail closed and leave it alone. This guards *every* caller, not just the one we
  // know about — a fixed caller is one fix, a writer that refuses to self-harm is a
  // property.
  const tokenToWrite = agent.proxyToken || accessToken;
  if (!tokenToWrite?.trim()) {
    log.error(
      `Refusing to write an empty credential to ${secretsPath} for "${agentName}" — ` +
        `no proxyToken and no accessToken. This is a provisioning bug in the caller; ` +
        `leaving any existing credential file untouched.`,
    );
    return;
  }

  // Publish atomically. This runs on every token refresh while readers (the */30
  // liveness cron among them) are reading the same file, so a truncate-then-write
  // in place would hand them an empty or half-written env — no `lpx_` line, a
  // silent credential downgrade, and a 401 that looks like a revoked token.
  // Write a temp file in the SAME directory (rename(2) is only atomic within one
  // filesystem), fix its mode to 0600 on the fd before the name is resolvable, then
  // rename it over the target. A reader then sees either the whole old file or the
  // whole new one — and never a world-readable one. (AI-2288)
  const dir = path.dirname(secretsPath);
  const tmpPath = path.join(dir, `.${path.basename(secretsPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let fd: number | undefined;
    try {
      // "wx" fails rather than clobbers if the temp name somehow exists.
      fd = fs.openSync(tmpPath, "wx", 0o600);
      fs.writeFileSync(fd, contents, "utf8");
      // Explicit fchmod: the open(2) mode argument is masked by umask, so it alone
      // cannot guarantee 0600.
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    // A symlink at a canonical `.secrets/linear.env` is never legitimate, and it is
    // actively dangerous: writeFileSync follows symlinks, so the old in-place write
    // published this agent's token *through* the link into whatever it pointed at.
    // That fired in production on 2026-07-14 — an off-by-one relative link resolved
    // grover's linear.env onto main's, and grover's proxy token was written into
    // main's credential file (AI-2289).
    //
    // The rename below inherently reclaims the path (rename(2) replaces the link
    // itself, never its target), so the clobber cannot recur. But a silent reclaim
    // would erase the only evidence that something is creating these links, so shout
    // first. Reclaim rather than bail: refusing to write would leave the agent
    // holding the bad symlink and locked out of Linear — the very outage being fixed.
    const linkTarget = readSymlinkTarget(secretsPath);
    if (linkTarget !== null) {
      const resolved = path.resolve(dir, linkTarget);
      log.error(
        `SECURITY: ${secretsPath} was a symlink -> ${linkTarget} (resolves to ${resolved}). ` +
          `Credential paths must be regular files; reclaiming it as one. ` +
          `Any token previously synced for "${agentName}" may have been written through this link into ${resolved}.`,
      );
      notify({
        severity: "critical",
        source: "agents",
        title: `Symlinked credential path reclaimed for "${agentName}"`,
        detail:
          `${secretsPath} was a symlink to ${resolved}. The pre-rename writer followed it, so ${resolved} ` +
          `may hold "${agentName}"'s token. Rotate if so, and find what created the link (AI-2297).`,
        dedupKey: `agents|symlinked-secrets|${agentName}`,
      });
    }

    fs.renameSync(tmpPath, secretsPath);
    log.info(`Synced ${agent.proxyToken ? "proxy token" : "token"} to ${secretsPath}`);
  } catch (err) {
    // Fail closed: leave whatever credentials were already in place untouched and
    // valid, rather than a partial file that no reader can use.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up.
    }
    log.error(`Failed to sync token to ${secretsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Add or update an agent from OAuth callback */
/**
 * Update only the editable metadata fields of an agent configuration.
 * Intentionally does NOT touch: accessToken, refreshToken, clientId,
 * clientSecret, proxyToken, proxyUrl, secretsPath, expiresAt,
 * lastRefreshOkAt, lastFailure.
 *
 * Returns null when no agent with that name exists.
 */
export function updateAgentMetadata(
  agentName: string,
  meta: {
    openclawAgent?: string;
    host?: "ishikawa" | "local";
    linearUserId?: string;
    displayName?: string;
    status?: "active" | "off-linear" | "never-onboarded";
  },
): AgentConfig | null {
  const idx = _agents.findIndex((a) => a.name === agentName);
  if (idx === -1) return null;

  const current = _agents[idx];
  const updated: AgentConfig = reconcileStatusWithCredential({
    ...current,
    ...(meta.openclawAgent !== undefined ? { openclawAgent: meta.openclawAgent } : {}),
    ...(meta.host !== undefined ? { host: meta.host } : {}),
    ...(meta.linearUserId !== undefined ? { linearUserId: meta.linearUserId } : {}),
    ...(meta.displayName !== undefined ? { displayName: meta.displayName } : {}),
    ...(meta.status !== undefined ? { status: meta.status } : {}),
  });

  _agents[idx] = updated;
  save(_agents);
  return updated;
}

/**
 * Mint a new opaque proxy token (`lpx_`-prefixed) for an agent.
 * The proxy token is what the agent presents as its Authorization header;
 * the connector resolves it to the agent and swaps in the vaulted real token
 * for the upstream Linear API call. It is useless against api.linear.app directly.
 */
export function mintProxyToken(): string {
  return "lpx_" + crypto.randomBytes(24).toString("hex");
}

/**
 * Derive the default proxy URL for the connector.
 * Reads `LINEAR_CONNECTOR_PROXY_URL` env var first, then falls back to
 * `http://localhost:{PORT}/proxy/graphql` where PORT defaults to 3100.
 * Returns `undefined` only when no reasonable default can be constructed.
 */
function getDefaultProxyUrl(): string | undefined {
  if (process.env.LINEAR_CONNECTOR_PROXY_URL) {
    return process.env.LINEAR_CONNECTOR_PROXY_URL;
  }
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3100;
  if (Number.isFinite(port)) {
    return `http://localhost:${port}/proxy/graphql`;
  }
  return undefined;
}

export function upsertAgent(config: AgentConfig): { isNew: boolean } {
  // Match by name first (for partial entries that don't have linearUserId yet)
  // then fall back to linearUserId for token refresh updates. The fallback must
  // not fire on a falsy id: partial entries are written with linearUserId ""
  // (admin.ts, onboard-wizard.ts), so an unguarded lookup matches an unrelated
  // partial and would clobber it on the next onboard.
  const existing = _agents.find((a) => a.name === config.name) ??
    (config.linearUserId
      ? _agents.find((a) => a.linearUserId === config.linearUserId)
      : undefined);
  if (existing) {
    // Key the write off the resolved entry, not a re-derived name predicate:
    // an entry found via the linearUserId fallback has a different name, so
    // matching on name again would write nothing and still report isNew: false.
    //
    // Reconcile the merged entry, not the incoming patch: a partial upsert that
    // omits refreshToken must not read as "no credential" when the stored entry
    // has one.
    _agents = _agents.map((a) => {
      if (a !== existing) return a;
      const merged = reconcileStatusWithCredential({ ...a, ...config });
      // An agent onboarded partially (no upstream token yet) has no proxy token
      // to mint against; when its real token finally arrives on this update
      // path, mint then — otherwise syncWorkspaceSecrets falls back to
      // publishing the raw upstream token, the exact leak AI-2308 closes.
      if (needsProxyToken(merged)) {
        merged.proxyToken = mintProxyToken();
        if (!merged.proxyUrl) merged.proxyUrl = getDefaultProxyUrl();
      }
      return merged;
    });
    save(_agents);
    syncWorkspaceSecrets(config.name, config.accessToken);
    return { isNew: false };
  }
  // Mint a proxy token for a new agent before it hits disk so that
  // syncWorkspaceSecrets always has a `lpx_` credential to write — never
  // the raw upstream `lin_oauth_` token (AI-2308). Already-provisioned
  // agents with an existing proxyToken are untouched.
  if (needsProxyToken(config)) {
    config.proxyToken = mintProxyToken();
    if (!config.proxyUrl) config.proxyUrl = getDefaultProxyUrl();
  }

  _agents.push(reconcileStatusWithCredential(config));
  save(_agents);
  syncWorkspaceSecrets(config.name, config.accessToken);
  return { isNew: true };
}

/**
 * Mint only when there is a real upstream token to broker.
 *
 * A proxy token is a stand-in for a vaulted `accessToken`; minting one for an
 * agent that has no upstream credential yet would publish a linear.env that
 * reads as provisioned but brokers nothing — the "configured-but-broken"
 * credential file AI-2309 exists to prevent. With no token on either side,
 * syncWorkspaceSecrets' empty-credential guard declines to write at all.
 */
function needsProxyToken(config: AgentConfig): boolean {
  return !config.proxyToken && Boolean(config.accessToken?.trim());
}
