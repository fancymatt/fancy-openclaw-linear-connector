/**
 * Phase 6.5 / H-1 — Config-load health monitoring (§16.0).
 *
 * Tracks the health of the three config artifacts the proxy depends on:
 *   1. Workflow definition YAML (dev-impl.yaml)
 *   2. Capability policy YAML (capability-policy.yaml)
 *   3. Agents JSON (agents.json)
 *
 * When any artifact fails to load or fails its invariant on (re)load, the
 * engine refuses to advance workflowed tickets and alerts. It NEVER falls
 * back to "run unvalidated" — this is the fail-closed posture for config-load.
 *
 * The canary (§4.6) reads config health to decide whether enforcement is
 * trustworthy. When health is degraded, the canary fires an alert rather
 * than silently passing.
 *
 * Design: design.md §4.6, §16.0.
 */
export type ArtifactKind = "workflow-def" | "capability-policy" | "agents";
export interface ArtifactHealth {
    kind: ArtifactKind;
    healthy: boolean;
    /** Last successful load timestamp (ISO 8601), or null if never loaded. */
    lastSuccess: string | null;
    /** Last failure timestamp (ISO 8601), or null if never failed. */
    lastFailure: string | null;
    /** Error message from the last failure, or null. */
    lastError: string | null;
    /** Number of consecutive failures. */
    consecutiveFailures: number;
}
export interface ConfigHealthStatus {
    /** Overall health: true only when ALL artifacts are healthy. */
    healthy: boolean;
    /** Per-artifact health status. */
    artifacts: Record<ArtifactKind, ArtifactHealth>;
}
export type AlertCallback = (status: ConfigHealthStatus) => void;
/**
 * Record a successful load of the given artifact.
 * Resets consecutive failures and marks the artifact as healthy.
 */
export declare function recordSuccess(kind: ArtifactKind): void;
/**
 * Record a failed load of the given artifact.
 * Increments consecutive failures and marks the artifact as unhealthy.
 * Fires alert callbacks when the artifact transitions healthy → unhealthy
 * or when consecutive failures exceed a threshold.
 */
export declare function recordFailure(kind: ArtifactKind, error: string): void;
/**
 * Get the current overall config health status.
 */
export declare function getStatus(): ConfigHealthStatus;
/**
 * Returns true only when ALL config artifacts are healthy.
 * When false, the engine must refuse to advance workflowed tickets (§16.0).
 */
export declare function isHealthy(): boolean;
/**
 * Register an alert callback. Called when config health transitions
 * from healthy to unhealthy (and on periodic re-alerts).
 * Returns an unsubscribe function.
 */
export declare function onAlert(callback: AlertCallback): () => void;
/**
 * Reset all health state (used in tests).
 */
export declare function resetConfigHealth(): void;
//# sourceMappingURL=config-health.d.ts.map