import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { isLinearIssueActionable } from "../linear-actionable.js";

const log = componentLogger(createLogger(), "resignal");

export interface DispatchResult {
  ticketId: string;
  dispatched: boolean;
  runId?: string;
}

export interface ResignalOptions {
  /** Mark the agent active for the first successfully signaled ticket. */
  markActive?: boolean;
  /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
  isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
  /** Optional test hook for delivery. */
  sendWakeUp?: (agentId: string, ticketIds: string[], config: WakeUpConfig) => Promise<{ runId?: string } | void>;
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
  const isTicketActionable = options.isTicketActionable ?? isLinearIssueActionable;
  const sendWakeUp = options.sendWakeUp ?? sendWakeUpSignal;
  const results: DispatchResult[] = [];

  for (const ticketId of normalizedTickets) {
    try {
      // Skip if this ticket already has an active session — don't double-dispatch
      if (sessionTracker.isActiveForTicket(agentId, ticketId)) {
        log.info(`Session already active for ${agentId} [${ticketId}] — skipping resignal`);
        continue;
      }

      if (!(await isTicketActionable(ticketId, agentId))) {
        bag.removeTicket(agentId, ticketId);
        sessionTracker.removePendingTicket(ticketId, agentId);
        log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
        continue;
      }

      const wakeResult = await sendWakeUp(agentId, [ticketId], wakeConfig);
      bag.recordSignal();
      if (options.markActive) {
        sessionTracker.startSession(agentId, ticketId);
      }
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
