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
import type { PendingWorkBag } from "./pending-work-bag.js";
import type { SessionTracker } from "./session-tracker.js";
import type { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import { type ResignalOptions } from "./resignal.js";
import type { WakeUpConfig } from "./wake-up.js";
export interface WatchdogConfig {
    /** Milliseconds after dispatch before it is considered unacknowledged. Default: 10 min. */
    ackTimeoutMs: number;
    /** Max watchdog re-signal attempts before escalating to admin attention. Default: 3. */
    maxResignals: number;
    /** How frequently the watchdog runs its reconciliation cycle. Default: 3 min. */
    cycleIntervalMs: number;
}
export interface WatchdogDeps {
    bag: PendingWorkBag;
    sessionTracker: SessionTracker;
    ackTracker: DispatchAckTracker;
    operationalEventStore: OperationalEventStore;
    wakeConfig: WakeUpConfig;
    /** Resolve per-agent WakeUpConfig (hooksUrl/hooksToken from agents.json).
     *  When provided, used instead of the static wakeConfig so container-retired
     *  agents receive rescue signals on their own gateway, not the host. */
    wakeConfigForAgent?: (agentId: string) => WakeUpConfig;
    /** Optional test overrides forwarded to resignalPendingTickets (sendWakeUp, isTicketActionable). */
    resignalOptions?: Partial<ResignalOptions>;
}
export interface WatchdogCycleResult {
    unconfirmed: number;
    resignaled: number;
    escalated: number;
    autoAcknowledged: number;
}
export declare class DispatchWatchdog {
    private timer?;
    private config;
    private deps;
    constructor(deps: WatchdogDeps, config?: Partial<WatchdogConfig>);
    start(): void;
    stop(): void;
    /**
     * Run one reconciliation cycle. Safe to call manually in tests.
     *
     * Returns a summary of actions taken:
     *   - unconfirmed: dispatches past the ack timeout
     *   - resignaled: successfully re-signaled this cycle
     *   - escalated: exceeded maxResignals, surfaced as red in admin
     *   - autoAcknowledged: ticket no longer in bag, silently acked
     */
    runCycle(): Promise<WatchdogCycleResult>;
}
//# sourceMappingURL=dispatch-watchdog.d.ts.map