import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { isLinearIssueActionable } from "../linear-actionable.js";

const log = componentLogger(createLogger(), "resignal");

export interface ResignalOptions {
  /** Mark the agent active for the first successfully signaled ticket. */
  markActive?: boolean;
  /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
  isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
  /** Optional test hook for delivery. */
  sendWakeUp?: typeof sendWakeUpSignal;
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
): Promise<number> {
  const normalizedTickets = [...new Set(ticketIds.map((ticketId) => normalizeSessionKey(ticketId)))];
  const isTicketActionable = options.isTicketActionable ?? isLinearIssueActionable;
  const sendWakeUp = options.sendWakeUp ?? sendWakeUpSignal;
  let sent = 0;

  for (const ticketId of normalizedTickets) {
    try {
      if (!(await isTicketActionable(ticketId, agentId))) {
        bag.removeTicket(agentId, ticketId);
        sessionTracker.removePendingTicket(ticketId, agentId);
        log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
        continue;
      }

      await sendWakeUp(agentId, [ticketId], wakeConfig);
      bag.removeTicket(agentId, ticketId);
      bag.recordSignal();
      if (options.markActive && sent === 0) {
        sessionTracker.startSession(agentId, ticketId);
      }
      sent++;
    } catch (err) {
      log.error(
        `Re-signal failed for ${agentId} [${ticketId}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sent;
}
