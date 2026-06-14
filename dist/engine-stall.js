/**
 * Phase 6.5 / H-3 — Engine stall detection + agent response (+ at-capacity accounting).
 *
 * **Engine owns detection.** Each state carries a time-in-state SLA; when an outstanding
 * child breaches it, the engine detects the breach and emits a stall event against that
 * specific child and its ancestor chain. The parent does not poll for staleness.
 *
 * **Parent agent owns the qualitative response.** On a stall event, the `managing` owner
 * decides what the situation needs — nudge, guidance, or escalation of the specific stuck
 * child (barrier-level break-glass, §5.3).
 *
 * **At-capacity ≠ stall.** A legitimately deferred/at-capacity child (the AI-1339 case)
 * has its waiting time attributed up the ancestor SLA accounting as **known deferral**,
 * so an overloaded-but-healthy subtree does not trip stall escalation while a genuinely
 * stuck leaf still does.
 *
 * Design: design.md §5.5, §16.1.
 *
 * ACs:
 *   - A deliberately stalled leaf produces a stall event to its parent.
 *   - An at-capacity-but-healthy subtree does NOT trip stall escalation.
 *
 * Cross-ref AI-1339 (capacity-aware delivery recovery — the at-capacity classification this consumes).
 */
import { componentLogger, createLogger } from "./logger.js";
import { fetchIssueWithLabels, resolveInternalId, } from "./linear-helpers.js";
import { detectStalledChildren } from "./barrier.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "engine-stall");
// ── Default SLA config (can be overridden via env) ────────────────────────
const DEFAULT_SLAS = [
    { state: "thinking", maxDurationMs: 60 * 60 * 1000, priority: 1 }, // 1 hour
    { state: "doing", maxDurationMs: 4 * 60 * 60 * 1000, priority: 2 }, // 4 hours
    { state: "managing", maxDurationMs: 24 * 60 * 60 * 1000, priority: 3 }, // 24 hours
];
/**
 * Parse SLA configuration from environment variables.
 * Format: STATE1:MAX_DURATION,STATE2:MAX_DURATION,...
 * Example: THINKING:3600000,DOING:14400000,MANAGING:86400000
 */
export function parseSLAs() {
    const slaString = process.env.ENGINE_STALL_SLAS ?? "";
    if (!slaString.trim())
        return DEFAULT_SLAS;
    const slas = [];
    for (const item of slaString.split(",")) {
        const [state, maxDurationStr] = item.split(":");
        if (!state || !maxDurationStr)
            continue;
        const maxDuration = parseInt(maxDurationStr, 10);
        if (isNaN(maxDuration) || maxDuration <= 0)
            continue;
        slas.push({ state, maxDurationMs: maxDuration, priority: 0 }); // Priority can be added via env
    }
    return slas.length > 0 ? slas : DEFAULT_SLAS;
}
// ── Helper: Find SLA for a state ───────────────────────────────────────────
function findSLA(stateName, slas) {
    return slas.find((sla) => sla.state === stateName) || null;
}
// ── Helper: Check if an issue is at-capacity/deferred ─────────────────────
/**
 * Check if a child issue is at-capacity (deferred) rather than genuinely stalled.
 *
 * This relies on the operational-events store from AI-1339 which tracks
 * `deferred-at-capacity` outcomes. If a child has a recent `deferred-at-capacity`
 * outcome, it means the agent was alive but at maxConcurrent — a known deferral.
 *
 * @param childIdentifier - The child issue to check
 * @returns true if the child is at-capacity/deferred
 */
async function isChildAtCapacity(childIdentifier, authToken) {
    // TODO(AI-1478): Integrate with operational-events store to check for deferred-at-capacity
    // For now, return false as we haven't implemented the ops store integration yet.
    // This will be filled in during AI-1339 integration.
    return false;
}
// ── Core: Detect stalled children with SLA breach detection ───────────────
/**
 * Detect stalled children that have breached their SLA.
 *
 * Compares each child's idle duration against its state's SLA and filters out
 * at-capacity/deferred children (known deferrals) that should not trigger
 * stall escalation.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @param slas - SLA configuration for each state
 * @returns Array of StallEvent objects for children that breached their SLA
 */
