/**
 * Phase 5 / B-3 — Managing barrier (N→1) + asymmetric shepherding + stall detection.
 *
 * Three subsystems:
 *
 *   1. **Barrier (N→1):** Event-driven — when the last linked child reaches a
 *      terminal state, the engine auto-advances the parent `managing → review`.
 *      No polling for done-ness (§5.3). Triggered by Linear webhook events.
 *
 *   2. **Asymmetric shepherding (§5.3):** Parent (researcher/engine) shepherds
 *      *down* — nudge/escalate stuck children; children never look *up*.
 *      The asymmetry is structural: children run `wf:dev-impl`, parents run
 *      `wf:ux-audit`. A dev-impl ticket has no legal command to address its
 *      parent. The parent's managing-wake already includes child-status checks;
 *      this module enriches it with stall-surface logic.
 *
 *   3. **Stall detection (§5.5 / §16.1):** Engine-owns-detection, parent-owns-response.
 *      Each state carries an optional time-in-state SLA (from workflow def YAML).
 *      When an outstanding child breaches its SLA, the engine emits a structured
 *      **StallEvent** against that child and its ancestor chain. The parent agent's
 *      managing-wake delivers the stall event — the parent decides the qualitative
 *      response (nudge, guidance, or escalation via barrier-level break-glass, §5.3).
 *
 *      **At-capacity ≠ stall.** A legitimately deferred/at-capacity child has its
 *      waiting time attributed up the ancestor SLA accounting as **known deferral**,
 *      so an overloaded-but-healthy subtree doesn't trip stall escalation while a
 *      genuinely stuck leaf still does.
 *
 * Design: design.md §5.3, §5.5, §14, §16.1.
 *
 * ACs:
 *   - Last child terminal → parent auto-moves managing → review (no manual nudge).
 *   - A deliberately stalled leaf produces a stall event to its parent.
 *   - An at-capacity-but-healthy subtree does NOT trip stall escalation.
 *   - Children cannot address the parent (asymmetry enforced).
 */
import { type WorkflowDef } from "./workflow-gate.js";
/** A child issue's resolved state for barrier evaluation. */
export interface ChildState {
    identifier: string;
    /** Labels on the child issue. */
    labels: string[];
    /** Whether the child is in a terminal workflow state. */
    isTerminal: boolean;
    /** The child's workflow state (from state:* label), or null. */
    workflowState: string | null;
}
/** Result of a barrier evaluation. */
export interface BarrierResult {
    /** All children are terminal — barrier is satisfied. */
    allTerminal: boolean;
    /** Total number of children. */
    totalChildren: number;
    /** Number of children in terminal states. */
    terminalCount: number;
    /** Details of each child. */
    children: ChildState[];
}
/** Result of a barrier auto-transition attempt. */
export interface BarrierTransitionResult {
    /** Whether the parent was successfully transitioned. */
    transitioned: boolean;
    /** Parent issue identifier. */
    parentIdentifier: string;
    /** Number of children that were terminal. */
    terminalCount: number;
    /** Number of children total. */
    totalChildren: number;
    /** Error message if transition failed. */
    error?: string;
}
/** Configuration for stall detection. */
export interface StallDetectionConfig {
    /** How long (ms) a child must be idle in a non-terminal state before
     *  being considered stalled. Default: 30 min. */
    stallThresholdMs: number;
    /** How often (ms) to check for stalled children. Default: 10 min. */
    pollIntervalMs: number;
}
/** A stalled child surfaced by stall detection. */
export interface StalledChild {
    identifier: string;
    parentIdentifier: string;
    currentState: string | null;
    /** Epoch ms of last activity on this child. */
    lastActivityAt: number | null;
    /** How long (ms) the child has been idle. */
    idleDurationMs: number;
    /** Epoch ms when the child entered its current state (from Linear history). */
    stateEnteredAt: number | null;
    /** Per-state SLA in ms from the workflow definition, or null if no SLA defined. */
    stateSlaMs: number | null;
    /** How long (ms) the child has been in its current state. */
    timeInStateMs: number;
    /** Known-deferral time (ms) attributed to this child's ancestor chain. */
    knownDeferralMs: number;
    /** Whether this child is classified as at-capacity (deferred but healthy). */
    isDeferredAtCapacity: boolean;
}
/**
 * A structured stall event emitted by the engine when a child breaches its
 * per-state SLA. Delivered to the parent agent via the managing-wake flow.
 *
 * The engine detects; the parent agent decides the qualitative response.
 */
