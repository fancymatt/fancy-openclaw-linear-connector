/**
 * AI-1594 — Governed state:* regression guard.
 *
 * AC3: A stale webhook carrying an older state:* label set must NOT cause the
 *      connector to treat the ticket as regressed. The StateHighWaterMarkTracker
 *      records the furthest state each ticket has reached (per B2 apply); the
 *      webhook handler checks detectStateRegression before running role-guard
 *      delegate correction.
 *
 * AC4: detectStateRegression emits a structured warning when a backwards
 *      label transition is observed without a corresponding B2 apply.
 */
import type { WorkflowDef } from "./workflow-gate.js";
export interface StateRegressionResult {
    isRegression: boolean;
    observedState?: string;
    lastKnownState?: string;
    warning?: string;
}
export interface StateHighWaterMarkTracker {
    getLastKnownState(ticketId: string): string | null;
    /** Records a B2-confirmed state advance. Returns true when the proposed state
     *  is backwards relative to the stored high-water mark (regression signal). */
    advance(ticketId: string, state: string): boolean;
}
/**
 * Returns the topological rank of `stateId` in the workflow's forward path via
 * BFS from entry_state. Returns null for states unreachable via normal
 * forward transitions (break-glass terminals, unknown state ids).
 */
export declare function rankStateInWorkflow(stateId: string, def: WorkflowDef): number | null;
/**
 * Returns true when `observedState` ranks strictly before `lastKnownState`
 * in the forward path (i.e. the observed state is a regression).
 * Fails open (returns false) when either state is unknown to the workflow.
 */
export declare function isStateBackwards(observedState: string, lastKnownState: string, def: WorkflowDef): boolean;
/**
 * Checks whether the `state:*` label in `labels` represents a regression
 * relative to `lastKnownState`. Callers must skip delegate-correction logic
 * when `isRegression` is true (AC3) and emit the `warning` string (AC4).
 *
 * Fails open (no regression) when:
 *   - lastKnownState is null (ticket freshly seen, no basis for comparison)
 *   - labels carry no `wf:*` label (ad-hoc ticket)
 *   - labels carry no `state:*` label (enrollment-gap ticket)
 */
export declare function detectStateRegression(ticketId: string, labels: string[], lastKnownState: string | null, def: WorkflowDef): StateRegressionResult;
/**
 * Creates a per-ticket monotonic high-water-mark tracker. When `def` is
 * provided, `advance` uses workflow ranking to reject backwards moves. Without
 * `def`, all advances are accepted (fail open — no regression detection).
 */
export declare function createStateHighWaterMarkTracker(def?: WorkflowDef): StateHighWaterMarkTracker;
/**
 * Process-wide singleton tracker shared between the B2 proxy path (advance)
 * and the webhook delivery path (regression check). Created without a def
 * because the B2 path is always authoritative forward motion — regression
 * detection uses detectStateRegression separately with the loaded def.
 */
export declare const sharedStateTracker: StateHighWaterMarkTracker;
//# sourceMappingURL=state-regression.d.ts.map