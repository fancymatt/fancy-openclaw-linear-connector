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
 *   NO_ACTIVITY_WARN_MS   — warn threshold (default: 2 min)
 *   NO_ACTIVITY_FAIL_MS   — hard fail threshold (default: 5 min)
 *   NO_ACTIVITY_POLL_MS   — check interval (default: 30 sec)
 */

import { createLogger, componentLogger } from "../logger.js";
import type { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import type { SessionTracker } from "./session-tracker.js";
import type { PendingWorkBag } from "./pending-work-bag.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";
import { resignalPendingTickets, type ResignalOptions } from "./resignal.js";
import { isLinearIssueActionable } from "../linear-actionable.js";

const log = componentLogger(createLogger(), "no-activity-detector");

const DEFAULT_WARN_MS = 2 * 60 * 1000;    // 2 minutes
const DEFAULT_FAIL_MS = 5 * 60 * 1000;     // 5 minutes
const DEFAULT_POLL_MS = 30 * 1000;          // 30 seconds

export interface NoActivityConfig {
  /** Warn threshold — log + event after this much silence. Default: 2 min. */
  warnMs: number;
  /** Hard fail threshold — treat as failed after this much silence. Default: 5 min. */
  failMs: number;
  /** How often to check for no-activity sessions. Default: 30 sec. */
  pollMs: number;
}

export interface NoActivityDeps {
  sessionTracker: SessionTracker;
  ackTracker: DispatchAckTracker;
  bag: PendingWorkBag;
  operationalEventStore: OperationalEventStore;
  wakeConfig: WakeUpConfig;
  /** Optional test overrides forwarded to resignalPendingTickets. */
  resignalOptions?: Partial<ResignalOptions>;
  /** Optional: custom Linear comment poster for failed dispatches. */
  postLinearComment?: (agentId: string, ticketId: string, message: string) => Promise<boolean>;
}

export interface NoActivityCycleResult {
  warned: number;
  failed: number;
  alreadyEnded: number;
}

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

export class NoActivityDetector {
  private timer?: ReturnType<typeof setInterval>;
  private config: NoActivityConfig;
  private deps: NoActivityDeps;
  /** Track warned sessions to avoid repeated WARN logs for the same dispatch. */
  private warnedSessions: Set<string> = new Set();

  constructor(deps: NoActivityDeps, config?: Partial<NoActivityConfig>) {
    this.deps = deps;
    this.config = {
      warnMs: config?.warnMs ?? parseEnvInt("NO_ACTIVITY_WARN_MS", DEFAULT_WARN_MS),
      failMs: config?.failMs ?? parseEnvInt("NO_ACTIVITY_FAIL_MS", DEFAULT_FAIL_MS),
      pollMs: config?.pollMs ?? parseEnvInt("NO_ACTIVITY_POLL_MS", DEFAULT_POLL_MS),
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
   * Run one detection cycle. Returns a summary of actions taken.
   */
  async runCycle(): Promise<NoActivityCycleResult> {
    const { sessionTracker, ackTracker, operationalEventStore } = this.deps;
    const result: NoActivityCycleResult = { warned: 0, failed: 0, alreadyEnded: 0 };

    // Get all currently tracked dispatches that are still pending/unconfirmed
    const pending = ackTracker.getPendingTimedOut(0); // 0ms → all pending
    const now = Date.now();

    for (const entry of pending) {
      const { agentId, ticketId } = entry;
      const sessionKey = ticketId; // Session keys are linear-<TEAM>-<NUMBER>

      // Skip if the session is no longer tracked as active (it ended naturally)
      if (!sessionTracker.isActiveForTicket(agentId, sessionKey)) {
        result.alreadyEnded++;
        continue;
      }

      // Parse dispatch time to compute age.
      // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC).
      // Replace the space with 'T' and append 'Z' for reliable ISO 8601 parsing.
      const dispatchedAt = new Date(entry.dispatchedAt.replace(' ', 'T') + 'Z').getTime();
      const ageMs = now - dispatchedAt;
      const sessionKeyWarn = `${agentId}:${sessionKey}`;

      if (ageMs >= this.config.failMs) {
        // Hard fail — session produced no activity for >5 minutes
        await this.handleFailure(entry, sessionKey);
        result.failed++;
      } else if (ageMs >= this.config.warnMs) {
        // Warn — suspicious but not yet failed
        if (!this.warnedSessions.has(sessionKeyWarn)) {
          this.warnedSessions.add(sessionKeyWarn);
          log.warn(
            `No activity detected for ${agentId} [${sessionKey}] ` +
            `(${Math.round(ageMs / 1000)}s since dispatch, fail threshold at ${Math.round(this.config.failMs / 1000)}s)`,
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
              failThresholdMs: this.config.failMs,
            },
          });
          result.warned++;
        }
      }
    }

    return result;
  }

  /**
   * Handle a no-activity failure: end session, log, post comment, re-dispatch.
   */
  private async handleFailure(
    entry: { agentId: string; ticketId: string; attemptCount: number; dispatchedAt: string },
    sessionKey: string,
  ): Promise<void> {
    const { agentId, ticketId, attemptCount } = entry;
    const { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig } = this.deps;
    const ageMs = Date.now() - new Date(entry.dispatchedAt.replace(' ', 'T') + 'Z').getTime();

    log.error(
      `No-activity failure for ${agentId} [${sessionKey}] ` +
      `(${Math.round(ageMs / 1000)}s since dispatch, no evidence of agent starting)`,
    );

    // 1. End the dead session
    sessionTracker.endSession(agentId, sessionKey);
    this.clearWarned(agentId, sessionKey);

    // 2. Log operational event
    operationalEventStore.append({
      outcome: "no-activity-failed",
      agent: agentId,
      key: sessionKey,
      sessionKey,
      deliveryMode: "no-activity-detector",
      attemptCount,
      detail: {
        dispatchedAt: entry.dispatchedAt,
        ageMs,
        failThresholdMs: this.config.failMs,
      },
    });

    // 3. Post comment on the Linear ticket
    const comment = `⚠️ **Dispatch failure detected** — session for this ticket produced no activity after ${Math.round(ageMs / 60_000)} minutes.\n\nThe gateway accepted the dispatch but the agent never started working. This usually indicates a gateway-side error (e.g., model unavailable, auth failure).\n\nRe-dispatching (attempt ${attemptCount + 1}).`;
    if (this.deps.postLinearComment) {
      try {
        await this.deps.postLinearComment(agentId, sessionKey, comment);
      } catch (err) {
        log.error(`Failed to post Linear comment for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. Check if retries are exhausted (delegate to existing escalation logic)
    // The DispatchAckTracker's attempt_count is already tracking this.
    const maxResignals = parseInt(process.env.WATCHDOG_MAX_RESIGNALS ?? "3", 10);
    if (attemptCount >= maxResignals) {
      ackTracker.markEscalated(agentId, ticketId);
      // Post escalation comment
      const escalationComment = `🔴 **Dispatch failure escalation** — ${attemptCount} attempt(s) exhausted for this ticket. Manual intervention required.\n\nThe gateway accepted the dispatch but the agent never produced any activity. This may indicate a persistent issue (model down, auth token expired, etc.).`;
      if (this.deps.postLinearComment) {
        try {
          await this.deps.postLinearComment(agentId, sessionKey, escalationComment);
        } catch (err) {
          log.error(`Failed to post escalation comment for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    // 5. Re-add to bag if needed and re-dispatch
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
      return;
    }

    const results = await resignalPendingTickets(
      agentId,
      [ticketId],
      bag,
      sessionTracker,
      wakeConfig,
      { markActive: true, ...this.deps.resignalOptions },
    );
    const dispatched = results.some((r) => r.dispatched);
    const pruned = results.some((r) => r.pruned);

    if (dispatched) {
      ackTracker.markResignaled(agentId, ticketId);
      log.info(`No-activity: re-dispatched ${agentId} [${ticketId}] (attempt ${attemptCount + 1})`);
    } else if (pruned) {
      // Ownership check in resignalPendingTickets determined the agent no longer owns this ticket.
      // Acknowledge so the ackTracker stops tracking it and the detector doesn't re-add it on
      // subsequent cycles.
      ackTracker.acknowledge(agentId, ticketId);
      log.info(`No-activity: ticket ${ticketId} pruned (agent no longer owns it) — ack tracker cleared`);
    } else {
      log.error(`No-activity: re-dispatch failed for ${agentId} [${ticketId}]`);
    }
  }
}
