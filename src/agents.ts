/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */

import fs from "node:fs";
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
  /** OpenClaw agent name if different from Linear agent name */
  openclawAgent?: string;
  /** Host where this agent runs: "ishikawa" or "local" (Nakazawa) */
  host?: "ishikawa" | "local";
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

// In-memory cache, kept in sync with disk
let _agents: AgentConfig[] = load();

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
  log.info(`Tokens updated for ${agentName}: ${accessToken.slice(0, 20)}...`);
}

/** Add or update an agent from OAuth callback */
export function upsertAgent(config: AgentConfig): { isNew: boolean } {
  const existing = _agents.find((a) => a.linearUserId === config.linearUserId);
  if (existing) {
    _agents = _agents.map((a) =>
      a.linearUserId === config.linearUserId ? { ...a, ...config } : a,
    );
    save(_agents);
    return { isNew: false };
  }
  _agents.push(config);
  save(_agents);
  return { isNew: true };
}
