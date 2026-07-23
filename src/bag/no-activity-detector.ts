/**
 * NoActivityDetector — early failure detection for sessions that never started.
 *
 * Problem: The gateway hooks endpoint returns 200 + runId immediately, then runs
 * the agent session asynchronously. If the run fails (OAuth error, model down, etc.)
 * within seconds, the connector has no way to know — it trusts the 200 and tracks
 * the session as live. The 25-min stale timeout and 10-min ack timeout are far too
 * slow for this case.
 *
 * This detector closes the gap by:
 *   1. Tracking dispatched sessions with a first-activity timestamp.
 *   2. At WARN_THRESHOLD (default 2 min): logging a WARN and emitting a
 *      "no-activity-warn" operational event (dashboard goes yellow).
 *   3. At FAIL_THRESHOLD (default 5 min): treating the session as failed.
 *      Marks it in the ack tracker as "no-activity-failed", posts a comment
 *      on the Linear ticket, and triggers re-dispatch.
 *
 * Activity signals that reset the timer:
 *   - /session-end callback (agent completed, even briefly)
 *   - Linear webhook events showing state changes from the agent (tool calls)
 *
 * This is distinct from the 25-min stale timeout (sessions that DID run and then
 * went idle). This detector is for sessions that NEVER produced any observable
 * evidence of starting.
 *
 * Configuration (env vars, all optional):
 *   NO_ACTIVITY_WARN_MS              — warn threshold (default: 2 min)
 *   NO_ACTIVITY_FAIL_MS              — hard fail threshold (default: 5 min)
 *   NO_ACTIVITY_POLL_MS              — check interval (default: 30 sec)
 *   AGENT_DEFAULT_MAX_CONCURRENT     — optional per-agent serialize cap (default: unlimited)
 *   NO_ACTIVITY_DEFERRED_STALE_MS   — how long a deferred entry may sit before rescue (default: 90 min)
 */

