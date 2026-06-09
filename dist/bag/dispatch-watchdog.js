/**
 * DispatchWatchdog — interval-based reconciliation loop for unacknowledged dispatches.
 *
 * After a wake-up signal is delivered, the connector has no guaranteed signal that
 * the agent actually processed the work (the CT-52 incident: hook returned 200 but
 * the agent never acted). This watchdog closes that gap by:
 *
 *   1. Querying DispatchAckTracker for dispatches past the ack timeout.
 *   2. Logging a `delivery-unconfirmed` operational event (makes admin dashboard yellow/red).
 *   3. If the ticket is still in the pending bag: re-signaling the agent.
 *   4. If the ticket was cleared from the bag prematurely: re-adding it and re-signaling.
 *   5. After maxResignals attempts: escalating (admin action required).
 *
 * Re-signal behavior is bounded and idempotent:
 *   - Per-ticket session dedup in resignalPendingTickets prevents double-dispatch.
 *   - attempt_count is persisted in SQLite, so restarts don't reset the counter.
 *   - Tickets that are no longer actionable (Done/Canceled in Linear) are pruned
 *     by resignalPendingTickets's isTicketActionable check before any delivery.
 *
 * Configuration (env vars, all optional):
 *   WATCHDOG_ACK_TIMEOUT_MS   — how long before a dispatch is considered unacknowledged (default: 10 min)
 *   WATCHDOG_MAX_RESIGNALS    — max re-signal attempts before escalation (default: 3)
 *   WATCHDOG_CYCLE_INTERVAL_MS — how often the watchdog runs (default: 3 min)
 */
import { createLogger, componentLogger } from "../logger.js";
import { resignalPendingTickets } from "./resignal.js";
const log = componentLogger(createLogger(), "dispatch-watchdog");
const DEFAULT_ACK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_RESIGNALS = 3;
const DEFAULT_CYCLE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
function parseEnvInt(name, defaultVal) {
    const raw = process.env[name];
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}
export class DispatchWatchdog {
    constructor(deps, config) {
        this.deps = deps;
        this.config = {
            ackTimeoutMs: config?.ackTimeoutMs ?? parseEnvInt("WATCHDOG_ACK_TIMEOUT_MS", DEFAULT_ACK_TIMEOUT_MS),
            maxResignals: config?.maxResignals ?? parseEnvInt("WATCHDOG_MAX_RESIGNALS", DEFAULT_MAX_RESIGNALS),
            cycleIntervalMs: config?.cycleIntervalMs ?? parseEnvInt("WATCHDOG_CYCLE_INTERVAL_MS", DEFAULT_CYCLE_INTERVAL_MS),
        };
    }
    start() {
        if (this.timer)
            return;
        log.info(`Dispatch watchdog started — ackTimeout=${this.config.ackTimeoutMs}ms ` +
            `maxResignals=${this.config.maxResignals} cycle=${this.config.cycleIntervalMs}ms`);
        this.timer = setInterval(() => {
            this.runCycle().catch((err) => {
                log.error(`Watchdog cycle error: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, this.config.cycleIntervalMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    /**
     * Run one reconciliation cycle. Safe to call manually in tests.
     *
     * Returns a summary of actions taken:
     *   - unconfirmed: dispatches past the ack timeout
     *   - resignaled: successfully re-signaled this cycle
     *   - escalated: exceeded maxResignals, surfaced as red in admin
     *   - autoAcknowledged: ticket no longer in bag, silently acked
     */
    async runCycle() {
        const { bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig, wakeConfigForAgent } = this.deps;
        const timedOut = ackTracker.getPendingTimedOut(this.config.ackTimeoutMs);
        if (timedOut.length === 0) {
            return { unconfirmed: 0, resignaled: 0, escalated: 0, autoAcknowledged: 0 };
        }
        log.warn(`Watchdog cycle: ${timedOut.length} unacknowledged dispatch(es) detected`);
        let resignaled = 0;
        let escalated = 0;
        let autoAcknowledged = 0;
        for (const entry of timedOut) {
            const { agentId, ticketId, attemptCount } = entry;
            log.warn(`Unacknowledged dispatch: ${agentId} [${ticketId}] ` +
                `(attempt=${attemptCount}, lastSignal=${entry.lastSignalAt})`);
            operationalEventStore.append({
                outcome: "delivery-unconfirmed",
                agent: agentId,
                key: ticketId,
                sessionKey: ticketId,
                attemptCount,
                detail: {
                    dispatchedAt: entry.dispatchedAt,
                    lastSignalAt: entry.lastSignalAt,
                    attemptCount,
                    maxResignals: this.config.maxResignals,
                },
            });
            if (attemptCount > this.config.maxResignals) {
                ackTracker.markEscalated(agentId, ticketId);
                escalated++;
                log.error(`Watchdog escalation: ${agentId} [${ticketId}] — ${attemptCount} attempts, max is ${this.config.maxResignals}`);
                continue;
            }
            // End the stale session lock for this specific ticket before re-signaling.
            // The ack timeout elapsed without any evidence of agent activity, so the
            // session (if still in the tracker) is considered unresponsive. Clearing
            // it allows resignalPendingTickets to dispatch a fresh wake-up without
            // triggering the same-ticket-active dedup guard.
            sessionTracker.endSession(agentId, ticketId);
            const pendingEntries = bag.getPendingTickets(agentId);
            const pendingIds = pendingEntries.map((e) => e.ticketId);
            if (!pendingIds.includes(ticketId)) {
                // Ticket not in bag — it may have been cleared prematurely.
                // Re-add it before re-signaling. If the agent already completed the
                // work, the ack tracker entry will be acknowledged when session-end
                // fires; otherwise the bounded re-signal keeps the ticket alive.
                bag.add(agentId, ticketId, "Issue");
                log.warn(`Watchdog: re-added ${ticketId} to bag for ${agentId} (not in bag)`);
            }
            const agentWakeConfig = wakeConfigForAgent ? wakeConfigForAgent(agentId) : wakeConfig;
            const results = await resignalPendingTickets(agentId, [ticketId], bag, sessionTracker, agentWakeConfig, { markActive: true, ...this.deps.resignalOptions });
            const dispatched = results.some((r) => r.dispatched);
            const pruned = results.some((r) => r.pruned);
            if (dispatched) {
                ackTracker.markResignaled(agentId, ticketId);
                resignaled++;
                log.info(`Watchdog: re-signaled ${agentId} [${ticketId}] (attempt ${attemptCount + 1})`);
            }
            else if (pruned) {
                ackTracker.acknowledge(agentId, ticketId);
                autoAcknowledged++;
                log.info(`Watchdog: acknowledged ${agentId} [${ticketId}] after pruning non-actionable ticket`);
            }
            else {
                log.error(`Watchdog: re-signal failed for ${agentId} [${ticketId}] — will retry next cycle`);
            }
        }
        ackTracker.cleanup();
        return {
            unconfirmed: timedOut.length,
            resignaled,
            escalated,
            autoAcknowledged,
        };
    }
}
//# sourceMappingURL=dispatch-watchdog.js.map