/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, componentLogger } from "./logger";

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
  /** Path to write LINEAR_API_KEY when tokens refresh */
  secretsPath?: string;
}

interface AgentsFile {
  agents: AgentConfig[];
}

const DEFAULT_AGENTS_PATH = path.resolve(process.cwd(), "agents.json");

function getAgentsPath(): string {
  return process.env.AGENTS_FILE ?? DEFAULT_AGENTS_PATH;
}

function load(): AgentConfig[] {
  const filePath = getAgentsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as AgentsFile;
    return data.agents ?? [];
  } catch {
    log.error(`Failed to load agents from ${filePath}`);
    return [];
  }
}

function save(agents: AgentConfig[]): void {
  const data: AgentsFile = { agents };
  fs.writeFileSync(getAgentsPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
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

export function getAgents(): AgentConfig[] {
  return _agents;
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

/** Get the OpenClaw agent name for routing */
export function getOpenclawAgentName(agentName: string): string {
  const agent = _agents.find((a) => a.name === agentName);
  return agent?.openclawAgent ?? agentName;
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

  const secretsPath = agent.secretsPath ??
    path.join(os.homedir(), `.openclaw/workspace-${agent.openclawAgent ?? agent.name}/.secrets/linear.env`);

  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, `LINEAR_API_KEY=${accessToken}\n`, "utf8");
    fs.chmodSync(secretsPath, 0o600);
    log.info(`Synced token to ${secretsPath}`);
  } catch (err) {
    log.error(`Failed to sync token to ${secretsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Add or update an agent from OAuth callback */
export function upsertAgent(config: AgentConfig): { isNew: boolean } {
  const existing = _agents.find((a) => a.linearUserId === config.linearUserId);
  if (existing) {
    _agents = _agents.map((a) =>
      a.linearUserId === config.linearUserId ? { ...a, ...config } : a,
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
