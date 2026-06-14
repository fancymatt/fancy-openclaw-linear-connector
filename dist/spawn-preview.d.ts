/**
 * Phase 6.5 / H-2 — Spawn-preview gate + hard recursion caps (AI-1477).
 *
 * Design: design.md §5.2, §5.5, §16.1.
 *
 * Before a fan-out instantiates children, the engine emits a *proposed* child
 * list — count + each child's workflow and seed AC — for a steward/human glance
 * (the spawn-preview gate, §5.2). Instantiation proceeds from the preview.
 *
 * Hard caps (§5.5, §16.1) enforce safety ceilings at the fan-out edge:
 *   - max_children: per-spawn count cap — exceeding it is REFUSED, not truncated.
 *   - max_depth: recursion depth from root — prevents fork-bombing the tree.
 *   - approval_above: steward approval required above a child-count threshold.
 *
 * Caps compose with the preview: preview is the human glance; caps are the
 * hard ceiling the preview can't waive without an explicit steward override.
 *
 * ACs:
 *   1. A fan-out exceeding max_children is refused (not truncated).
 *   2. A spawn above approval_above waits for steward approval before instantiating.
 *   3. The preview shows the proposed child list before any child ticket exists.
 */
/** Configuration for spawn-preview caps. */
export interface SpawnCaps {
    /** Maximum number of children per spawn operation. Default: 20. */
    maxChildren: number;
    /** Maximum recursion depth from the root issue. Default: 3. */
    maxDepth: number;
    /** Child count above which steward approval is required. Default: 10. */
    approvalAbove: number;
}
/** A single proposed child in the preview. */
export interface ProposedChild {
    /** Index in the findings list (0-based). */
    index: number;
    /** Short title / summary of the proposed child. */
    title: string;
    /** Description (optional). */
    description?: string;
    /** Workflow the child will be created with (always dev-impl). */
    workflow: string;
    /** Seed acceptance criteria extracted from the finding. */
    seedAc: string;
}
/** The spawn-preview — emitted before instantiation. */
export interface SpawnPreview {
    /** The parent issue identifier. */
    parentIssueId: string;
    /** Total number of proposed children. */
    childCount: number;
    /** The proposed children. */
    children: ProposedChild[];
    /** Current depth of the parent in the tree (0 = root). */
    currentDepth: number;
    /** Whether this spawn requires steward approval. */
    requiresApproval: boolean;
    /** Cap check result. */
    capResult: CapCheckResult;
}
/** Result of checking caps against a proposed spawn. */
export interface CapCheckResult {
    /** Whether the spawn is allowed under current caps. */
    allowed: boolean;
    /** Reason for refusal, if not allowed. */
    refusalReason?: string;
    /** Whether steward approval is required. */
    needsApproval: boolean;
    /** The caps that were evaluated. */
    caps: SpawnCaps;
    /** The depth of the current issue in the tree. */
    depth: number;
    /** The proposed child count. */
    proposedCount: number;
}
/** Result of generating a spawn preview. */
export interface PreviewResult {
    /** The preview, if generation succeeded. */
    preview: SpawnPreview | null;
    /** Error message if generation failed. */
    error?: string;
}
export declare const DEFAULT_SPAWN_CAPS: SpawnCaps;
/**
 * Parse spawn caps from environment variables.
 * Allows runtime configuration without code changes.
 */
export declare function parseSpawnCaps(): SpawnCaps;
/**
 * Compute the depth of an issue in the parent-child tree.
 *
 * Walks up the parent chain via Linear API to count how many levels deep
 * the issue is. Root issues (no parent) have depth 0.
 *
 * This is the §16.1 recursion depth cap: a fan-out at depth >= maxDepth
 * is refused to prevent fork-bombing the tree.
 */
export declare function resolveDepth(issueId: string, authToken: string): Promise<number>;
/**
 * Check whether a proposed spawn is allowed under the current caps.
 *
 * Returns a CapCheckResult indicating:
 *   - Whether the spawn is allowed (allowed: true/false).
 *   - If not allowed, the reason (refusalReason).
 *   - Whether steward approval is required (needsApproval).
 *
 * AC1: A fan-out exceeding max_children is refused (not truncated).
 * AC2: A spawn above approval_above requires steward approval.
 */
export declare function checkCaps(proposedCount: number, currentDepth: number, caps?: SpawnCaps): CapCheckResult;
export interface FindingInput {
    title: string;
    description?: string;
}
/**
 * Generate a spawn-preview for a proposed fan-out.
 *
 * This is the §5.2 spawn-preview gate: before any child ticket is created,
 * the engine emits the proposed child list so a steward/human can glance at it.
 *
 * Steps:
 *   1. Resolve the current depth of the parent in the tree.
 *   2. Build the proposed child list from the findings.
 *   3. Check caps against the proposed spawn.
 *   4. Return the preview with cap check results.
 *
 * The caller (workflow-gate's fan-out path) uses this to:
 *   - Refuse the spawn if caps are violated (AC1).
 *   - Require steward approval if approval_above is triggered (AC2).
 *   - Post the preview as a comment for human visibility (AC3).
 */
export declare function generateSpawnPreview(parentIssueId: string, authToken: string, findings: FindingInput[], caps?: SpawnCaps): Promise<PreviewResult>;
/**
 * Format a spawn-preview as a human-readable comment body.
 *
 * This is posted on the parent ticket so the steward/human can review
 * the proposed child list before instantiation proceeds.
 */
export declare function formatPreviewComment(preview: SpawnPreview): string;
/**
 * Format a cap-refusal as a rejection comment body.
 */
export declare function formatCapRefusalComment(capResult: CapCheckResult, parentIssueId: string): string;
//# sourceMappingURL=spawn-preview.d.ts.map