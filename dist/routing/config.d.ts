/**
 * Routing configuration types and validation.
 *
 * Defines the shape of the `routing` block in connector.yaml and provides
 * a validator to catch misconfigurations early at startup.
 */
/** Maps a Linear user to an OpenClaw agent. */
export interface AgentMapping {
    linearUserId: string;
    linearEmail?: string;
    agentId: string;
    sessionKey: string;
}
/** Fallback: maps a Linear team to a default OpenClaw agent. */
export interface TeamDefault {
    teamKey: string;
    agentId: string;
    sessionKey: string;
}
/** Top-level routing configuration block. */
export interface RoutingConfig {
    agents: AgentMapping[];
    teamDefaults: TeamDefault[];
}
/**
 * Validates and normalizes a raw routing config object.
 *
 * Returns a valid `RoutingConfig` or throws with a descriptive message
 * explaining what's wrong. Tolerates missing optional sections by
 * defaulting to empty arrays.
 *
 * @param raw - The parsed `routing` block from YAML config.
 * @returns A validated `RoutingConfig`.
 * @throws {Error} If required fields are missing or malformed.
 */
export declare function validateRoutingConfig(raw: unknown): RoutingConfig;
//# sourceMappingURL=config.d.ts.map