/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  getAgentWorkspaceDir,
  getLinearSecretPath,
} from "fancy-openclaw-linear-skill-cli";
import { createLogger, componentLogger } from "./logger.js";
import { recordSuccess, recordFailure } from "./config-health.js";

const log = componentLogger(createLogger(), "agents");

export interface AgentConfig {
  name: string;
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
  /** Maximum concurrent sessions this agent can handle. Overrides the global default. */
  maxConcurrent?: number;
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

const DEFAULT_AGENTS_PATH = path.resolve(process.cwd(), "agents.json");
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
}

// In-memory cache, kept in sync with disk via file watcher
let _agents: AgentConfig[] = load();

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
          const reloaded = load();
          const added = reloaded.filter((r) => !_agents.some((a) => a.name === r.name));
          const removed = _agents.filter((a) => !reloaded.some((r) => r.name === a.name));
          _agents = reloaded;
          log.info(`agents.json reloaded: ${_agents.length} agent(s)` +
            (added.length ? ` — added: ${added.map((a) => a.name).join(", ")}` : "") +
            (removed.length ? ` — removed: ${removed.map((a) => a.name).join(", ")}` : ""));
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
export function updateTokens(
  agentName: string,
  accessToken: string,
  refreshToken: string,
): void {
  _agents = _agents.map((a) =>
    a.name === agentName ? { ...a, accessToken, refreshToken } : a,
  );
  save(_agents);
  syncWorkspaceSecrets(agentName, accessToken);
  log.info(`Tokens updated for ${agentName}: ${accessToken.slice(0, 20)}...`);
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
  // URL line here to keep it from being clobbered. Agents with no proxyToken yet
  // keep the legacy direct-token behavior for an incremental migration.
  let contents: string;
  if (agent.proxyToken) {
    const lines = [`LINEAR_OAUTH_TOKEN=${agent.proxyToken}`];
    if (agent.proxyUrl) lines.push(`LINEAR_PROXY_URL=${agent.proxyUrl}`);
    contents = lines.join("\n") + "\n";
  } else {
    contents = `LINEAR_OAUTH_TOKEN=${accessToken}\n`;
  }

  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, contents, "utf8");
    fs.chmodSync(secretsPath, 0o600);
    log.info(`Synced ${agent.proxyToken ? "proxy token" : "token"} to ${secretsPath}`);
  } catch (err) {
    log.error(`Failed to sync token to ${secretsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Add or update an agent from OAuth callback */
export function upsertAgent(config: AgentConfig): { isNew: boolean } {
  // Match by name first (for partial entries that don't have linearUserId yet)
  // then fall back to linearUserId for token refresh updates
  const existing = _agents.find((a) => a.name === config.name) ??
    _agents.find((a) => a.linearUserId === config.linearUserId);
  if (existing) {
    _agents = _agents.map((a) =>
      a.name === config.name ? { ...a, ...config } : a
    );
    save(_agents);
    syncWorkspaceSecrets(config.name, config.accessToken);
    return { isNew: false };
  }
  _agents.push(config);
  save(_agents);
  syncWorkspaceSecrets(config.name, config.accessToken);
  return { isNew: true };
}