export interface StallEvent {
    /** The child that breached its SLA. */
    childIdentifier: string;
    /** The parent that receives the stall event. */
    parentIdentifier: string;
    /** The child's current workflow state. */
    currentState: string;
    /** How long the child has been in this state (ms). */
    timeInStateMs: number;
    /** The per-state SLA (ms) from the workflow definition. */
    slaMs: number;
    /** How far past the SLA the child is (ms). */
    breachMs: number;
    /** Known-deferral time accounted for (at-capacity, §16.1). */
    knownDeferralMs: number;
    /** Whether the child is at-capacity (deferred but healthy). */
    isDeferredAtCapacity: boolean;
    /** When the stall event was created (epoch ms). */
    createdAt: number;
}
/**
 * In-memory accounting of known-deferral time per (agent, ticket).
 *
 * When a child is at-capacity (legitimately deferred, per AI-1339), its
 * waiting time is tracked here so the stall detection can subtract it from
 * the SLA clock. An overloaded-but-healthy subtree does NOT trip stall
 * escalation while a genuinely stuck leaf still does.
 */
export declare class DeferralAccountant {
    private deferrals;
    /** Start tracking deferral for a child. */
    startDeferral(childIdentifier: string, now?: number): void;
    /** Stop tracking deferral for a child (e.g., when it becomes active again). */
    stopDeferral(childIdentifier: string, now?: number): number;
    /** Get the total known-deferral time for a child (ms). */
    getDeferralMs(childIdentifier: string, now?: number): number;
    /** Check if a child is currently in deferral. */
    isDeferring(childIdentifier: string): boolean;
    /** Clear all deferral state. */
    clearAll(): void;
}
export declare const deferralAccountant: DeferralAccountant;
/**
 * Is a child in a terminal state based on its labels?
 * Terminal states: done, escape (from the ux-audit and dev-impl workflow defs).
 * Also checks if the child has a `state:*` label matching a terminal state.
 */
export declare function isChildTerminal(labels: string[]): boolean;
/**
 * Determine if a workflow state is terminal.
 */
export declare function isTerminalState(stateName: string): boolean;
/**
 * Fetch the parent issue's identifier for a given child issue.
 * Returns null if the child has no parent.
 */
export declare function fetchParentIdentifier(childIdentifier: string, authToken: string): Promise<string | null>;
/**
 * Fetch all children of a parent issue with their labels.
 * Returns the children's identifiers and label names.
 */
export declare function fetchChildren(parentIdentifier: string, authToken: string): Promise<ChildState[]>;
/**
 * Evaluate whether the barrier is satisfied for a parent in `managing` state.
 *
 * Fetches all children of the parent and checks if every one has reached
 * a terminal workflow state. Returns the evaluation result.
 *
 * This is a pure evaluation — it does not mutate anything.
 */
export declare function evaluateBarrier(parentIdentifier: string, authToken: string): Promise<BarrierResult>;
/**
 * Attempt to auto-advance the parent from `managing → review` when the
 * barrier is satisfied (all children terminal).
 *
 * Steps:
 *   1. Evaluate the barrier — are all children terminal?
 *   2. Verify the parent is in `managing` state.
 *   3. Atomically swap state:managing → state:review.
 *   4. Post a barrier-summary comment on the parent.
 *
 * Returns the result of the transition attempt.
 * Fail-open: any error is logged and returned — callers should not retry.
 *
 * AC1: Last child terminal → parent auto-moves managing → review with no
 *      manual nudge.
 */
