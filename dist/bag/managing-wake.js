/**
 * Stewardship wake-up signal for Managing-state tickets.
 *
 * Bundles all due Managing tickets for an agent into a single wake message
 * so an agent with several stewardship tickets doesn't get woken once per
 * ticket. Uses the first ticket's `linear-<ID>` session key as the bundle
 * session, consistent with how multi-ticket bag wakes already work.
 *
 * The agent receives a prompt that lists each ticket plus a short checklist
 * of stewardship duties (subtask state, delegate sanity, ownership drift).
 */
import { deliverMessageToAgent } from "../delivery/index.js";
import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(), "managing-wake");
const STEWARDSHIP_INSTRUCTIONS = [
    "For each ticket above:",
    "1. Check subtask state. If a child resolved since your last review, decide whether the parent moves forward.",
    "2. Look for stalled children — anything in Backlog that should be To Do? Anything assigned to the wrong person?",
    "3. Verify assignee + delegate on each child match the current owner.",
    "4. If something material changed, post a delta-only note on the parent: what changed since the last stewardship comment, and where the current blocker/owner is now.",
    "5. Do not restate unchanged child status, old blockers, or the whole project summary. If the only update would be a recap, post nothing.",
    "",
    "Move tickets out of Managing when they're complete, abandoned, or actively workable.",
].join("\n");
function formatRelative(nowMs, atMs) {
    if (atMs === null)
        return "first review";
    const diffMs = Math.max(0, nowMs - atMs);
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}
export function buildManagingWakeMessage(tickets, now = Date.now()) {
    if (tickets.length === 0) {
        throw new Error("buildManagingWakeMessage requires at least one ticket");
    }
    const lines = ["You are managing these tickets:"];
    for (const t of tickets) {
        const stamp = formatRelative(now, t.lastDispatchedAt);
        lines.push(`- ${t.identifier}: ${t.title} (last reviewed: ${stamp})`);
    }
    lines.push("", STEWARDSHIP_INSTRUCTIONS);
    return lines.join("\n");
}
/**
 * Deliver a stewardship wake to an agent for one or more due Managing tickets.
 * Uses the first ticket's `linear-<ID>` session key as the bundle session.
 */
export async function sendManagingWakeSignal(agentId, tickets, config) {
    if (tickets.length === 0)
        return;
    const message = buildManagingWakeMessage(tickets);
    const sessionKey = normalizeSessionKey(tickets[0].identifier);
    log.info(`Managing wake → ${agentId} [${sessionKey}] bundling ${tickets.length} ticket(s): ${tickets.map((t) => t.identifier).join(", ")}`);
    try {
        const result = await deliverMessageToAgent(agentId, sessionKey, message, config);
        return result.runId ? { runId: result.runId } : undefined;
    }
    catch (err) {
        log.error(`Managing wake delivery failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}
//# sourceMappingURL=managing-wake.js.map