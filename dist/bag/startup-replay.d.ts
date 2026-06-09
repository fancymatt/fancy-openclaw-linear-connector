import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { type ResignalOptions } from "./resignal.js";
import type { WakeUpConfig } from "./wake-up.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
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
export declare function replayPendingBag(bag: PendingWorkBag, sessionTracker: SessionTracker, wakeConfig: WakeUpConfig, operationalEventStore?: OperationalEventStore, options?: StartupReplayOptions & {
    /** Resolve per-agent WakeUpConfig (hooksUrl/hooksToken from agents.json).
     *  When provided, used instead of the static wakeConfig so container-retired
     *  agents receive replay signals on their own gateway, not the host. */
    wakeConfigForAgent?: (agentId: string) => WakeUpConfig;
}): Promise<StartupReplayResult>;
//# sourceMappingURL=startup-replay.d.ts.map