export declare function attemptBarrierTransition(parentIdentifier: string, authToken: string, workflowDef?: WorkflowDef, prefetchedParentState?: {
    labels: string[];
    internalId: string;
    teamId: string;
} | null): Promise<BarrierTransitionResult>;
/**
 * Main entry point for the webhook-driven barrier check.
 *
 * Call this when a child issue reaches a terminal state. It:
 *   1. Finds the parent issue.
 *   2. If the parent is in `managing` state on `ux-audit` workflow,
 *      evaluates the barrier.
 *   3. If all children are terminal, auto-transitions to `review`.
 *
 * Returns true if a barrier transition was attempted (whether successful or not).
 * Returns false if the barrier was not applicable (no parent, not managing, etc.)
 */
export declare function onChildTerminal(childIdentifier: string, authToken: string): Promise<BarrierTransitionResult | null>;
export type { LabelNode } from "./linear-helpers.js";
/**
 * Build a shepherding message for the parent's owner about child status.
 *
 * The parent (researcher/engine) shepherds DOWN — nudges/escalates stuck
 * children. Children never look UP (§5.3). The asymmetry is structural:
 * children run wf:dev-impl which has no command to address the parent.
 *
 * This function builds the message surfaced to the parent owner during
 * a stewardship wake, listing child states and surfacing any stalled ones.
 */
export declare function buildShepherdingMessage(parentIdentifier: string, children: ChildState[], stalledChildren: StalledChild[]): string;
/**
 * Enforce asymmetry: check if a given issue is a child of a ux-audit parent.
 * Returns true if the issue is a child that should NOT be able to address
 * its parent. Used by the workflow-gate to block upward-directed commands.
 *
 * §5.3: children never look up. A child running wf:dev-impl cannot issue
 * commands targeting the parent's ux-audit workflow.
 */
export declare function isChildOfUxAuditParent(issueIdentifier: string, authToken: string): Promise<boolean>;
/**
 * Detect stalled children of a parent issue in `managing` state.
 *
 * Phase 6.5 / H-3 (AI-1478): Engine-owns-detection split.
 *
 * A child is stalled when ALL of the following are true:
 *   - It is in a non-terminal state.
 *   - It has been in its current state longer than the per-state SLA
 *     (from the workflow definition YAML), MINUS any known-deferral time.
 *   - It is NOT classified as at-capacity (deferred but healthy).
 *
 * At-capacity children (§16.1) have their waiting time attributed as
 * known deferral so they do NOT trip stall escalation. Genuinely stuck
 * leaves that are NOT at-capacity still do.
 *
 * Returns the list of stalled children with StallEvent data.
 *
 * AC1: A deliberately stalled leaf produces a stall event to its parent.
 * AC2: An at-capacity-but-healthy subtree does NOT trip stall escalation.
 */
export declare function detectStalledChildren(parentIdentifier: string, authToken: string, stallThresholdMs?: number, now?: number, workflowDef?: WorkflowDef, accountant?: DeferralAccountant): Promise<StalledChild[]>;
/**
 * Build a StallEvent from a StalledChild.
 *
 * The engine emits this structured event; the parent agent decides the response.
 */
export declare function buildStallEvent(child: StalledChild, now?: number): StallEvent;
/**
 * Surface stalled children by emitting stall events to the parent.
 *
 * Phase 6.5 / H-3 (AI-1478): Engine detects stall → emits StallEvent(s) →
 * parent agent responds via managing-wake flow.
 *
 * Posts a tripwire comment on the parent ticket with structured stall data.
 * Returns the list of StallEvents for downstream delivery (managing-wake).
 */
export declare function surfaceStalledChildren(parentIdentifier: string, authToken: string, stallThresholdMs?: number): Promise<{
    surfaced: number;
    events: StallEvent[];
}>;
/**
 * Parse stall detection config from environment variables.
 */
export declare function parseStallConfig(): StallDetectionConfig;
//# sourceMappingURL=barrier.d.ts.map