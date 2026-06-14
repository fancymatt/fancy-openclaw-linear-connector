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
import { componentLogger, createLogger } from "./logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "config-health");
// ── Singleton state ────────────────────────────────────────────────────────
const artifactState = {
    "workflow-def": {
        kind: "workflow-def",
        healthy: true,
        lastSuccess: null,
        lastFailure: null,
        lastError: null,
        consecutiveFailures: 0,
    },
    "capability-policy": {
        kind: "capability-policy",
        healthy: true,
        lastSuccess: null,
        lastFailure: null,
        lastError: null,
        consecutiveFailures: 0,
    },
    agents: {
        kind: "agents",
        healthy: true,
        lastSuccess: null,
        lastFailure: null,
        lastError: null,
        consecutiveFailures: 0,
    },
};
let alertCallbacks = [];
// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Record a successful load of the given artifact.
 * Resets consecutive failures and marks the artifact as healthy.
 */
export function recordSuccess(kind) {
    const artifact = artifactState[kind];
    artifact.healthy = true;
    artifact.lastSuccess = new Date().toISOString();
    artifact.lastError = null;
    artifact.consecutiveFailures = 0;
    if (isHealthy()) {
        log.info(`config-health: ${kind} loaded successfully — all artifacts healthy`);
    }
    else {
        log.warn(`config-health: ${kind} loaded successfully but other artifacts are degraded`);
    }
}
/**
 * Record a failed load of the given artifact.
 * Increments consecutive failures and marks the artifact as unhealthy.
 * Fires alert callbacks when the artifact transitions healthy → unhealthy
 * or when consecutive failures exceed a threshold.
 */
export function recordFailure(kind, error) {
    const artifact = artifactState[kind];
    const wasHealthy = artifact.healthy;
    artifact.healthy = false;
    artifact.lastFailure = new Date().toISOString();
    artifact.lastError = error;
    artifact.consecutiveFailures++;
    const status = getStatus();
    if (wasHealthy) {
        log.error(`config-health: ${kind} transitioned to UNHEALTHY: ${error}`);
        fireAlerts(status);
    }
    else if (artifact.consecutiveFailures % 5 === 0) {
        // Re-alert on every 5th consecutive failure to avoid alert fatigue
        // while still surfacing persistent degradation.
        log.warn(`config-health: ${kind} still unhealthy (${artifact.consecutiveFailures} consecutive failures): ${error}`);
        fireAlerts(status);
    }
}
/**
 * Get the current overall config health status.
 */
export function getStatus() {
    return {
        healthy: isHealthy(),
        artifacts: { ...artifactState },
    };
}
/**
 * Returns true only when ALL config artifacts are healthy.
 * When false, the engine must refuse to advance workflowed tickets (§16.0).
 */
export function isHealthy() {
    return Object.values(artifactState).every((a) => a.healthy);
}
/**
 * Register an alert callback. Called when config health transitions
 * from healthy to unhealthy (and on periodic re-alerts).
 * Returns an unsubscribe function.
 */
export function onAlert(callback) {
    alertCallbacks.push(callback);
    return () => {
        alertCallbacks = alertCallbacks.filter((cb) => cb !== callback);
    };
}
/**
 * Reset all health state (used in tests).
 */
export function resetConfigHealth() {
    for (const key of Object.keys(artifactState)) {
        artifactState[key] = {
            kind: key,
            healthy: true,
            lastSuccess: null,
            lastFailure: null,
            lastError: null,
            consecutiveFailures: 0,
        };
    }
    alertCallbacks = [];
}
// ── Internal ───────────────────────────────────────────────────────────────
function fireAlerts(status) {
    for (const cb of alertCallbacks) {
        try {
            cb(status);
        }
        catch (err) {
            log.error(`config-health: alert callback threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
//# sourceMappingURL=config-health.js.map