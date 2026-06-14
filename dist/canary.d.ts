/**
 * Phase 6.5 / H-1 — Continuous canary against silent fail-open (§4.6).
 *
 * A runtime canary that repeatedly issues a known-illegal move on a fixture
 * ticket and asserts the proxy still rejects it. If the illegal move ever
 * succeeds (i.e. enforcement is silently disabled), the canary fires an
 * alert immediately.
 *
 * The canary runs on a configurable interval (default: 60 seconds) and
 * checks the following conditions:
 *   1. Config health — all three artifacts loaded and valid
 *   2. Enforcement — a known-illegal intent is rejected by the proxy
 *   3. Break-glass bypass — the break-glass intent still works
 *
 * The fixture ticket is a dedicated Linear issue used exclusively for canary
 * checks. It must carry the wf:dev-impl label and be in a known state so the
 * proxy can evaluate legal moves against it.
 *
 * Alert behavior:
 *   - On enforcement failure (illegal move succeeds): immediate alert
 *   - On config health degradation: alert via config-health callbacks
 *   - On canary fetch error: log warning, increment failure counter
 *   - After N consecutive canary failures: escalate alert
 *
 * Design: design.md §4.6.
 */
export interface CanaryConfig {
    /** Proxy base URL (default: http://localhost:PORT). */
    proxyUrl?: string;
    /** Auth token for the canary agent. */
    authToken: string;
    /** Agent ID for the canary calls. Must be a known body in the policy. */
    agentId: string;
    /** Fixture ticket identifier (e.g. "AI-CANARY"). */
    fixtureTicketId: string;
    /** Check interval in milliseconds (default: 60_000). */
    intervalMs?: number;
    /** Known-illegal intent to test with. Must NOT be legal in the fixture's current state. */
    illegalIntent?: string;
    /** Break-glass intent to verify is still allowed. */
    breakGlassIntent?: string;
}
export interface CanaryResult {
    /** Whether the canary check passed (enforcement is working). */
    passed: boolean;
    /** Whether the config is healthy. */
    configHealthy: boolean;
    /** Error description if the canary failed. */
    error?: string;
    /** Timestamp of this check (ISO 8601). */
    timestamp: string;
}
export type CanaryAlertCallback = (result: CanaryResult) => void;
/**
 * Start the canary with the given configuration.
 * The canary will run its first check immediately, then on the configured interval.
 * Only one canary can be active at a time — calling start() while already running
 * is a no-op.
 */
export declare function startCanary(config: CanaryConfig): void;
/**
 * Stop the canary. No-op if not running.
 */
export declare function stopCanary(): void;
/**
 * Run a single canary check and return the result.
 * This is the core check logic — can be called directly for testing.
 */
export declare function runCheck(): Promise<CanaryResult>;
/**
 * Get the last canary result (null if never run).
 */
export declare function getLastResult(): CanaryResult | null;
/**
 * Register a canary alert callback. Called when the canary detects a failure.
 * Returns an unsubscribe function.
 */
export declare function onCanaryAlert(callback: CanaryAlertCallback): () => void;
/**
 * Reset canary state (used in tests).
 */
export declare function resetCanary(): void;
export interface TransitionWalkResult {
    passed: boolean;
    transitionsChecked: number;
    violations: TransitionWalkViolation[];
    timestamp: string;
}
export interface TransitionWalkViolation {
    from: string;
    command: string;
    to: string;
    issue: string;
}
/**
 * Walk the workflow transition graph and verify every hop produces a valid state.
 * Design: AI-1493 item 4.
 */
export declare function runTransitionWalk(): Promise<TransitionWalkResult>;
//# sourceMappingURL=canary.d.ts.map