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
import { componentLogger, createLogger } from "./logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "spawn-preview");
const LINEAR_API_URL = "https://api.linear.app/graphql";
// ── Defaults ──────────────────────────────────────────────────────────────
export const DEFAULT_SPAWN_CAPS = {
    maxChildren: 20,
    maxDepth: 3,
    approvalAbove: 10,
};
/**
 * Parse spawn caps from environment variables.
 * Allows runtime configuration without code changes.
 */
export function parseSpawnCaps() {
    const maxChildren = parseInt(process.env.SPAWN_CAP_MAX_CHILDREN ?? "", 10);
    const maxDepth = parseInt(process.env.SPAWN_CAP_MAX_DEPTH ?? "", 10);
    const approvalAbove = parseInt(process.env.SPAWN_CAP_APPROVAL_ABOVE ?? "", 10);
    return {
        maxChildren: isNaN(maxChildren) || maxChildren <= 0 ? DEFAULT_SPAWN_CAPS.maxChildren : maxChildren,
        maxDepth: isNaN(maxDepth) || maxDepth <= 0 ? DEFAULT_SPAWN_CAPS.maxDepth : maxDepth,
        approvalAbove: isNaN(approvalAbove) || approvalAbove <= 0 ? DEFAULT_SPAWN_CAPS.approvalAbove : approvalAbove,
    };
}
// ── Depth resolution ──────────────────────────────────────────────────────
/**
 * Compute the depth of an issue in the parent-child tree.
 *
 * Walks up the parent chain via Linear API to count how many levels deep
 * the issue is. Root issues (no parent) have depth 0.
 *
 * This is the §16.1 recursion depth cap: a fan-out at depth >= maxDepth
 * is refused to prevent fork-bombing the tree.
 */
export async function resolveDepth(issueId, authToken) {
    let depth = 0;
    let currentId = issueId;
    // Safety limit to prevent infinite loops on corrupted data
    const MAX_WALK = 50;
    for (let i = 0; i < MAX_WALK && currentId; i++) {
        const parentId = await fetchParentId(currentId, authToken);
        if (!parentId)
            break;
        depth++;
        currentId = parentId;
    }
    return depth;
}
/**
 * Fetch the parent issue's identifier for a given issue.
 * Returns null if the issue has no parent.
 */
async function fetchParentId(issueId, authToken) {
    const query = `
    query IssueParent($id: String!) {
      issue(id: $id) {
        parent { identifier }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: issueId } }),
        });
        const data = (await res.json());
        return data.data?.issue?.parent?.identifier ?? null;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`spawn-preview: failed to fetch parent for ${issueId}: ${msg}`);
        return null;
    }
}
// ── Cap enforcement ───────────────────────────────────────────────────────
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
export function checkCaps(proposedCount, currentDepth, caps = DEFAULT_SPAWN_CAPS) {
    const result = {
        allowed: true,
        needsApproval: false,
        caps,
        depth: currentDepth,
        proposedCount,
    };
    // Hard cap: max_depth (§16.1)
    if (currentDepth >= caps.maxDepth) {
        result.allowed = false;
        result.refusalReason =
            `Recursion depth cap exceeded: current depth ${currentDepth} >= max_depth ${caps.maxDepth}. ` +
                `Fan-out refused to prevent fork-bombing the tree.`;
        log.warn(`spawn-preview: DEPTH CAP — depth ${currentDepth} >= max_depth ${caps.maxDepth}, refusing spawn of ${proposedCount} children`);
        return result;
    }
    // Hard cap: max_children (§5.5)
    if (proposedCount > caps.maxChildren) {
        result.allowed = false;
        result.refusalReason =
            `Child count cap exceeded: proposed ${proposedCount} children > max_children ${caps.maxChildren}. ` +
                `Fan-out REFUSED (not truncated) per §5.5.`;
        log.warn(`spawn-preview: CHILDREN CAP — proposed ${proposedCount} > max_children ${caps.maxChildren}, refusing`);
        return result;
    }
    // Soft gate: approval_above (§5.2)
    if (proposedCount > caps.approvalAbove) {
        result.needsApproval = true;
        log.info(`spawn-preview: APPROVAL GATE — proposed ${proposedCount} > approval_above ${caps.approvalAbove}, steward approval required`);
    }
    return result;
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
export async function generateSpawnPreview(parentIssueId, authToken, findings, caps = DEFAULT_SPAWN_CAPS) {
    // 1. Resolve depth
    const depth = await resolveDepth(parentIssueId, authToken);
    log.info(`spawn-preview: parent ${parentIssueId} is at depth ${depth}`);
    // 2. Build proposed children
    const proposedChildren = findings.map((f, i) => ({
        index: i,
        title: f.title,
        description: f.description,
        workflow: "dev-impl",
        // Seed AC: derive from the finding title + description
        seedAc: f.description
            ? `${f.title}: ${f.description}`
            : f.title,
    }));
    // 3. Check caps
    const capResult = checkCaps(proposedChildren.length, depth, caps);
    // 4. Build preview
    const preview = {
        parentIssueId,
        childCount: proposedChildren.length,
        children: proposedChildren,
        currentDepth: depth,
        requiresApproval: capResult.needsApproval,
        capResult,
    };
    log.info(`spawn-preview: generated preview for ${parentIssueId} — ` +
        `${proposedChildren.length} proposed children, depth=${depth}, ` +
        `allowed=${capResult.allowed}, needsApproval=${capResult.needsApproval}`);
    return { preview };
}
/**
 * Format a spawn-preview as a human-readable comment body.
 *
 * This is posted on the parent ticket so the steward/human can review
 * the proposed child list before instantiation proceeds.
 */
export function formatPreviewComment(preview) {
    const lines = [
        `[Spawn Preview] Proposed fan-out for ${preview.parentIssueId}:`,
        "",
        `**Proposed children:** ${preview.childCount}`,
        `**Tree depth:** ${preview.currentDepth}`,
        "",
    ];
    for (const child of preview.children) {
        lines.push(`${child.index + 1}. **${child.title}** (wf:${child.workflow})`);
        if (child.description) {
            lines.push(`   _${child.description}_`);
        }
    }
    lines.push("");
    if (!preview.capResult.allowed) {
        lines.push(`🚫 **REFUSED:** ${preview.capResult.refusalReason}`);
    }
    else if (preview.requiresApproval) {
        lines.push(`⚠️ **Steward approval required** (proposed ${preview.childCount} children > approval_above ${preview.capResult.caps.approvalAbove}).`);
        lines.push(`A steward must approve this fan-out before children are instantiated.`);
    }
    else {
        lines.push(`✅ Preview generated — fan-out will proceed.`);
    }
    return lines.join("\n");
}
/**
 * Format a cap-refusal as a rejection comment body.
 */
export function formatCapRefusalComment(capResult, parentIssueId) {
    const lines = [
        `[Spawn Refused] Fan-out for ${parentIssueId} blocked by hard cap:`,
        "",
    ];
    if (capResult.refusalReason) {
        lines.push(`🚫 ${capResult.refusalReason}`);
    }
    lines.push("");
    lines.push(`Caps in effect: max_children=${capResult.caps.maxChildren}, max_depth=${capResult.caps.maxDepth}, approval_above=${capResult.caps.approvalAbove}`);
    lines.push(`Proposed: ${capResult.proposedCount} children at depth ${capResult.depth}.`);
    lines.push("");
    lines.push("A steward can override via break-glass if this refusal is in error.");
    return lines.join("\n");
}
//# sourceMappingURL=spawn-preview.js.map