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
export declare function deliverToAgent(route: RouteResult, config: DeliveryConfig): Promise<void>;
//# sourceMappingURL=deliver.d.ts.map