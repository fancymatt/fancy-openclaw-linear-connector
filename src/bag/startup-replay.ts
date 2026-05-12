import { createLogger, componentLogger } from "../logger.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { resignalPendingTickets, type ResignalOptions } from "./resignal.js";
import type { WakeUpConfig } from "./wake-up.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";

const log = componentLogger(createLogger(), "startup-replay");

const DEFAULT_INTER_AGENT_DELAY_MS = 500;

export interface StartupReplayOptions extends ResignalOptions {
  /** Milliseconds to wait between signaling each agent. Default 500ms. Prevents thundering herd after restart. */
  interAgentDelayMs?: number;
}

export interface StartupReplayResult {
  agents: number;
  replayed: number;
  pruned: number;
  skipped: number;
}

/**
 * On connector startup, replay any persisted pending work left in the bag.
 *
 * - Scans pending_bag for agents with actionable tickets.
 * - Skips agents that already have an active in-memory session (idempotent).
 * - Sends one wake-up per pending ticket, rate-limited by interAgentDelayMs.
 * - Emits startup-replayed / startup-pruned operational events.
 */
export async function replayPendingBag(
  bag: PendingWorkBag,
  sessionTracker: SessionTracker,
  wakeConfig: WakeUpConfig,
  operationalEventStore?: OperationalEventStore,
  options: StartupReplayOptions = {},
): Promise<StartupReplayResult> {
  const { interAgentDelayMs = DEFAULT_INTER_AGENT_DELAY_MS, ...resignalOptions } = options;

  const agents = bag.agentsWithPendingWork();
  if (agents.length === 0) {
    log.info("Startup replay: no pending work found.");
    return { agents: 0, replayed: 0, pruned: 0, skipped: 0 };
  }

  log.info(`Startup replay: found ${agents.length} agent(s) with pending work: ${agents.join(", ")}`);

  let totalReplayed = 0;
  let totalPruned = 0;
  let skipped = 0;

  for (let i = 0; i < agents.length; i++) {
    const agentId = agents[i];

    // Skip agents that already have a live session — they don't need a wake-up.
    if (sessionTracker.isActive(agentId)) {
      log.info(`Startup replay: skipping ${agentId} — already has active session`);
      skipped++;
      continue;
    }

    const pending = bag.getPendingTickets(agentId);
    if (pending.length === 0) {
      log.info(`Startup replay: ${agentId} — no tickets remaining after TTL prune, skipping`);
      skipped++;
      continue;
    }

    const ticketIds = pending.map((e) => e.ticketId);
    const beforeCount = ticketIds.length;

    try {
      const dispatchResults = await resignalPendingTickets(agentId, ticketIds, bag, sessionTracker, wakeConfig, {
        markActive: true,
        ...resignalOptions,
      });
      const sent = dispatchResults.filter(r => r.dispatched).length;
      const pruned = beforeCount - dispatchResults.length;
      totalReplayed += sent;
      totalPruned += pruned;

      if (sent > 0) {
        log.info(`Startup replay: ${agentId} — replayed ${sent} ticket(s)`);
        operationalEventStore?.append({
          outcome: "startup-replayed",
          agent: agentId,
          deliveryMode: "startup-replay",
          attemptCount: sent,
          detail: { requested: beforeCount, sent, pruned },
        });
      }
      if (pruned > 0) {
        log.info(`Startup replay: ${agentId} — pruned ${pruned} non-actionable ticket(s)`);
        operationalEventStore?.append({
          outcome: "startup-pruned",
          agent: agentId,
          deliveryMode: "startup-replay",
          attemptCount: pruned,
          detail: { requested: beforeCount, sent, pruned },
        });
      }
    } catch (err) {
      log.error(`Startup replay: failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Rate-limit between agents to avoid thundering herd after restart.
    if (i < agents.length - 1 && interAgentDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, interAgentDelayMs));
    }
  }

  log.info(`Startup replay complete: ${totalReplayed} replayed, ${totalPruned} pruned, ${skipped} skipped.`);
  return { agents: agents.length, replayed: totalReplayed, pruned: totalPruned, skipped };
}
