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
    /** Path to write LINEAR_API_KEY when tokens refresh */
    secretsPath?: string;
}
export declare function getAgents(): AgentConfig[];
/** Build linearUserId → agentName map for routing */
export declare function buildAgentMap(): Record<string, string>;
/** Get current access token for a named agent */
export declare function getAccessToken(agentName: string): string | undefined;
/** Get agent config by name */
export declare function getAgent(agentName: string): AgentConfig | undefined;
/** Get the OpenClaw agent name for routing */
export declare function getOpenclawAgentName(agentName: string): string;
/** Update tokens for an agent and persist to disk */
export declare function updateTokens(agentName: string, accessToken: string, refreshToken: string): void;
/** Add or update an agent from OAuth callback */
export declare function upsertAgent(config: AgentConfig): {
    isNew: boolean;
};
//# sourceMappingURL=agents.d.ts.map