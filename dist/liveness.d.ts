/**
 * AI-1428 — Agent liveness pre-flight check.
 *
 * Before routing an implementation-state ticket to an agent, the connector
 * verifies the target can execute at least one model (hooks mode) or that the
 * agent's secrets are provisioned (CLI mode). If the agent is unreachable,
 * the caller receives a structured result and should emit DELEGATE_UNAVAILABLE.
 *
 * Hooks mode: POST to the gateway with a lightweight ping; 2xx = alive.
 * CLI mode: best-effort provisioning check (secrets file exists + token readable).
 *           CLI liveness is weaker — it confirms the agent *exists* but not
 *           that it can actually run a model. Document this delta in the source.
 */
export type LivenessResult = {
    available: true;
} | {
    available: false;
    reason: "timeout" | "unreachable" | "error";
    detail?: string;
};
export interface LivenessConfig {
    hooksUrl?: string;
    hooksToken?: string;
    /** Override timeout (default 60 000 ms). */
    timeoutMs?: number;
}
/**
 * Check whether an agent is reachable before dispatching work to it.
 *
 * In hooks mode, sends a lightweight POST with `{ ping: true }` and expects
 * a 2xx or a structured `{ ok: true }`. In CLI mode, performs a best-effort
 * check that the agent's secrets exist — this is NOT a true model check.
 */
export declare function checkAgentLiveness(agentName: string, config: LivenessConfig): Promise<LivenessResult>;
//# sourceMappingURL=liveness.d.ts.map