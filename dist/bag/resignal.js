import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { sendWakeUpSignal, MENTION_TICKET_TEMPLATE } from "./wake-up.js";
import { checkLinearIssueRouting } from "../linear-actionable.js";
const log = componentLogger(createLogger(), "resignal");
/**
 * Re-signal queued work one Linear issue at a time.
 *
 * A single multi-ticket wake-up is dangerous because OpenClaw keys the session by
 * one `linear-TEAM-N` value; unrelated tickets then land in the first ticket's
 * session. This helper preserves one per-ticket session key per pending ticket.
 */
export async function resignalPendingTickets(agentId, ticketIds, bag, sessionTracker, wakeConfig, options = {}) {
    const normalizedTickets = [...new Set(ticketIds.map((ticketId) => normalizeSessionKey(ticketId)))];
    const sendWakeUp = options.sendWakeUp ?? sendWakeUpSignal;
    const results = [];
    for (const ticketId of normalizedTickets) {
        try {
            // Skip if this ticket already has an active session — don't double-dispatch
            if (sessionTracker.isActiveForTicket(agentId, ticketId)) {
                log.info(`Session already active for ${agentId} [${ticketId}] — skipping resignal`);
                continue;
            }
            // Resolve per-ticket actionability. For mention/body-mention–routed tickets the
            // issue need not have this agent as delegate — mentions are always actionable.
            // For everything else (or unknown/legacy rows) fall back to the delegate check,
            // which preserves the ILL-331 protection: a ticket whose delegate was cleared by
            // needs-human/complete/handoff-work is correctly pruned here.
            if (options.isTicketActionable) {
                // Custom override provided: use it as-is (failOpenBehavior does not apply)
                if (!(await options.isTicketActionable(ticketId, agentId))) {
                    bag.removeTicket(agentId, ticketId);
                    sessionTracker.removePendingTicket(ticketId, agentId);
                    log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
                    results.push({ ticketId, dispatched: false, pruned: true });
                    continue;
                }
            }
            else {
                // Default: use checkLinearIssueRouting for rich result so failOpenBehavior can apply
                const storedReason = bag.getTicketRoutingReason(agentId, ticketId);
                const effectiveReason = (storedReason ?? "delegate");
                const routingResult = await checkLinearIssueRouting(ticketId, agentId, effectiveReason);
                if (!routingResult.actionable) {
                    bag.removeTicket(agentId, ticketId);
                    sessionTracker.removePendingTicket(ticketId, agentId);
                    log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
                    results.push({ ticketId, dispatched: false, pruned: true });
                    continue;
                }
                if (routingResult.failOpen && options.failOpenBehavior === "defer") {
                    // Transient error during routing check: defer dispatch rather than risk waking an agent
                    // for a ticket that may be Done. Ticket stays in bag for re-check on next connector start.
                    log.info(`Deferring fail-open pending ticket for ${agentId} [${ticketId}] — routing check uncertain, will retry on next startup`);
                    results.push({ ticketId, dispatched: false, deferred: true });
                    continue;
                }
            }
            // Use a mention-specific wake message so the agent knows to observe, not own.
            const storedReason = bag.getTicketRoutingReason(agentId, ticketId);
            const isMention = storedReason === "mention" || storedReason === "body-mention";
            const ticketWakeConfig = isMention
                ? { ...wakeConfig, signalTemplate: MENTION_TICKET_TEMPLATE }
                : wakeConfig;
            // Record intent before delivery — prevents double-dispatch even on failure;
            // stale session detection handles cleanup if delivery never completes.
            bag.recordSignal();
            if (options.markActive) {
                sessionTracker.startSession(agentId, ticketId);
            }
            const wakeResult = await sendWakeUp(agentId, [ticketId], ticketWakeConfig);
            options.onDispatched?.(agentId, ticketId);
            results.push({ ticketId, dispatched: true, runId: wakeResult?.runId });
        }
        catch (err) {
            log.error(`Re-signal failed for ${agentId} [${ticketId}]: ${err instanceof Error ? err.message : String(err)}`);
            results.push({ ticketId, dispatched: false });
        }
    }
    return results;
}
//# sourceMappingURL=resignal.js.map