"use strict";
/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAgents = getAgents;
exports.buildAgentMap = buildAgentMap;
exports.getAccessToken = getAccessToken;
exports.getAgent = getAgent;
exports.getOpenclawAgentName = getOpenclawAgentName;
exports.updateTokens = updateTokens;
exports.upsertAgent = upsertAgent;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const logger_1 = require("./logger");
const log = (0, logger_1.componentLogger)((0, logger_1.createLogger)(), "agents");
const DEFAULT_AGENTS_PATH = node_path_1.default.resolve(process.cwd(), "agents.json");
function getAgentsPath() {
    return process.env.AGENTS_FILE ?? DEFAULT_AGENTS_PATH;
}
function load() {
    const filePath = getAgentsPath();
    if (!node_fs_1.default.existsSync(filePath))
        return [];
    try {
        const raw = node_fs_1.default.readFileSync(filePath, "utf8");
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
    node_fs_1.default.writeFileSync(getAgentsPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
}
// In-memory cache, kept in sync with disk
let _agents = load();
function getAgents() {
    return _agents;
}
/** Build linearUserId → agentName map for routing */
function buildAgentMap() {
    return Object.fromEntries(_agents.map((a) => [a.linearUserId, a.name]));
}
/** Get current access token for a named agent */
function getAccessToken(agentName) {
    return _agents.find((a) => a.name === agentName)?.accessToken;
}
/** Get agent config by name */
function getAgent(agentName) {
    return _agents.find((a) => a.name === agentName);
}
/** Get the OpenClaw agent name for routing */
function getOpenclawAgentName(agentName) {
    const agent = _agents.find((a) => a.name === agentName);
    return agent?.openclawAgent ?? agentName;
}
/** Update tokens for an agent and persist to disk */
function updateTokens(agentName, accessToken, refreshToken) {
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
    const secretsPath = agent.secretsPath ??
        node_path_1.default.join(node_os_1.default.homedir(), `.openclaw/workspace-${agent.openclawAgent ?? agent.name}/.secrets/linear.env`);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(secretsPath), { recursive: true });
        node_fs_1.default.writeFileSync(secretsPath, `LINEAR_API_KEY=${accessToken}\n`, "utf8");
        node_fs_1.default.chmodSync(secretsPath, 0o600);
        log.info(`Synced token to ${secretsPath}`);
    }
    catch (err) {
        log.error(`Failed to sync token to ${secretsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Add or update an agent from OAuth callback */
function upsertAgent(config) {
    const existing = _agents.find((a) => a.linearUserId === config.linearUserId);
    if (existing) {
        _agents = _agents.map((a) => a.linearUserId === config.linearUserId ? { ...a, ...config } : a);
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