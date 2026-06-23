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
 *   AGENT_DEFAULT_MAX_CONCURRENT     — concurrent session cap per agent (default: 3)
 *   NO_ACTIVITY_DEFERRED_STALE_MS   — how long a deferred entry may sit before rescue (default: 90 min)
 */
import type { AgentConfig } from "../agents.js";
import type { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import type { SessionTracker } from "./session-tracker.js";
import type { PendingWorkBag } from "./pending-work-bag.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";
import { type ResignalOptions } from "./resignal.js";
export interface NoActivityConfig {
    /** Warn threshold — log + event after this much silence. Default: 2 min. */
    warnMs: number;
    /** Hard fail threshold — treat as failed after this much silence. Default: 5 min. */
    failMs: number;
    /** How often to check for no-activity sessions. Default: 30 sec. */
    pollMs: number;
    /** Max concurrent sessions per agent for capacity classification. Default: 3. */
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
    /** Optional: per-agent max concurrent override. Return 0 to use the global default. */
    getAgentMaxConcurrent?: (agentId: string) => number;
    /** Optional: per-agent config lookup (used to read maxConcurrent from AgentConfig). */
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
export declare class NoActivityDetector {
    private timer?;
    private config;
    private deps;
    /** Track warned sessions to avoid repeated WARN logs for the same dispatch. */
    private warnedSessions;
    /** In-memory map of agentId → Set<ticketId> for tickets deferred due to at-capacity. */
    private deferredAtCapacity;
    constructor(deps: NoActivityDeps, config?: Partial<NoActivityConfig>);
    start(): void;
    stop(): void;
    /**
     * Clear the warned state for a session (called when the session ends
     * or when evidence of activity is observed).
     */
    clearWarned(agentId: string, sessionKey: string): void;
    /**
     * AI-1664: Record a proxy call as evidence that the agent started.
     * Satisfies the no-activity timer for the matched (agentId, ticketId) dispatch.
     * Silently ignored when ticketId cannot be normalized to a Linear identifier.
     */
    recordProxyActivity(agentId: string, ticketId: string): void;
    private getAgentMaxConcurrentValue;
    private handleAtCapacity;
    /**
     * Re-arm deferred at-capacity tickets when a session slot frees.
     * Call this after sessionTracker.endSession() for an agent.
     */
    checkDeferredOnSessionEnd(agentId: string): Promise<void>;
    /**
     * Run one detection cycle. Returns a summary of actions taken.
     */
    runCycle(): Promise<NoActivityCycleResult>;
    /**
     * Handle a no-activity failure: end session, classify, and either defer or escalate/re-dispatch.
     * Returns true if the ticket was deferred (agent alive but at capacity), false for hard failure.
     */
    private handleFailure;
}
//# sourceMappingURL=no-activity-detector.d.ts.map