export async function detectStalledChildrenWithSLA(parentIdentifier, authToken, slas) {
    const now = Date.now();
    // First, check for at-capacity children using the existing detectStalledChildren
    // but filter out at-capacity ones from the final result
    const rawStalled = await detectStalledChildren(parentIdentifier, authToken);
    const stalledEvents = [];
    for (const raw of rawStalled) {
        const sla = findSLA(raw.currentState ?? "", slas);
        if (!sla) {
            // No SLA configured for this state — can't determine breach
            continue;
        }
        const isAtCapacity = await isChildAtCapacity(raw.identifier, authToken);
        if (isAtCapacity) {
            // At-capacity child = known deferral — do NOT trip stall escalation
            log.info(`engine-stall: child ${raw.identifier} is at-capacity (deferred) — ` +
                `not emitting stall event`);
            continue;
        }
        // Check if this child breached its SLA
        if (raw.idleDurationMs >= sla.maxDurationMs) {
            log.info(`engine-stall: child ${raw.identifier} breached SLA '${sla.state}' ` +
                `(idle ${Math.round(raw.idleDurationMs / 60000)}m >= ${Math.round(sla.maxDurationMs / 60000)}m)`);
            stalledEvents.push({
                childIdentifier: raw.identifier,
                parentIdentifier: raw.parentIdentifier,
                currentState: raw.currentState,
                lastActivityAt: raw.lastActivityAt,
                idleDurationMs: raw.idleDurationMs,
                isAtCapacity,
                knownDeferralAncestors: 0, // TODO(AI-1478): Calculate ancestor deferrals
                slaBreached: sla.state,
            });
        }
    }
    return stalledEvents;
}
// ── Core: Emit stall events to parent agent ───────────────────────────────
/**
 * Emit stall events to the parent agent by posting a comment on the parent ticket.
 *
 * This is the "emission" part of the engine's stall detection — the engine
 * surfaces the issue to the parent agent, which then decides how to respond
 * (nudge, guidance, or escalation).
 *
 * @param stallEvents - Array of StallEvent objects to emit
 * @param authToken - Linear API auth token
 * @returns Number of stall events successfully emitted
 */
export async function emitStallEvents(stallEvents, authToken) {
    if (stallEvents.length === 0)
        return 0;
    // Fetch parent details once
    const parentEvent = stallEvents[0];
    const parentWithLabels = await fetchIssueWithLabels(parentEvent.parentIdentifier, authToken);
    if (!parentWithLabels) {
        log.error(`engine-stall: cannot emit stall events — failed to fetch parent ${parentEvent.parentIdentifier}`);
        return 0;
    }
    // Build stall event message
    const message = buildStallEventMessage(stallEvents);
    // Post the message as a comment on the parent
    const internalId = await resolveInternalId(parentEvent.parentIdentifier, authToken);
    if (!internalId) {
        log.error(`engine-stall: cannot emit stall events — failed to resolve parent ${parentEvent.parentIdentifier}`);
        return 0;
    }
    const posted = await import("./linear-helpers.js").then((m) => m.postComment(internalId, message, authToken));
    if (posted) {
        log.info(`engine-stall: emitted ${stallEvents.length} stall event(s) to ${parentEvent.parentIdentifier}`);
        return stallEvents.length;
    }
    return 0;
}
/**
 * Build a human-readable stall event message for the parent agent.
 *
 * Includes details about which children are stalled, their breach reason,
 * and actionable suggestions for the parent to respond.
 */
export function buildStallEventMessage(stallEvents) {
    const lines = [
        `[Stall Detection] Engine detected ${stallEvents.length} child(ren) that breached their SLA:`,
        "",
    ];
    for (const event of stallEvents) {
        const idleMin = Math.round(event.idleDurationMs / 60000);
        const slaMin = Math.round(event.slaBreached === "thinking" ? 60 : event.slaBreached === "doing" ? 240 : 1440);
        lines.push(`  • ${event.childIdentifier}`);
        lines.push(`    - Current state: ${event.currentState ?? "unknown"}`);
        lines.push(`    - Idle duration: ${idleMin}m (${event.lastActivityAt ? new Date(event.lastActivityAt).toISOString() : "N/A"})`);
        lines.push(`    - SLA breached: ${event.slaBreached} (${slaMin}m max)`);
        lines.push(`    - At-capacity: ${event.isAtCapacity ? "Yes (known deferral)" : "No"}`);
        lines.push("");
    }
    lines.push("Action: The parent agent should decide how to respond:");
    lines.push("  - Nudge: Re-assign or request an update from the child agent");
    lines.push("  - Guidance: Provide additional context or requirements");
    lines.push("  - Escalation: Use barrier-level break-glass to forcefully advance");
    return lines.join("\n");
}
// ── Public API: Trigger stall detection and emission ───────────────────────
/**
 * Main entry point for engine stall detection and emission.
 *
 * Call this when the engine wants to check for stalled children. It:
 *   1. Detects children that have breached their SLA
 *   2. Filters out at-capacity/deferred children (known deferrals)
 *   3. Emits stall events to the parent agent via a comment
 *
 * This is triggered periodically (e.g., during managing-wake) or when
 * a child event is received.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @returns Number of stall events emitted
 */
export async function triggerStallDetection(parentIdentifier, authToken) {
    const slas = parseSLAs();
    log.info(`engine-stall: checking for stalled children on ${parentIdentifier} ` +
        `(${slas.length} SLA(s) configured)`);
    const stalledEvents = await detectStalledChildrenWithSLA(parentIdentifier, authToken, slas);
    return await emitStallEvents(stalledEvents, authToken);
}
// ── Legacy: Re-export for backward compatibility ───────────────────────────
// Re-export the existing detectStalledChildren for compatibility
export { detectStalledChildren } from "./barrier.js";
//# sourceMappingURL=engine-stall.js.map