import { createLogger, componentLogger } from "../logger.js";
import type { AgentConfig } from "../agents.js";
import type { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import type { SessionTracker } from "./session-tracker.js";
import type { PendingWorkBag } from "./pending-work-bag.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";
import { resignalPendingTickets, type ResignalOptions } from "./resignal.js";
import { isLinearIssueActionable } from "../linear-actionable.js";
import { tryNormalizeSessionKey } from "../session-key.js";
import { notify } from "../alerts/alert-bus.js";

const log = componentLogger(createLogger(), "no-activity-detector");

const DEFAULT_WARN_MS = 2 * 60 * 1000;          // 2 minutes
const DEFAULT_FAIL_MS = 5 * 60 * 1000;           // 5 minutes
const DEFAULT_POLL_MS = 30 * 1000;               // 30 seconds
const DEFAULT_AGENT_SERIALIZE_CAP = Number.MAX_SAFE_INTEGER;
const DEFAULT_DEFERRED_STALE_MS = 90 * 60 * 1000; // 90 minutes

export interface NoActivityConfig {
  /** Warn threshold — log + event after this much silence. Default: 2 min. */
  warnMs: number;
  /** Hard fail threshold — treat as failed after this much silence. Default: 5 min. */
  failMs: number;
  /** How often to check for no-activity sessions. Default: 30 sec. */
  pollMs: number;
  /** Optional per-agent serialize cap for correctness-only cases. Default: unlimited. */
  maxConcurrent: number;
  /** How long a deferred entry may sit before the stale-rescue sweep re-dispatches it. Default: 90 min. */
  deferredStaleMs: number;
}

export interface NoActivityDeps {
  sessionTracker: SessionTracker;
  ackTracker: DispatchAckTracker;
  bag: PendingWorkBag;
  operationalEventStore: OperationalEventStore;
  wakeConfig: WakeUpConfig;
  /** Resolve per-agent WakeUpConfig (hooksUrl/hooksToken from agents.json).
   *  When provided, used instead of the static wakeConfig so container-retired
   *  agents receive rescue signals on their own gateway, not the host. */
  wakeConfigForAgent?: (agentId: string) => WakeUpConfig;
  /** Optional test overrides forwarded to resignalPendingTickets. */
  resignalOptions?: Partial<ResignalOptions>;
  /** Optional: custom Linear comment poster for failed dispatches. */
  postLinearComment?: (agentId: string, ticketId: string, message: string) => Promise<boolean>;
  /** Optional: per-agent serialize cap override. Return 0 for no cap. */
  getAgentMaxConcurrent?: (agentId: string) => number;
  /** Optional: per-agent config lookup (used to read explicit maxConcurrent from AgentConfig). */
  getAgentConfig?: (agentId: string) => AgentConfig | undefined;
  /** AI-1666: optional per-ticket no-activity fail threshold override in ms.
   *  When provided and returns a number, that value replaces the global failMs
   *  for this ticket. Return undefined to fall back to the global default.
   *  Populated by workflow-gate after each state transition. */
  getFailMsForTicket?: (agentId: string, ticketId: string) => number | undefined;
}

export interface NoActivityCycleResult {
  warned: number;
  failed: number;
  alreadyEnded: number;
  /** Sessions classified as alive-but-at-capacity and deferred (not escalated). */
  deferredAtCapacity: number;
}

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

function normalizeSerializeCap(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

export class NoActivityDetector {
  private timer?: ReturnType<typeof setInterval>;
  private config: NoActivityConfig;
  private deps: NoActivityDeps;
  /** Track warned sessions to avoid repeated WARN logs for the same dispatch. */
  private warnedSessions: Set<string> = new Set();
  /** In-memory map of agentId → Set<ticketId> for tickets deferred due to at-capacity. */
  private deferredAtCapacity: Map<string, Set<string>> = new Map();

  constructor(deps: NoActivityDeps, config?: Partial<NoActivityConfig>) {
    this.deps = deps;
    this.config = {
      warnMs: config?.warnMs ?? parseEnvInt("NO_ACTIVITY_WARN_MS", DEFAULT_WARN_MS),
      failMs: config?.failMs ?? parseEnvInt("NO_ACTIVITY_FAIL_MS", DEFAULT_FAIL_MS),
      pollMs: config?.pollMs ?? parseEnvInt("NO_ACTIVITY_POLL_MS", DEFAULT_POLL_MS),
      maxConcurrent: normalizeSerializeCap(config?.maxConcurrent) ??
        parseEnvInt("AGENT_DEFAULT_MAX_CONCURRENT", DEFAULT_AGENT_SERIALIZE_CAP),
      deferredStaleMs: config?.deferredStaleMs ?? parseEnvInt("NO_ACTIVITY_DEFERRED_STALE_MS", DEFAULT_DEFERRED_STALE_MS),
    };
  }

  start(): void {
    if (this.timer) return;
    log.info(
      `No-activity detector started — warn=${this.config.warnMs}ms ` +
      `fail=${this.config.failMs}ms poll=${this.config.pollMs}ms`,
    );
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        log.error(
          `No-activity cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.config.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Clear the warned state for a session (called when the session ends
   * or when evidence of activity is observed).
   */
  clearWarned(agentId: string, sessionKey: string): void {
    if (sessionKey === "*") {
      for (const key of [...this.warnedSessions]) {
        if (key.startsWith(`${agentId}:`)) {
          this.warnedSessions.delete(key);
        }
      }
      return;
    }
    this.warnedSessions.delete(`${agentId}:${sessionKey}`);
  }

  /**
   * AI-1664: Record a proxy call as evidence that the agent started.
   * Satisfies the no-activity timer for the matched (agentId, ticketId) dispatch.
   * Silently ignored when ticketId cannot be normalized to a Linear identifier.
   */
  recordProxyActivity(agentId: string, ticketId: string): void {
    const normalized = tryNormalizeSessionKey(ticketId);
    if (!normalized) return;
    this.deps.ackTracker.acknowledge(agentId, normalized);
  }

  private getAgentMaxConcurrentValue(agentId: string): number {
    const fromAgentConfig = normalizeSerializeCap(this.deps.getAgentConfig?.(agentId)?.maxConcurrent);
    if (fromAgentConfig !== undefined) return fromAgentConfig;
    const fromDep = normalizeSerializeCap(this.deps.getAgentMaxConcurrent?.(agentId));
    if (fromDep !== undefined) return fromDep;
    return this.config.maxConcurrent;
  }

  private async handleAtCapacity(
    entry: { agentId: string; ticketId: string; attemptCount: number; dispatchedAt: string; lastSignalAt: string },
    sessionKey: string,
  ): Promise<void> {
    const { agentId, ticketId } = entry;
    const { operationalEventStore, sessionTracker } = this.deps;
    const ageMs = Date.now() - new Date(entry.lastSignalAt.replace(' ', 'T') + 'Z').getTime();
    const activeCount = sessionTracker.getActiveSessionKeys(agentId).length;
    const maxConcurrent = this.getAgentMaxConcurrentValue(agentId);

    log.info(
      `No-activity: deferring ${agentId} [${sessionKey}] — at capacity ` +
      `(${activeCount}/${maxConcurrent} sessions). Re-arm when a slot frees.`,
    );
    operationalEventStore.append({
      outcome: "deferred-at-capacity",
      agent: agentId,
      key: sessionKey,
      sessionKey,
      deliveryMode: "no-activity-detector",
      attemptCount: entry.attemptCount,
      detail: { dispatchedAt: entry.dispatchedAt, ageMs, activeCount, maxConcurrent },
    });

    let set = this.deferredAtCapacity.get(agentId);
    if (!set) {
      set = new Set();
      this.deferredAtCapacity.set(agentId, set);
    }
    set.add(ticketId);
  }

  /**
   * Re-arm deferred at-capacity tickets when a session slot frees.
   * Call this after sessionTracker.endSession() for an agent.
   */
  public async checkDeferredOnSessionEnd(agentId: string): Promise<void> {
    const { sessionTracker, bag, operationalEventStore, wakeConfig, wakeConfigForAgent } = this.deps;
    const set = this.deferredAtCapacity.get(agentId);
    if (!set || set.size === 0) return;

    const activeCount = sessionTracker.getActiveSessionKeys(agentId).length;
    const maxConcurrent = this.getAgentMaxConcurrentValue(agentId);
    if (activeCount >= maxConcurrent) return;

    const isTicketActionable = this.deps.resignalOptions?.isTicketActionable ?? isLinearIssueActionable;
    for (const ticketId of [...set]) {
      set.delete(ticketId);

      // End the stale session so resignalPendingTickets can open a fresh one.
      sessionTracker.endSession(agentId, ticketId);
      this.clearWarned(agentId, ticketId);

      if (!(await isTicketActionable(ticketId, agentId))) {
        log.info(`No-activity: deferred ticket ${ticketId} no longer actionable — skipping`);
        continue;
      }

      const pendingIds = bag.getPendingTickets(agentId).map((e) => e.ticketId);
      if (!pendingIds.includes(ticketId)) {
        bag.add(agentId, ticketId, "Issue");
      }

      const agentWakeConfig = wakeConfigForAgent ? wakeConfigForAgent(agentId) : wakeConfig;
      const results = await resignalPendingTickets(
        agentId,
        [ticketId],
        bag,
        sessionTracker,
        agentWakeConfig,
        { markActive: true, ...this.deps.resignalOptions },
      );

      if (results.some((r) => r.dispatched)) {
        operationalEventStore.append({
          outcome: "deferred-capacity-rearm",
          agent: agentId,
          key: ticketId,
          sessionKey: ticketId,
          deliveryMode: "no-activity-detector",
          detail: { agentId, ticketId },
        });
        log.info(`No-activity: re-armed deferred ticket ${ticketId} for ${agentId}`);
      }
    }

    if (set.size === 0) {
      this.deferredAtCapacity.delete(agentId);
    }
  }

  /**
   * Run one detection cycle. Returns a summary of actions taken.
   */
  async runCycle(): Promise<NoActivityCycleResult> {
    const { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig, wakeConfigForAgent } = this.deps;
    const result: NoActivityCycleResult = { warned: 0, failed: 0, alreadyEnded: 0, deferredAtCapacity: 0 };

    // Get all currently tracked dispatches that are still pending/unconfirmed
    let pending = ackTracker.getPendingTimedOut(0); // 0ms → all pending

    // === Terminal-state prune ===
    // Before any warn/fail escalation, prune ack entries whose tickets are
    // Done/Canceled — they should never emit no-activity events. Batched:
    // deduplicate by (agentId, ticketId) so one unique ticket gets at most
    // one Linear read per cycle, regardless of how many ack rows exist.
    // Reuses the same isLinearIssueActionable function as the resignal path
    // (AI-2389 pattern: isTerminalIssueState).
    // Fail-open: isLinearIssueActionable returns true on auth/network errors,
    // so the prune is safely skipped during a Linear outage.
    if (pending.length > 0) {
      const seen = new Set<string>();
      const unique: Array<{ agentId: string; ticketId: string }> = [];
      for (const e of pending) {
        const key = `${e.agentId}:${e.ticketId}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push({ agentId: e.agentId, ticketId: e.ticketId });
        }
      }

      const isTicketActionable = this.deps.resignalOptions?.isTicketActionable ?? isLinearIssueActionable;
      for (const { agentId, ticketId } of unique) {
        if (!(await isTicketActionable(ticketId, agentId))) {
          // Terminal ticket: end the dead session and acknowledge the ack
          const sessionKey = ticketId;
          sessionTracker.endSession(agentId, sessionKey);
          ackTracker.acknowledge(agentId, ticketId);
          this.clearWarned(agentId, sessionKey);
          log.info(
            `No-activity: pruned terminal-state ticket ${ticketId} for ${agentId}` +
            ` (Done/Canceled) — acknowledged and removed from no-activity ladder`,
          );
        }
      }

      // Re-fetch pending after pruning so the warn/fail loop doesn't iterate
      // over entries that were just acknowledged.
      pending = ackTracker.getPendingTimedOut(0);
    }

    const now = Date.now();

    for (const entry of pending) {
      const { agentId, ticketId } = entry;
      const sessionKey = ticketId; // Session keys are linear-<TEAM>-<NUMBER>

      // Skip if the session is no longer tracked as active (it ended naturally)
      if (!sessionTracker.isActiveForTicket(agentId, sessionKey)) {
        result.alreadyEnded++;
        continue;
      }

      // Age is measured from the LATEST delivery attempt (last_signal_at) —
      // consistent with getPendingTimedOut's filter. Measuring from the first
      // dispatch executed fresh re-wakes seconds after delivery (AI-1766).
      // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC).
      const lastSignalAt = new Date(entry.lastSignalAt.replace(' ', 'T') + 'Z').getTime();
      const ageMs = now - lastSignalAt;
      const sessionKeyWarn = `${agentId}:${sessionKey}`;

      // AI-1666: use per-state no-activity timeout when available.
      const effectiveFailMs = this.deps.getFailMsForTicket?.(agentId, ticketId) ?? this.config.failMs;

      if (ageMs >= effectiveFailMs) {
        // Check capacity before deciding: at-capacity → defer; hard-down → escalate
        const activeCount = sessionTracker.getActiveSessionKeys(agentId).length;
        const maxConcurrent = this.getAgentMaxConcurrentValue(agentId);
        if (activeCount >= maxConcurrent) {
          await this.handleAtCapacity(entry, sessionKey);
          result.deferredAtCapacity++;
          continue;
        }
        // Hard fail — session produced no activity for >effectiveFailMs and agent is not at capacity
        const deferred = await this.handleFailure(entry, sessionKey);
        if (deferred) {
          result.deferredAtCapacity++;
        } else {
          result.failed++;
        }
      } else if (ageMs >= this.config.warnMs) {
        // Warn — suspicious but not yet failed
        if (!this.warnedSessions.has(sessionKeyWarn)) {
          this.warnedSessions.add(sessionKeyWarn);
          log.warn(
            `No activity detected for ${agentId} [${sessionKey}] ` +
            `(${Math.round(ageMs / 1000)}s since dispatch, fail threshold at ${Math.round(effectiveFailMs / 1000)}s)`,
          );
          operationalEventStore.append({
            outcome: "no-activity-warn",
            agent: agentId,
            key: sessionKey,
            sessionKey,
            deliveryMode: "no-activity-detector",
            attemptCount: entry.attemptCount,
            detail: {
              dispatchedAt: entry.dispatchedAt,
              ageMs,
              warnThresholdMs: this.config.warnMs,
              failThresholdMs: effectiveFailMs,
            },
          });
          result.warned++;
        }
      }
    }

    // Rescue deferred entries that have been waiting too long (session-end may not have fired).
    const staleDeferred = ackTracker.getDeferredStale(this.config.deferredStaleMs);
    for (const entry of staleDeferred) {
      const { agentId, ticketId } = entry;
      const deferredSessionKey = ticketId;
      log.warn(
        `Stale deferred dispatch for ${agentId} [${deferredSessionKey}] ` +
        `(>${Math.round(this.config.deferredStaleMs / 60_000)}min) — rescuing`
      );
      const pendingIds = bag.getPendingTickets(agentId).map((e) => e.ticketId);
      if (!pendingIds.includes(ticketId)) {
        bag.add(agentId, ticketId, "Issue");
      }
      const isTicketActionable = this.deps.resignalOptions?.isTicketActionable ?? isLinearIssueActionable;
      if (!(await isTicketActionable(ticketId, agentId))) {
        bag.removeTicket(agentId, ticketId);
        sessionTracker.removePendingTicket(ticketId, agentId);
        ackTracker.acknowledge(agentId, ticketId);
        log.info(`No-activity: stale-deferred ticket ${ticketId} no longer actionable — pruning`);
        continue;
      }
      const agentWakeConfig = wakeConfigForAgent ? wakeConfigForAgent(agentId) : wakeConfig;
      const rescueResults = await resignalPendingTickets(
        agentId,
        [ticketId],
        bag,
        sessionTracker,
        agentWakeConfig,
        { markActive: true, ...this.deps.resignalOptions },
      );
      if (rescueResults.some((r) => r.dispatched)) {
        ackTracker.markResignaled(agentId, ticketId);
        log.info(`No-activity: rescued stale-deferred ${agentId} [${deferredSessionKey}]`);
      } else if (rescueResults.some((r) => r.pruned)) {
        ackTracker.acknowledge(agentId, ticketId);
      }
    }

    return result;
  }

  /**
   * Handle a no-activity failure: end session, classify, and either defer or escalate/re-dispatch.
   * Returns true if the ticket was deferred (agent alive but at capacity), false for hard failure.
   */
  private async handleFailure(
    entry: { agentId: string; ticketId: string; attemptCount: number; dispatchedAt: string; lastSignalAt: string; failureCount?: number },
    sessionKey: string,
  ): Promise<boolean> {
    const { agentId, ticketId, attemptCount } = entry;
    const { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig, wakeConfigForAgent } = this.deps;
    // Age is measured from the LATEST delivery attempt, not the first dispatch.
    // AI-1766: fresh wakes inherited a stale dispatched_at (recordDispatch upsert
    // keeps the original) and were failed/escalated seconds after delivery.
    const ageMs = Date.now() - new Date(entry.lastSignalAt.replace(' ', 'T') + 'Z').getTime();

    log.error(
      `No-activity failure for ${agentId} [${sessionKey}] ` +
      `(${Math.round(ageMs / 1000)}s since dispatch, no evidence of agent starting)`,
    );

    // 1. End the dead session
    sessionTracker.endSession(agentId, sessionKey);
    this.clearWarned(agentId, sessionKey);

    // 1a. Classify failure: alive-but-at-capacity vs. hard-down
    const remainingActiveSessions = sessionTracker.getActiveSessionKeys(agentId).length;
    const maxConcurrent = this.getAgentMaxConcurrentValue(agentId);
    const agentAlive = remainingActiveSessions > 0;
    // After removing the failing session, if remaining >= maxConcurrent-1, the agent was full.
    const atCapacity = remainingActiveSessions >= maxConcurrent - 1;

    if (agentAlive && atCapacity) {
      log.info(
        `No-activity: deferring ${agentId} [${sessionKey}] — alive but at capacity ` +
        `(${remainingActiveSessions}/${maxConcurrent} sessions). Re-dispatch when a slot frees.`,
      );
      operationalEventStore.append({
        outcome: "deferred-at-capacity",
        agent: agentId,
        key: sessionKey,
        sessionKey,
        deliveryMode: "no-activity-detector",
        attemptCount,
        detail: {
          dispatchedAt: entry.dispatchedAt,
          ageMs,
          remainingActiveSessions,
          maxConcurrent,
        },
      });
      // Keep ticket in bag so the session-end re-signal picks it up automatically.
      const pendingIds = bag.getPendingTickets(agentId).map((e) => e.ticketId);
      if (!pendingIds.includes(ticketId)) {
        bag.add(agentId, ticketId, "Issue");
        log.info(`No-activity: re-added ${ticketId} to bag for ${agentId} (deferred)`);
      }
      ackTracker.markDeferred(agentId, ticketId);
      return true;
    }

    const maxResignals = parseInt(process.env.WATCHDOG_MAX_RESIGNALS ?? "3", 10);
    const maxDeliveryFailures = parseInt(process.env.WATCHDOG_MAX_DELIVERY_FAILURES ?? "3", 10);

    // 2. Retries exhausted (agent repeatedly accepts wakes but never works).
    // Escalate BEFORE re-dispatching or commenting — no "attempt N" noise.
    // "Manual intervention required" must actually reach a human — the 🔴 comment
    // only helps if someone reads that ticket (audit #14: hours of re-dispatch
    // loops before anyone notices a broken agent).
    if (attemptCount >= maxResignals) {
      await this.escalate(
        entry,
        sessionKey,
        `${attemptCount} attempt(s) exhausted — the gateway accepted the dispatch but the agent never produced any activity (model down? auth token expired?)`,
      );
      return false;
    }

    // 3. Re-add to bag if needed, then prune if the ticket is no longer
    // actionable (delegate cleared / Done). Pruning posts no comment.
    const pendingEntries = bag.getPendingTickets(agentId);
    const pendingIds = pendingEntries.map((e) => e.ticketId);
    if (!pendingIds.includes(ticketId)) {
      bag.add(agentId, ticketId, "Issue");
      log.warn(`No-activity: re-added ${ticketId} to bag for ${agentId}`);
    }

    const isTicketActionable = this.deps.resignalOptions?.isTicketActionable ?? isLinearIssueActionable;
    if (!(await isTicketActionable(ticketId, agentId))) {
      bag.removeTicket(agentId, ticketId);
      sessionTracker.removePendingTicket(ticketId, agentId);
      log.info(`No-activity: ticket ${ticketId} no longer actionable — pruning`);
      ackTracker.acknowledge(agentId, ticketId);
      return false;
    }

    // 4. Attempt the re-dispatch. The failure comment, the attempt bump, and the
    // operational "failed" record are ALL tied to a re-dispatch that actually
    // started. A delivery that fails must neither announce "attempt N" nor
    // re-fire every poll — that unbounded, counter-frozen loop spammed GEN-88
    // with 10 identical "attempt 2" comments in 5 minutes (AI-2118).
    const agentWakeConfig = wakeConfigForAgent ? wakeConfigForAgent(agentId) : wakeConfig;
    const results = await resignalPendingTickets(
      agentId,
      [ticketId],
      bag,
      sessionTracker,
      agentWakeConfig,
      { markActive: true, ...this.deps.resignalOptions },
    );
    const dispatched = results.some((r) => r.dispatched);
    const pruned = results.some((r) => r.pruned);

    if (dispatched) {
      // Re-dispatch admitted: a genuine fresh attempt. Bump the attempt counter,
      // reset the clock (natural backoff of one full window), clear the
      // delivery-failure streak, and post exactly one comment.
      ackTracker.markResignaled(agentId, ticketId);
      const newAttempt = attemptCount + 1;
      log.info(`No-activity: re-dispatched ${agentId} [${ticketId}] (attempt ${newAttempt})`);

      operationalEventStore.append({
        outcome: "no-activity-failed",
        agent: agentId,
        key: sessionKey,
        sessionKey,
        deliveryMode: "no-activity-detector",
        attemptCount,
        detail: { dispatchedAt: entry.dispatchedAt, ageMs, failThresholdMs: this.config.failMs },
      });
      // Re-dispatches bypass the webhook router, so nothing else records them.
      // Without this event the retry loop is invisible in the operational
      // stream (AI-1759: had to read the ack sqlite directly to reconstruct).
      operationalEventStore.append({
        outcome: "no-activity-redispatch",
        agent: agentId,
        key: sessionKey,
        sessionKey,
        deliveryMode: "no-activity-detector",
        attemptCount: newAttempt,
      });

      const comment = `⚠️ **Dispatch failure detected** — session for this ticket produced no activity after ${Math.round(ageMs / 60_000)} minutes.\n\nThe gateway accepted the dispatch but the agent never started working. This usually indicates a gateway-side error (e.g., model unavailable, auth failure).\n\nRe-dispatched (attempt ${newAttempt}).`;
      if (this.deps.postLinearComment) {
        try {
          await this.deps.postLinearComment(agentId, sessionKey, comment);
        } catch (err) {
          log.error(`Failed to post Linear comment for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return false;
    }

    if (pruned) {
      // Ownership check in resignalPendingTickets determined the agent no longer
      // owns this ticket. Acknowledge so the ackTracker stops tracking it and the
      // detector doesn't re-add it on subsequent cycles.
      ackTracker.acknowledge(agentId, ticketId);
      log.info(`No-activity: ticket ${ticketId} pruned (agent no longer owns it) — ack tracker cleared`);
      return false;
    }

    // 5. Delivery failed (wake-up threw / deferred / skipped) — nothing was
    // re-dispatched. Reset the clock to back off a full window instead of
    // re-firing every poll, and count the delivery failure so a gateway that
    // never accepts wakes escalates instead of looping forever. No Linear
    // comment: there is no fresh attempt to announce.
    ackTracker.markResignalFailed(agentId, ticketId);
    const failureCount = (entry.failureCount ?? 0) + 1;
    log.error(
      `No-activity: re-dispatch DELIVERY failed for ${agentId} [${ticketId}] ` +
      `(delivery failure ${failureCount}/${maxDeliveryFailures}) — backing off`,
    );
    operationalEventStore.append({
      outcome: "no-activity-redispatch-failed",
      agent: agentId,
      key: sessionKey,
      sessionKey,
      deliveryMode: "no-activity-detector",
      attemptCount,
      detail: { dispatchedAt: entry.dispatchedAt, ageMs, failureCount, maxDeliveryFailures },
    });
    if (failureCount >= maxDeliveryFailures) {
      await this.escalate(
        entry,
        sessionKey,
        `${failureCount} re-dispatch deliver(ies) failed — the gateway is not accepting wakes for this agent (gateway down? hooks token invalid?)`,
      );
    }
    return false;
  }

  /**
   * AI-2118: terminal escalation for a stalled dispatch. Marks the ack row
   * escalated (removing it from the pending set so the detector stops looping),
   * fires an ops alert, and posts a single escalation comment. `reason` describes
   * why automated recovery gave up.
   */
  private async escalate(
    entry: { agentId: string; ticketId: string; attemptCount: number },
    sessionKey: string,
    reason: string,
  ): Promise<void> {
    const { agentId, ticketId, attemptCount } = entry;
    this.deps.ackTracker.markEscalated(agentId, ticketId);
    notify({
      severity: "warning",
      source: "dispatch",
      title: `dispatch escalation on ${ticketId}: ${reason}`,
      agent: agentId,
      ticket: ticketId,
    });
    const escalationComment = `🔴 **Dispatch failure escalation** — ${reason}. Manual intervention required.\n\nAutomated recovery is exhausted after ${attemptCount} attempt(s); this ticket is no longer being auto-re-dispatched.`;
    if (this.deps.postLinearComment) {
      try {
        await this.deps.postLinearComment(agentId, sessionKey, escalationComment);
      } catch (err) {
        log.error(`Failed to post escalation comment for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
