import type { RouteResult } from "../types.js";
export interface DeliveryConfig {
    nodeBin: string;
    hooksUrl?: string;
    hooksToken?: string;
    hooksThinking?: string;
    hooksModel?: string;
    timeoutMs?: number;
    retryDelayMs?: number;
    maxRetries?: number;
}
export interface DeliveryResult {
    dispatched: boolean;
    runId?: string;
    /** Raw response body from the gateway, for observability. */
    rawResponse?: Record<string, unknown>;
    /** True when the gateway returned { ok: false } or an error body. */
    hookError?: boolean;
    /** Error summary from the gateway (if present in the response). */
    hookErrorSummary?: string;
}
/**
 * Deliver a routed event to an OpenClaw agent.
 *
 * Two modes:
 * 1. **HTTP hooks** — POST to an isolated agent endpoint (when hooksUrl + hooksToken configured).
 * 2. **CLI spawn** — run `openclaw agent` as a detached child process (default).
 *
 * Both modes include retry with configurable timeout/delay/attempts.
 * Errors are logged, never thrown.
 */
export declare function deliverToAgent(route: RouteResult, config: DeliveryConfig): Promise<DeliveryResult>;
/** Deliver an explicit operator-authored message to an existing OpenClaw session. */
export declare function deliverMessageToAgent(agentName: string, sessionId: string, message: string, config: DeliveryConfig): Promise<DeliveryResult>;
//# sourceMappingURL=deliver.d.ts.map