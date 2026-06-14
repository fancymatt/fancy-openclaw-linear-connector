/**
 * Phase 5 / B-4 — Disposition review + parent-AC gate (F2b, §5.6).
 *
 * When the managing barrier fires and all children reach terminal state, the
 * parent transitions managing → review (done in B-3). This module handles
 * the **disposition** from review:
 *
 *   1. `→ done` (terminal) — gated on the **parent's own** AC being satisfied.
 *      The parent scope is NOT the sum of its children (the F2b fix, §5.6).
 *      The researcher must confirm that the parent issue's acceptance criteria
 *      are met independently of child completion.
 *
 *   2. `→ spawning` (follow-ups for gaps) — when the researcher identifies
 *      gaps that need additional children. Re-enters the spawning state to
 *      mint supplementary dev-impl tickets.
 *
 *   3. `→ escape` (break-glass) — always available per §4.4.
 *
 * Design: design.md §5.6, §14, §11 Phase 5 milestone.
 *
 * ACs:
 *   - managing barrier exits to review (disposition), not done. (B-3 — verified here)
 *   - From review the researcher dispositions: → done | → spawning | → escape.
 *   - → done is gated on the parent's own AC — not the sum of children (§5.6).
 */
/** Result of a parent-AC gate evaluation. */
export interface ParentAcGateResult {
    /** Whether the parent's own AC is satisfied. */
    satisfied: boolean;
    /** The parent issue identifier. */
    parentIdentifier: string;
    /** Reason for pass/fail. */
    reason: string;
    /** The parent's AC checklist items and their checked status, if available. */
    checklist?: AcChecklistItem[];
}
/** A single AC checklist item parsed from the issue description. */
export interface AcChecklistItem {
    /** The AC text. */
    text: string;
    /** Whether the checkbox is checked. */
    checked: boolean;
}
/** Result of a disposition attempt. */
export interface DispositionResult {
    /** Whether the disposition was applied. */
    applied: boolean;
    /** The disposition target state. */
    targetState: "done" | "spawning" | "escape";
    /** The parent issue identifier. */
    parentIdentifier: string;
    /** Error message if the disposition failed. */
    error?: string;
}
/**
 * Parse acceptance criteria from the issue description.
 *
 * Looks for Markdown checkboxes in the description:
 *   - [x] AC item text
 *   - [ ] Unchecked item
 *
 * Also supports "## Acceptance criteria" section with list items:
 *   ## Acceptance criteria
 *   - [x] First criterion
 *   - [ ] Second criterion
 *
 * Returns the list of parsed items, or an empty array if none found.
 */
export declare function parseAcChecklist(description: string | null | undefined): AcChecklistItem[];
/**
 * Evaluate whether all acceptance criteria items in the checklist are checked.
 *
 * Returns { satisfied: true } only when:
 *   - At least one checklist item exists AND
 *   - Every item is checked.
 *
 * Returns { satisfied: false } when any item is unchecked or no items found.
 * The F2b fix (§5.6): this checks the **parent's own** AC, not the sum of
 * children. Even if all children are done, the parent's own AC might not be
 * satisfied (e.g., the parent's scope includes cross-cutting concerns that
 * no single child covers).
 */
export declare function evaluateAcGate(items: AcChecklistItem[]): {
    satisfied: boolean;
    reason: string;
};
/**
 * Evaluate the parent-AC gate for a ticket in `review` state.
 *
 * The F2b fix (§5.6): the parent's → done transition is gated on the **parent's
 * own** AC, not the sum of its children. This function fetches the parent's
 * description, parses the AC checklist, and verifies all items are checked.
 *
 * AC3: → done is gated on the parent's own AC being satisfied.
 */
export declare function evaluateParentAcGate(parentIdentifier: string, authToken: string): Promise<ParentAcGateResult>;
/**
 * Attempt the `review → done` disposition.
 *
 * AC3: The → done transition is gated on the parent's own AC being satisfied.
 * If the AC gate fails, the transition is blocked and a diagnostic comment
 * is posted on the issue explaining which ACs are unmet.
 *
 * If the AC gate passes:
 *   1. Atomically swap state:review → state:done.
 *   2. Post a disposition summary comment.
 *
 * Returns the result of the disposition attempt.
 */
export declare function dispositionToDone(parentIdentifier: string, authToken: string): Promise<DispositionResult>;
/**
 * Attempt the `review → spawning` disposition for follow-up gaps.
 *
 * AC2: From review, the researcher can disposition → spawning to create
 * follow-up children for gaps found during review. Re-enters the spawning
 * state so the fan-out engine can mint supplementary dev-impl tickets.
 *
 * Steps:
 *   1. Atomically swap state:review → state:spawning.
 *   2. Post a disposition comment noting the follow-up.
 *
 * The fan-out engine will trigger on the spawning transition as before.
 */
export declare function dispositionToSpawning(parentIdentifier: string, authToken: string): Promise<DispositionResult>;
/**
 * Determine if the disposition should trigger for a given workflow + state + command.
 *
 * Returns the target disposition state ("done" | "spawning") when the command
 * maps to a known disposition, or null if:
 *   - The workflow is not ux-audit
 *   - The current state is not review
 *   - The intent is "escape" (falls through to the standard atomic swap path)
 *   - The intent is unrecognized
 *
 * Callers that receive null should delegate to the standard atomic label swap
 * logic — the disposition engine does not handle those paths.
 */
export declare function resolveDisposition(workflowId: string, currentState: string, intent: string): "done" | "spawning" | null;
//# sourceMappingURL=review.d.ts.map