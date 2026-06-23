/**
 * Agent configuration and credential management.
 * Stores per-agent OAuth credentials for Linear API access.
 * Modeled after the ILL webhook's agents.ts pattern.
 */
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
/** Start watching agents.json for external changes (e.g. manual edits). */
export declare function watchAgentsFile(): void;
export declare function reloadAgents(): void;
export declare function getAgents(): AgentConfig[];
/** Check whether an agent is managed by this connector instance.
 *  An explicit `secretsPath` means the agent's secrets live outside the
 *  default host workspace dir (e.g. a container mount) but this connector
 *  is still responsible for refreshing and syncing its tokens.
 *  Falls back to checking whether the host workspace dir exists.
 */
export declare function isAgentLocal(agent: AgentConfig): boolean;
/** Build linearUserId → agentName map for routing */
export declare function buildAgentMap(): Record<string, string>;
/** Get current access token for a named agent */
export declare function getAccessToken(agentName: string): string | undefined;
/** Get agent config by name */
export declare function getAgent(agentName: string): AgentConfig | undefined;
/**
 * Resolve an agent by its opaque broker proxy token. This is the authenticated
 * identity path: the token can only have come from the agent's own env, so the
 * proxy trusts it over the spoofable X-Openclaw-Agent header. Returns undefined
 * for an unrecognized token (legacy/direct-token callers fall through).
 */
export declare function getAgentByProxyToken(token: string): AgentConfig | undefined;
/** Get the OpenClaw agent name for routing */
export declare function getOpenclawAgentName(agentName: string): string;
/**
 * Resolve the Linear user ID for an OpenClaw agent ID (the value returned by
 * `getOpenclawAgentName`). Returns undefined for unrecognized agents.
 */
export declare function getLinearUserIdForAgent(openclawAgentId: string): string | undefined;
/** Update tokens for an agent and persist to disk */
export declare function updateTokens(agentName: string, accessToken: string, refreshToken: string): void;
/** Add or update an agent from OAuth callback */
export declare function upsertAgent(config: AgentConfig): {
    isNew: boolean;
};
//# sourceMappingURL=agents.d.ts.map