import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { sendWakeUpSignal, MENTION_TICKET_TEMPLATE, type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { isLinearIssueActionable, isLinearIssueStillRoutedToAgent, checkLinearIssueRouting } from "../linear-actionable.js";

const log = componentLogger(createLogger(), "resignal");

export interface DispatchResult {
  ticketId: string;
  dispatched: boolean;
  runId?: string;
  pruned?: boolean;
  /** True when dispatch was skipped because the routing check returned fail-open and failOpenBehavior is "defer". */
  deferred?: boolean;
  /** Canon version injected into this dispatch (null when no canon loaded). */
  canonVersion?: string | null;
}

export interface ResignalOptions {
  /** Mark the agent active for the first successfully signaled ticket. */
  markActive?: boolean;
  /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
  isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
  /** Optional test hook for delivery. */
  sendWakeUp?: (agentId: string, ticketIds: string[], config: WakeUpConfig) => Promise<{ runId?: string; canonVersion?: string } | void>;
  /** Optional callback after successful dispatch — used for ack tracking. */
  onDispatched?: (agentId: string, ticketId: string) => void;
  /**
   * How to handle a fail-open result (transient Linear API error) during the default routing check.
   * - "dispatch" (default): treat as actionable and dispatch — preserves fail-open protection for
   *   live webhook events where dropping legitimate work would be worse than a spurious wake-up.
   * - "defer": skip dispatch but leave in bag for retry on the next connector start — safe for
   *   startup-replay where a transient error should not resurrect Done tickets.
   * Has no effect when isTicketActionable is provided (custom override bypasses this logic).
   */
  failOpenBehavior?: "dispatch" | "defer";
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
      if (options.isTicketActionable) {
        // Custom override provided: use it as-is (failOpenBehavior does not apply)
        if (!(await options.isTicketActionable(ticketId, agentId))) {
          bag.removeTicket(agentId, ticketId);
          sessionTracker.removePendingTicket(ticketId, agentId);
          log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
          results.push({ ticketId, dispatched: false, pruned: true });
          continue;
        }
      } else {
        // Default: use checkLinearIssueRouting for rich result so failOpenBehavior can apply
        const storedReason = bag.getTicketRoutingReason(agentId, ticketId);
        const effectiveReason = (storedReason ?? "delegate") as "delegate" | "assignee" | "mention" | "body-mention";
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
      results.push({ ticketId, dispatched: true, runId: (wakeResult as { runId?: string; canonVersion?: string } | void | undefined)?.runId, canonVersion: (wakeResult as { runId?: string; canonVersion?: string } | void | undefined)?.canonVersion ?? null });
    } catch (err) {
      log.error(
        `Re-signal failed for ${agentId} [${ticketId}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({ ticketId, dispatched: false });
    }
  }

  return results;
}
