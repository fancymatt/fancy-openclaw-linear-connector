"use strict";
/**
 * Routing configuration types and validation.
 *
 * Defines the shape of the `routing` block in connector.yaml and provides
 * a validator to catch misconfigurations early at startup.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRoutingConfig = validateRoutingConfig;
// ─── Validation ───────────────────────────────────────────────────────────────
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
function validateRoutingConfig(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("routing config must be a non-null object");
    }
    const obj = raw;
    const agents = validateAgentMappings(obj.agents);
    const teamDefaults = validateTeamDefaults(obj.teamDefaults);
    return { agents, teamDefaults };
}
function validateAgentMappings(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        throw new Error("routing.agents must be an array");
    }
    return raw.map((entry, i) => {
        if (!entry || typeof entry !== "object") {
            throw new Error(`routing.agents[${i}] must be an object`);
        }
        const e = entry;
        if (typeof e.linearUserId !== "string" || !e.linearUserId) {
            throw new Error(`routing.agents[${i}].linearUserId is required`);
        }
        if (typeof e.agentId !== "string" || !e.agentId) {
            throw new Error(`routing.agents[${i}].agentId is required`);
        }
        if (typeof e.sessionKey !== "string" || !e.sessionKey) {
            throw new Error(`routing.agents[${i}].sessionKey is required`);
        }
        return {
            linearUserId: e.linearUserId,
            linearEmail: typeof e.linearEmail === "string" ? e.linearEmail : undefined,
            agentId: e.agentId,
            sessionKey: e.sessionKey,
        };
    });
}
function validateTeamDefaults(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        throw new Error("routing.teamDefaults must be an array");
    }
    return raw.map((entry, i) => {
        if (!entry || typeof entry !== "object") {
            throw new Error(`routing.teamDefaults[${i}] must be an object`);
        }
        const e = entry;
        if (typeof e.teamKey !== "string" || !e.teamKey) {
            throw new Error(`routing.teamDefaults[${i}].teamKey is required`);
        }
        if (typeof e.agentId !== "string" || !e.agentId) {
            throw new Error(`routing.teamDefaults[${i}].agentId is required`);
        }
        if (typeof e.sessionKey !== "string" || !e.sessionKey) {
            throw new Error(`routing.teamDefaults[${i}].sessionKey is required`);
        }
        return {
            teamKey: e.teamKey,
            agentId: e.agentId,
            sessionKey: e.sessionKey,
        };
    });
}
//# sourceMappingURL=config.js.map