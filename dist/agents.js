/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, componentLogger } from "./logger.js";
const log = componentLogger(createLogger(), "agents");
const DEFAULT_AGENTS_PATH = path.resolve(process.cwd(), "agents.json");
function getAgentsPath() {
    return process.env.AGENTS_FILE ?? DEFAULT_AGENTS_PATH;
}
function load() {
    const filePath = getAgentsPath();
    if (!fs.existsSync(filePath))
        return [];
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        return data.agents ?? [];
    }
    catch {
        log.error(`Failed to load agents from ${filePath}`);
        return [];
    }
}
function save(agents) {
    const data = { agents };
    fs.writeFileSync(getAgentsPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
}
// In-memory cache, kept in sync with disk via file watcher
let _agents = load();
/** Start watching agents.json for external changes (e.g. manual edits). */
export function watchAgentsFile() {
    const filePath = getAgentsPath();
    let debounceTimer = null;
    try {
        const watcher = fs.watch(filePath, (eventType) => {
            if (eventType === "change") {
                // Debounce — editors often write in multiple steps
                if (debounceTimer)
                    clearTimeout(debounceTimer);
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
    }
    catch {
        // fs.watch not supported in this environment — non-fatal
    }
}
export function reloadAgents() {
    _agents = load();
}
export function getAgents() {
    return _agents;
}
/** Build linearUserId → agentName map for routing */
export function buildAgentMap() {
    return Object.fromEntries(_agents.map((a) => [a.linearUserId, a.name]));
}
/** Get current access token for a named agent */
export function getAccessToken(agentName) {
    return _agents.find((a) => a.name === agentName)?.accessToken;
}
/** Get agent config by name */
export function getAgent(agentName) {
    return _agents.find((a) => a.name === agentName);
}
/** Get the OpenClaw agent name for routing */
export function getOpenclawAgentName(agentName) {
    const agent = _agents.find((a) => a.name === agentName);
    return agent?.openclawAgent ?? agentName;
}
/** Update tokens for an agent and persist to disk */
export function updateTokens(agentName, accessToken, refreshToken) {
    _agents = _agents.map((a) => a.name === agentName ? { ...a, accessToken, refreshToken } : a);
    save(_agents);
    syncWorkspaceSecrets(agentName, accessToken);
    log.info(`Tokens updated for ${agentName}: ${accessToken.slice(0, 20)}...`);
}
/** Sync access token to the agent's workspace secrets file */
function syncWorkspaceSecrets(agentName, accessToken) {
    const agent = _agents.find((a) => a.name === agentName);
    if (!agent)
        return;
    const openclawConfigDir = process.env.OPENCLAW_CONFIG_DIR ?? path.join(os.homedir(), ".openclaw");
    const secretsPath = agent.secretsPath ??
        path.join(openclawConfigDir, `workspace-${agent.openclawAgent ?? agent.name}/.secrets/linear.env`);
    try {
        fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
        fs.writeFileSync(secretsPath, `LINEAR_OAUTH_TOKEN=${accessToken}\n`, "utf8");
        fs.chmodSync(secretsPath, 0o600);
        log.info(`Synced token to ${secretsPath}`);
    }
    catch (err) {
        log.error(`Failed to sync token to ${secretsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Add or update an agent from OAuth callback */
export function upsertAgent(config) {
    // Match by name first (for partial entries that don't have linearUserId yet)
    // then fall back to linearUserId for token refresh updates
    const existing = _agents.find((a) => a.name === config.name) ??
        _agents.find((a) => a.linearUserId === config.linearUserId);
    if (existing) {
        _agents = _agents.map((a) => a.name === config.name ? { ...a, ...config } : a);
        save(_agents);
        syncWorkspaceSecrets(config.name, config.accessToken);
        return { isNew: false };
    }
    _agents.push(config);
    save(_agents);
    syncWorkspaceSecrets(config.name, config.accessToken);
    return { isNew: true };
}
//# sourceMappingURL=agents.js.map