import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { sendWakeUpSignal, MENTION_TICKET_TEMPLATE, type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { isLinearIssueActionable, isLinearIssueStillRoutedToAgent } from "../linear-actionable.js";

const log = componentLogger(createLogger(), "resignal");

export interface DispatchResult {
  ticketId: string;
  dispatched: boolean;
  runId?: string;
  pruned?: boolean;
}

export interface ResignalOptions {
  /** Mark the agent active for the first successfully signaled ticket. */
  markActive?: boolean;
  /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
  isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
  /** Optional test hook for delivery. */
  sendWakeUp?: (agentId: string, ticketIds: string[], config: WakeUpConfig) => Promise<{ runId?: string } | void>;
  /** Optional callback after successful dispatch — used for ack tracking. */
  onDispatched?: (agentId: string, ticketId: string) => void;
}

/**
 * Re-signal queued work one Linear issue at a time.
 *
 * A single multi-ticket wake-up is dangerous because OpenClaw keys the session by
 * one `linear-TEAM-N` value; unrelated tickets then land in the first ticket's
 * session. This helper preserves one per-ticket session key per pending ticket.
 */
export async function resignalPendingTickets(
  agentId: string,
  ticketIds: string[],
  bag: PendingWorkBag,
  sessionTracker: SessionTracker,
  wakeConfig: WakeUpConfig,
  options: ResignalOptions = {},
): Promise<DispatchResult[]> {
  const normalizedTickets = [...new Set(ticketIds.map((ticketId) => normalizeSessionKey(ticketId)))];
  const sendWakeUp = options.sendWakeUp ?? sendWakeUpSignal;
  const results: DispatchResult[] = [];

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
      const isTicketActionable =
        options.isTicketActionable ??
        ((tId: string, aId: string) => {
          const storedReason = bag.getTicketRoutingReason(aId, tId);
          const effectiveReason = (storedReason ?? "delegate") as "delegate" | "assignee" | "mention" | "body-mention";
          return isLinearIssueStillRoutedToAgent(tId, aId, effectiveReason);
        });

      if (!(await isTicketActionable(ticketId, agentId))) {
        bag.removeTicket(agentId, ticketId);
        sessionTracker.removePendingTicket(ticketId, agentId);
        log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
        results.push({ ticketId, dispatched: false, pruned: true });
        continue;
      }

      // Use a mention-specific wake message so the agent knows to observe, not own.
      const storedReason = bag.getTicketRoutingReason(agentId, ticketId);
      const isMention = storedReason === "mention" || storedReason === "body-mention";
      const ticketWakeConfig = isMention
        ? { ...wakeConfig, signalTemplate: MENTION_TICKET_TEMPLATE }
        : wakeConfig;

      const wakeResult = await sendWakeUp(agentId, [ticketId], ticketWakeConfig);
      bag.recordSignal();
      if (options.markActive) {
        sessionTracker.startSession(agentId, ticketId);
      }
      options.onDispatched?.(agentId, ticketId);
      results.push({ ticketId, dispatched: true, runId: (wakeResult as { runId?: string } | void | undefined)?.runId });
    } catch (err) {
      log.error(
        `Re-signal failed for ${agentId} [${ticketId}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({ ticketId, dispatched: false });
    }
  }

  return results;
}
