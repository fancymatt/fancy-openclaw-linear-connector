/**
 * Phase 5 / B-2 — Fan-out edge: spawning 1→N (AI-1439).
 *
 * Engine logic for the fan-out. On the researcher's `auditing → spawning` submit,
 * the findings list is the runtime cardinality (§5.2): the engine creates N
 * `dev-impl` children, links each to the parent, and transitions the parent → `managing`.
 *
 * Design: design.md §5.2, §5.4, §14.
 *
 * ACs:
 *   1. `submit` from `auditing` carries the findings list; engine mints N `dev-impl`
 *      children (each at `state:intake`, wf:dev-impl), one per finding.
 *   2. Each child is linked to the parent (parent/child relation set).
 *   3. Parent auto-transitions to `managing` once children are minted.
 *   4. A child may itself be an orchestrator — minting is uniform regardless (§5.4);
 *      no special-casing.
 *
 * This module is called from workflow-gate's applyStateTransition when the `spawn`
 * command is processed for a ux-audit ticket in the `spawning` state.
 */
import { type SpawnPreview, type SpawnCaps } from "./spawn-preview.js";
/** A single finding to fan out into its own child issue. */
export interface Finding {
    /** Short title / summary of the finding. */
    title: string;
    /** Detailed description (optional). */
    description?: string;
}
/** Result of a fan-out operation. */
export interface FanoutResult {
    /** Number of children successfully created. */
    created: number;
    /** Identifiers of created child issues (e.g. ["AI-1443", "AI-1444"]). */
    childIdentifiers: string[];
    /** Errors encountered during creation (non-fatal; partial success allowed). */
    errors: FanoutError[];
    /** Phase 6.5 / H-2: spawn-preview generated before instantiation. */
    preview: SpawnPreview | null;
    /** Phase 6.5 / H-2: whether the fan-out was refused by caps. */
    refused: boolean;
    /** Phase 6.5 / H-2: whether steward approval is pending. */
    pendingApproval: boolean;
}
export interface FanoutError {
    findingIndex: number;
    message: string;
}
/**
 * Parse findings from the ticket description.
 *
 * The researcher submits the findings list as part of the `complete-audit`
 * transition. The findings are embedded in the issue description in a structured
 * format. This parser extracts them.
 *
 * Expected format in the description (Markdown):
 * ```
 * ## Findings
 * - **Finding 1**: Short title
 * - **Finding 2**: Another title
 * ```
 *
 * Or as a structured block:
 * ```
 * ### Findings
 * 1. Title one
 * 2. Title two
 * 3. Title three
 * ```
 *
 * Falls back to line-by-line extraction if no structured block found.
 * Returns at least one finding (the ticket title itself as fallback) so the
 * fan-out always produces at least one child (§5.2).
 */
export declare function extractFindings(description: string | null | undefined, fallbackTitle: string): Finding[];
/**
 * Execute the fan-out: create N dev-impl children from the findings list.
 *
 * Called by the workflow engine when the `spawn` command is processed on a
 * ux-audit ticket in the `spawning` state.
 *
 * Steps:
 *   1. Fetch the parent issue's team, title, and description.
 *   2. Extract findings from the description.
 *   3. Ensure required labels exist (wf:dev-impl, state:intake).
 *   4. Create one child issue per finding, each linked to the parent.
 *   5. Return the result with created count and any partial errors.
 *
 * The caller (applyStateTransition) transitions the parent to `managing`
 * after a successful fan-out (or logs a warning on partial failure).
 *
 * AC4 (§5.4): Minting is uniform — children are always created as dev-impl
 * at intake, regardless of whether the child itself might be an orchestrator
 * archetype. No special-casing.
 */
export declare function executeFanout(parentIssueId: string, authToken: string, findingsOverride?: Finding[], options?: {
    caps?: SpawnCaps;
    skipPreview?: boolean;
}): Promise<FanoutResult>;
/**
 * Determine if the fan-out should be triggered for a given workflow + state + command.
 * Returns true when:
 *   - The workflow is ux-audit or sprint (any archetype that fans out 1→N)
 *   - The state is spawning
 *   - The command is spawn
 *
 * Phase 6 / C-3 (AI-1473): generalized from ux-audit-only to archetype-agnostic.
 * Both orchestrator (ux-audit) and feature-initiative (sprint) archetypes use
 * the same fan-out pattern: spawning state, spawn command → mint dev-impl children.
 */
export declare function shouldTriggerFanout(workflowId: string, currentState: string, intent: string): boolean;
//# sourceMappingURL=fanout.d.ts.map