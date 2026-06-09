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
  /** Tickets left in bag because routing check was uncertain (fail-open). Will be retried on next start. */
  deferred: number;
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
  options: StartupReplayOptions & {
    /** Resolve per-agent WakeUpConfig (hooksUrl/hooksToken from agents.json).
     *  When provided, used instead of the static wakeConfig so container-retired
     *  agents receive replay signals on their own gateway, not the host. */
    wakeConfigForAgent?: (agentId: string) => WakeUpConfig;
  } = {},
): Promise<StartupReplayResult> {
  const { interAgentDelayMs = DEFAULT_INTER_AGENT_DELAY_MS, wakeConfigForAgent, ...resignalOptions } = options;

  const agents = bag.agentsWithPendingWork();
  if (agents.length === 0) {
    log.info("Startup replay: no pending work found.");
    return { agents: 0, replayed: 0, pruned: 0, skipped: 0, deferred: 0 };
  }

  log.info(`Startup replay: found ${agents.length} agent(s) with pending work: ${agents.join(", ")}`);

  let totalReplayed = 0;
  let totalPruned = 0;
  let totalDeferred = 0;
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
    const agentWakeConfig = wakeConfigForAgent ? wakeConfigForAgent(agentId) : wakeConfig;

    try {
      const dispatchResults = await resignalPendingTickets(agentId, ticketIds, bag, sessionTracker, agentWakeConfig, {
        // During startup-replay, defer on fail-open: a transient Linear error should not
        // resurrect Done tickets. Tickets stay in bag for re-check on next start.
        // Callers can override by passing failOpenBehavior: "dispatch" in resignalOptions.
        failOpenBehavior: "defer",
        ...resignalOptions,
        markActive: true,
      });
      const sent = dispatchResults.filter(r => r.dispatched).length;
      const pruned = dispatchResults.filter(r => r.pruned).length;
      const deferred = dispatchResults.filter(r => r.deferred).length;
      totalReplayed += sent;
      totalPruned += pruned;
      totalDeferred += deferred;

      if (sent > 0) {
        log.info(`Startup replay: ${agentId} — replayed ${sent} ticket(s)`);
        operationalEventStore?.append({
          outcome: "startup-replayed",
          agent: agentId,
          deliveryMode: "startup-replay",
          attemptCount: sent,
          detail: { requested: beforeCount, sent, pruned, deferred },
        });
      }
      if (pruned > 0) {
        log.info(`Startup replay: ${agentId} — pruned ${pruned} non-actionable ticket(s)`);
        operationalEventStore?.append({
          outcome: "startup-pruned",
          agent: agentId,
          deliveryMode: "startup-replay",
          attemptCount: pruned,
          detail: { requested: beforeCount, sent, pruned, deferred },
        });
      }
      if (deferred > 0) {
        log.info(`Startup replay: ${agentId} — deferred ${deferred} ticket(s) due to uncertain routing check (fail-open)`);
        operationalEventStore?.append({
          outcome: "startup-pruned",
          agent: agentId,
          deliveryMode: "startup-replay",
          attemptCount: deferred,
          detail: { requested: beforeCount, sent, pruned, deferred, reason: "fail-open-deferred" },
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

  log.info(`Startup replay complete: ${totalReplayed} replayed, ${totalPruned} pruned, ${totalDeferred} deferred, ${skipped} skipped.`);
  return { agents: agents.length, replayed: totalReplayed, pruned: totalPruned, deferred: totalDeferred, skipped };
}
