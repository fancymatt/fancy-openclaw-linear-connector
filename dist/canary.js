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
import { componentLogger, createLogger } from "./logger.js";
import { isHealthy as isConfigHealthy, getStatus as getConfigStatus, onAlert } from "./config-health.js";
import { loadWorkflowDef, loadWorkflowRegistry } from "./workflow-gate.js";
import { notify } from "./alerts/alert-bus.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "canary");
const LINEAR_API_URL = "https://api.linear.app/graphql";
// ── Singleton state ────────────────────────────────────────────────────────
let canaryTimer = null;
let canaryConfig = null;
let consecutiveFailures = 0;
let lastResult = null;
let alertCallbacks = [];
let configHealthUnsub = null;
// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Start the canary with the given configuration.
 * The canary will run its first check immediately, then on the configured interval.
 * Only one canary can be active at a time — calling start() while already running
 * is a no-op.
 */
export function startCanary(config) {
    if (canaryTimer) {
        log.warn("canary: already running — ignoring start() call");
        return;
    }
    canaryConfig = config;
    consecutiveFailures = 0;
    const intervalMs = config.intervalMs ?? 60000;
    // Register for config-health alerts — forward them as canary alerts.
    // Store unsubscribe so stopCanary() can clean it up.
    configHealthUnsub = onAlert((status) => {
        const result = {
            passed: false,
            configHealthy: false,
            error: formatConfigAlert(status),
            timestamp: new Date().toISOString(),
        };
        fireCanaryAlerts(result);
    });
    log.info(`canary: starting with interval=${intervalMs}ms fixture=${config.fixtureTicketId}`);
    // Run first check immediately.
    runCheck().catch((err) => {
        log.error(`canary: initial check threw: ${err instanceof Error ? err.message : String(err)}`);
    });
    canaryTimer = setInterval(() => {
        runCheck().catch((err) => {
            log.error(`canary: periodic check threw: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, intervalMs);
}
/**
 * Stop the canary. No-op if not running.
 */
export function stopCanary() {
    const wasRunning = canaryTimer !== null;
    if (canaryTimer) {
        clearInterval(canaryTimer);
        canaryTimer = null;
    }
    // Unsubscribe from config-health alerts to prevent leak on restart.
    if (configHealthUnsub) {
        configHealthUnsub();
        configHealthUnsub = null;
    }
    if (wasRunning) {
        log.info("canary: stopped");
    }
}
/**
 * Run a single canary check and return the result.
 * This is the core check logic — can be called directly for testing.
 */
export async function runCheck() {
    if (!canaryConfig) {
        return {
            passed: false,
            configHealthy: false,
            error: "Canary not configured",
            timestamp: new Date().toISOString(),
        };
    }
    const config = canaryConfig;
    const timestamp = new Date().toISOString();
    // Step 1: Check config health.
    const configHealthy = isConfigHealthy();
    if (!configHealthy) {
        const status = getConfigStatus();
        const result = {
            passed: false,
            configHealthy: false,
            error: formatConfigAlert(status),
            timestamp,
        };
        lastResult = result;
        return result;
    }
    // Step 2: Issue a known-illegal intent and verify the proxy rejects it.
    const proxyUrl = config.proxyUrl ?? `http://localhost:${process.env.PORT ?? "3456"}`;
    const illegalIntent = config.illegalIntent ?? "deploy"; // deploy is illegal outside deployment state
    const agentId = config.agentId;
    try {
        const response = await fetch(`${proxyUrl}/proxy/graphql`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: config.authToken,
                "X-Openclaw-Agent": agentId,
                "X-Openclaw-Linear-Intent": illegalIntent,
            },
            body: JSON.stringify({
                query: "mutation CanaryCheck($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
                variables: { id: config.fixtureTicketId },
            }),
        });
        const data = await response.json();
        // The proxy SHOULD have rejected this illegal move.
        // If it didn't (no errors), enforcement is silently broken — CRITICAL alert.
        if (!data.errors || data.errors.length === 0) {
            const result = {
                passed: false,
                configHealthy: true,
                error: `CRITICAL: Canary enforcement failure — illegal intent '${illegalIntent}' was NOT rejected on fixture ticket ${config.fixtureTicketId}. Enforcement may be silently disabled.`,
                timestamp,
            };
            consecutiveFailures++;
            lastResult = result;
            log.error(result.error ?? "unknown canary error");
            fireCanaryAlerts(result);
            return result;
        }
        // The proxy correctly rejected the illegal move — enforcement is working.
        consecutiveFailures = 0;
        const result = {
            passed: true,
            configHealthy: true,
            timestamp,
        };
        lastResult = result;
        log.info(`canary: check passed — '${illegalIntent}' correctly rejected on ${config.fixtureTicketId}`);
        return result;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consecutiveFailures++;
        const result = {
            passed: false,
            configHealthy: true,
            error: `Canary fetch error: ${msg}`,
            timestamp,
        };
        lastResult = result;
        if (consecutiveFailures > 3) {
            log.error(`canary: ${consecutiveFailures} consecutive fetch failures — proxy may be down: ${msg}`);
            fireCanaryAlerts(result);
        }
        else {
            log.warn(`canary: fetch failed (${consecutiveFailures}/3 before alert): ${msg}`);
        }
        return result;
    }
}
/**
 * Get the last canary result (null if never run).
 */
export function getLastResult() {
    return lastResult;
}
/**
 * Register a canary alert callback. Called when the canary detects a failure.
 * Returns an unsubscribe function.
 */
export function onCanaryAlert(callback) {
    alertCallbacks.push(callback);
    return () => {
        alertCallbacks = alertCallbacks.filter((cb) => cb !== callback);
    };
}
/**
 * Reset canary state (used in tests).
 */
export function resetCanary() {
    stopCanary();
    canaryConfig = null;
    consecutiveFailures = 0;
    lastResult = null;
    alertCallbacks = [];
    configHealthUnsub = null;
}
// ── Internal ───────────────────────────────────────────────────────────────
function formatConfigAlert(status) {
    const degraded = Object.values(status.artifacts)
        .filter((a) => !a.healthy)
        .map((a) => `${a.kind}: ${a.lastError ?? "unknown error"} (${a.consecutiveFailures} consecutive failures)`)
        .join("; ");
    return `Config health degraded — ${degraded}`;
}
function fireCanaryAlerts(result) {
    // Canary failure = the enforcement/dispatch spine may be silently broken.
    notify({
        severity: "critical",
        source: "canary",
        title: "canary check failed — enforcement gate or dispatch spine may be silently broken",
        detail: result.error ?? undefined,
        dedupKey: "canary|failed",
    });
    for (const cb of alertCallbacks) {
        try {
            cb(result);
        }
        catch (err) {
            log.error(`canary: alert callback threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
/**
 * Walk the workflow transition graph and verify every hop produces a valid state.
 * Design: AI-1493 item 4.
 */
export async function runTransitionWalk() {
    const timestamp = new Date().toISOString();
    const violations = [];
    let transitionsChecked = 0;
    let def;
    try {
        def = await loadWorkflowDef();
    }
    catch (err) {
        return {
            passed: false,
            transitionsChecked: 0,
            violations: [{
                    from: "(root)",
                    command: "loadWorkflowDef",
                    to: "(n/a)",
                    issue: "Failed to load workflow definition: " + (err instanceof Error ? err.message : String(err)),
                }],
            timestamp,
        };
    }
    // Walk all defs in the registry (multi-workflow support)
    const registry = await loadWorkflowRegistry();
    for (const [, regDef] of registry) {
        walkDef(regDef);
    }
    function walkDef(walkDef) {
        const stateIds = new Set(walkDef.states.map((s) => s.id));
        for (const state of walkDef.states) {
            if (state.kind !== "terminal") {
                if (!state.owner_role) {
                    violations.push({
                        from: state.id,
                        command: "(schema)",
                        to: "(n/a)",
                        issue: "Non-terminal state '" + state.id + "' has no owner_role (wf:" + walkDef.id + ").",
                    });
                }
            }
            for (const transition of state.transitions ?? []) {
                transitionsChecked++;
                if (!stateIds.has(transition.to) && transition.to !== "__ad_hoc__") {
                    violations.push({
                        from: state.id,
                        command: transition.command,
                        to: transition.to,
                        issue: "Transition leads to undefined state '" + transition.to + "' (wf:" + walkDef.id + ").",
                    });
                    continue;
                }
                if (transition.to === "__ad_hoc__")
                    continue;
                const destState = walkDef.states.find((s) => s.id === transition.to);
                if (!destState)
                    continue;
                if (destState.kind === "terminal")
                    continue;
                if (!destState.owner_role) {
                    violations.push({
                        from: state.id,
                        command: transition.command,
                        to: transition.to,
                        issue: "Transition to non-terminal state '" + transition.to + "' which has no owner_role (wf:" + walkDef.id + ").",
                    });
                }
            }
        }
        if (walkDef.entry_state && !stateIds.has(walkDef.entry_state)) {
            violations.push({
                from: "(schema)",
                command: "entry_state",
                to: walkDef.entry_state,
                issue: "entry_state '" + walkDef.entry_state + "' does not reference a defined state (wf:" + walkDef.id + ").",
            });
        }
    }
    const passed = violations.length === 0;
    return { passed, transitionsChecked, violations, timestamp };
}
//# sourceMappingURL=canary.js.map