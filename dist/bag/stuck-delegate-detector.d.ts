/**
 * StuckDelegateDetector — re-prompt delegates who posted completion comments
 * without running the transition verb.
 *
 * Problem (AI-1451 / parent AI-1443): An implementer authors correct code,
 * posts a prose "B-1 Complete" comment, but never runs `linear submit`. The
 * ticket sits in `state:implementation`, assigned to the implementer, and
 * the next heartbeat rationalizes it as "waiting for review" → HEARTBEAT_OK.
 * The queue stalls silently.
 *
 * This detector closes the gap by:
 *   1. Periodically scanning for workflow tickets in non-terminal states
 *      where the delegate has gone idle (no session active for that ticket).
 *   2. For each candidate, checking whether a comment was posted by the
 *      delegate after the state was entered, but no transition verb has
 *      fired since.
 *   3. When the pattern matches, re-prompting the delegate with the exact
 *      legal-command block for the current state instead of allowing
 *      HEARTBEAT_OK.
 *
 * This is distinct from:
 *   - NoActivityDetector (sessions that never started)
 *   - StaleSessionForensics (sessions that timed out)
 *   - ManagingPoller (periodic stewardship wakes for managing state)
 *
 * This detector catches the "I said I'm done but forgot to press the button"
 * pattern — the delegate's session has ended naturally, but the state machine
 * is stuck because the transition verb was never run.
 *
 * Configuration (env vars, all optional):
 *   STUCK_DELEGATE_POLL_MS          — check interval (default: 5 min)
 *   STUCK_DELEGATE_IDLE_GRACE_MS    — how long a delegate must be idle before
 *                                     triggering (default: 3 min)
 *   STUCK_DELEGATE_MAX_PROMPTS      — max re-prompts per ticket (default: 2)
 */
import { type AgentConfig } from "../agents.js";
import { type WorkflowDef } from "../workflow-gate.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { SessionTracker } from "./session-tracker.js";
import type { PendingWorkBag } from "./pending-work-bag.js";
import { type DeliveryConfig } from "../delivery/index.js";
import type { DispatchAckTracker } from "./dispatch-ack-tracker.js";
export interface StuckDelegateConfig {
    /** How often to check for stuck delegates. Default: 5 min. */
    pollMs: number;
    /** How long a delegate must be idle before triggering. Default: 3 min. */
    idleGraceMs: number;
    /** Max re-prompts per ticket. Default: 2. */
    maxPrompts: number;
    /**
     * Treat a ticket as having an active session if a pending dispatch ack exists
     * within this threshold (ms). Guards against re-dispatching sessions that are
     * still running but whose in-memory SessionTracker was lost to a restart.
     * Default: 10 min. Set to 0 to disable.
     */
    sessionActiveThresholdMs: number;
}
export interface StuckDelegateDeps {
    sessionTracker: SessionTracker;
    bag: PendingWorkBag;
    operationalEventStore: OperationalEventStore;
    /** Delivery config for sending re-prompt messages to agents. */
    deliveryConfig: DeliveryConfig;
    /** Persisted dispatch ack tracker (SQLite). Survives restarts. Optional for backward compat. */
    ackTracker?: DispatchAckTracker;
    /** Deliver a re-prompt wake signal to the agent. */
    sendWake?: (agentOpenclawName: string, ticketId: string, prompt: string) => Promise<boolean>;
    /** Overridable for testing. */
    listAgents?: () => AgentConfig[];
    /** Overridable for testing. */
    now?: () => number;
    /** Overridable for testing. */
    fetchStuckCandidates?: (agent: AgentConfig) => Promise<StuckCandidate[]>;
    /** Overridable for testing — loads workflow def. */
    loadDef?: () => Promise<WorkflowDef>;
}
export interface StuckCandidate {
    identifier: string;
    currentState: string;
    labels: string[];
    delegateId: string;
    /** ISO timestamp of the most recent state:* label change (updatedFrom). */
    stateEnteredAt: string | null;
    /** ISO timestamps of comments posted by the delegate after state entry. */
    delegateComments: Array<{
        id: string;
        createdAt: string;
        body: string;
    }>;
    /** ISO timestamps of transition verbs detected (state transitions in Linear history). */
    transitionsAfterEntry: Array<{
        from: string;
        to: string;
        at: string;
    }>;
}
export interface StuckDelegateCycleResult {
    agentsChecked: number;
    candidatesChecked: number;
    stuckFound: number;
    rePromptsSent: number;
    skippedAlreadyPrompted: number;
    /** Candidates skipped because a pending dispatch ack suggests the session is still active. */
    skippedSessionActive: number;
    errors: number;
}
/** Tracks how many times each ticket has been re-prompted. */
export declare class PromptCounter {
    private counts;
    increment(ticketId: string): number;
    get(ticketId: string): number;
    /** Clear prompt count for a ticket (e.g., when it transitions). */
    clear(ticketId: string): void;
    /** Clear all counts. */
    clearAll(): void;
}
/**
 * Build a targeted re-prompt for a stuck delegate. Includes the exact legal
 * commands for the current state, referencing the completion-comment-without-
 * transition failure mode.
 */
export declare function buildRePrompt(ticketId: string, currentState: string, def: WorkflowDef): string;
export declare class StuckDelegateDetector {
    private timer?;
    private config;
    private deps;
    /** Persisted ack tracker — optional, stored separately since it has no default fallback. */
    private ackTracker;
    private promptCounter;
    /** Tracks when sessions ended per (agent, sessionKey) for idle-grace calculation. */
    private sessionEndedAt;
    constructor(deps: StuckDelegateDeps, config?: Partial<StuckDelegateConfig>);
    start(): void;
    stop(): void;
    /**
     * Clear the prompt counter for a ticket. Called when a successful
     * transition is detected (the ticket is no longer stuck).
     */
    clearPromptCount(ticketId: string): void;
    /**
     * Run one detection cycle. For each agent, fetches workflow tickets in
     * non-terminal states where the delegate is idle, checks the stuck pattern,
     * and re-prompts as needed.
     */
    runCycle(): Promise<StuckDelegateCycleResult>;
}
//# sourceMappingURL=stuck-delegate-detector.d.ts.map