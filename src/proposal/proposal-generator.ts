/**
 * AI-2038 (P4-C3) — Proposal generation engine: deterministic, rule-based.
 *
 * Given failure clusters from C2 (AI-2037, AC2.1), emit concrete guidance/schema
 * edit proposals for human review. Pure and rule-based: no ML, no clock, no RNG.
 * The same input cluster always renders a byte-identical proposal (AC3.2).
 *
 * AC3.1 — the amended `targets[]` core. A single (workflow_id, state_id) fix can
 * touch more than one on-disk surface (its step-guidance `.md` AND its workflow
 * YAML def), so a proposal carries a NON-EMPTY `targets[]` array rather than the
 * superseded flat oldContent/newContent/diff. Each target is
 * {kind, path, old_content:{hash,snapshot}, new_content, diff}; `kind` is emitted
 * by the fired rule template (via the surface) and is NEVER inferred by consumers
 * from the path or file extension.
 *
 * AC3.5 — multi-workflow findings produce separate proposals per workflow, never
 * one combined proposal. `targets[]` groups the files touched WITHIN a single
 * (workflow, state); it is not a back door to a cross-workflow merge. Clusters
 * that share a (workflow, state) but differ by reasonCode merge into ONE
 * proposal whose evidence counts are keyed by reasonCode and whose failureCount
 * is the sum. Clusters in different workflows never merge.
 *
 * The deterministic core carries NO lifecycle fields (id/status/timestamps) —
 * those belong to the stored record (see proposal-store.ts). A timestamp in here
 * would break AC3.2.
 */

import { createHash } from "node:crypto";

const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Byte-order (utf-8) path comparison — the AC's "sorted ascending by path". */
function byPathBytes(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

export type TargetKind = "guidance" | "yaml";

/**
 * A failure cluster produced by C2 (AI-2037, AC2.1). The generator consumes it
 * verbatim — it never derives ticket ids itself. `step` is C2's name for what
 * this engine surfaces as `stateId`.
 */
export interface FailureCluster {
  workflow: string;
  step: string;
  reasonCode: string;
  count: number;
  fromBody?: string;
  exceedsThreshold: boolean;
  ticketIds: string[];
}

/**
 * The mutation surfaces the fired rule template selects for a (workflowId,
 * stateId) — each with its canonical on-disk path, `kind` (from the template,
 * NOT sniffed from the extension) and current content. One (workflow, state) can
 * expose both a guidance file and a YAML def, so the generator emits one target
 * per surface. An EMPTY array means no editable surface exists (e.g. the guidance
 * file is absent) → the generator skips the cluster and emits no proposal
 * (steward ruling, AI-2038 16:12Z).
 */
export interface EditableSurface {
  kind: TargetKind;
  path: string;
  content: string;
}

export interface GenerationContext {
  readSurfaces(workflowId: string, stateId: string): EditableSurface[];
}

export interface ProposalTarget {
  kind: TargetKind;
  path: string;
  oldContent: { hash: string; snapshot: string };
  newContent: string;
  diff: string;
}

export interface GeneratedProposal {
  workflowId: string;
  stateId: string;
  targets: ProposalTarget[];
  confidenceScore: number;
  evidenceCluster: { ticketIds: string[]; counts: Record<string, number> };
  failureCount: number;
  version: number;
  idempotencyKey: string;
}

/**
 * Normative idempotency derivation (AC3.1), the single source of truth so the
 * generator, the store and the revision path all agree:
 *
 *   sha256hex( concat( sorted.map(t => sha256hex(t.path) + sha256hex(t.diff)) ) )
 *
 * where `sorted` is `targets` sorted ascending by `path` (byte order). All
 * digests lowercase hex, input bytes utf-8. Sorts internally so callers may pass
 * targets in any order.
 */
export function computeIdempotencyKey(targets: Array<{ path: string; diff: string }>): string {
  const sorted = [...targets].sort(byPathBytes);
  const composed = sorted.map((t) => sha256hex(t.path) + sha256hex(t.diff)).join("");
  return sha256hex(composed);
}

/**
 * A merged working group: all threshold-crossing clusters that share one
 * (workflow, state). Reason codes are summed into `counts`; ticket ids are
 * unioned. Order-insensitive by construction (AC3.2).
 */
interface Group {
  workflowId: string;
  stateId: string;
  counts: Record<string, number>;
  ticketIds: Set<string>;
  failureCount: number;
}

function groupKey(workflow: string, step: string): string {
  // Length-prefixed so no (workflow, step) pair can collide with another.
  return `${workflow.length}:${workflow}/${step}`;
}

/**
 * Deterministic confidence in [0,1]: a bounded, monotonic function of the
 * failure count. More corroborating failures ⇒ higher confidence, saturating
 * toward 1. No clock, no RNG — a pure function of the evidence.
 */
export function scoreConfidence(failureCount: number): number {
  const BASELINE = 5;
  const raw = failureCount / (failureCount + BASELINE);
  // Quantize so the score is a clean, reproducible decimal.
  return Math.round(raw * 10000) / 10000;
}

/**
 * Render the advisory edit block appended to a surface. Deterministic and
 * dependent on both the surface `kind` and the merged reason codes / failure
 * count, so a change in the failure evidence yields a different rendered edit
 * (and therefore a different diff and idempotency key — AC3.2).
 */
function renderEditBlock(kind: TargetKind, group: Group): string {
  const reasons = Object.keys(group.counts).sort().join(", ");
  if (kind === "yaml") {
    return [
      "",
      "# --- p4-learning-loop (auto-generated proposal) ---",
      `# ${group.failureCount} recent failures in ${group.workflowId}/${group.stateId} cite: ${reasons}.`,
      "# Review this state's legal transitions and gates against the recurring cause above.",
    ].join("\n");
  }
  return [
    "",
    "<!-- p4-learning-loop (auto-generated proposal) -->",
    "## Recurring failure guidance",
    "",
    `${group.failureCount} recent failures in this step cite: ${reasons}.`,
    "Address the recurring cause above before transitioning out of this state.",
    "",
  ].join("\n");
}

/**
 * Produce a deterministic unified-diff-style patch for appending `addedText` to
 * the end of `oldContent`. The hunk header carries the old line count and a
 * trailing context line, so the diff is sensitive to the surface's current
 * content (drift changes the diff, and thus the idempotency key — AC3.2) as well
 * as to the appended text (which encodes the failure evidence).
 */
function renderAppendDiff(path: string, oldContent: string, addedText: string): string {
  const oldLines = oldContent.split("\n");
  const trailingNewline = oldLines.length > 0 && oldLines[oldLines.length - 1] === "";
  // Last line with real content, used as the hunk's context anchor.
  const contextIdx = trailingNewline ? Math.max(0, oldLines.length - 2) : oldLines.length - 1;
  const contextLine = oldLines[contextIdx] ?? "";
  const addedLines = addedText.split("\n");

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextIdx + 1},1 +${contextIdx + 1},${1 + addedLines.length} @@`,
    ` ${contextLine}`,
    ...addedLines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

/** Build one `ProposalTarget` from an editable surface and its group's evidence. */
function buildTarget(surface: EditableSurface, group: Group): ProposalTarget {
  const oldContent = surface.content;
  const block = renderEditBlock(surface.kind, group);
  const separator = oldContent.endsWith("\n") ? "" : "\n";
  const newContent = oldContent + separator + block + "\n";
  return {
    // `kind` comes from the rule template's surface, never inferred from `path`.
    kind: surface.kind,
    path: surface.path,
    oldContent: { hash: sha256hex(oldContent), snapshot: oldContent },
    newContent,
    diff: renderAppendDiff(surface.path, oldContent, block),
  };
}

/**
 * Generate deterministic, rule-based proposals from a set of failure clusters.
 *
 * Only clusters that exceed the threshold are considered. Surviving clusters are
 * grouped by (workflow, state); each group yields at most one proposal, touching
 * every editable surface that state exposes. A group whose state has no editable
 * surface is skipped (emits no proposal).
 */
export function generateProposals(
  clusters: FailureCluster[],
  ctx: GenerationContext,
): GeneratedProposal[] {
  // 1. Merge threshold-crossing clusters into (workflow, state) groups.
  const groups = new Map<string, Group>();
  for (const c of clusters) {
    if (!c.exceedsThreshold) continue;
    const key = groupKey(c.workflow, c.step);
    let group = groups.get(key);
    if (!group) {
      group = {
        workflowId: c.workflow,
        stateId: c.step,
        counts: {},
        ticketIds: new Set<string>(),
        failureCount: 0,
      };
      groups.set(key, group);
    }
    group.counts[c.reasonCode] = (group.counts[c.reasonCode] ?? 0) + c.count;
    group.failureCount += c.count;
    for (const id of c.ticketIds) group.ticketIds.add(id);
  }

  // 2. Render one proposal per group with an editable surface.
  const proposals: GeneratedProposal[] = [];
  for (const group of groups.values()) {
    const surfaces = ctx.readSurfaces(group.workflowId, group.stateId);
    if (surfaces.length === 0) continue; // no editable surface → no proposal

    const targets = surfaces
      .map((surface) => buildTarget(surface, group))
      .sort(byPathBytes);

    // Reason-code counts keyed deterministically (sorted keys) for stable output.
    const counts: Record<string, number> = {};
    for (const reason of Object.keys(group.counts).sort()) {
      counts[reason] = group.counts[reason];
    }

    proposals.push({
      workflowId: group.workflowId,
      stateId: group.stateId,
      targets,
      confidenceScore: scoreConfidence(group.failureCount),
      evidenceCluster: {
        ticketIds: [...group.ticketIds].sort(),
        counts,
      },
      failureCount: group.failureCount,
      version: 1,
      idempotencyKey: computeIdempotencyKey(targets),
    });
  }

  // 3. Stable output order: by (workflowId, stateId).
  proposals.sort((a, b) => {
    if (a.workflowId !== b.workflowId) return a.workflowId < b.workflowId ? -1 : 1;
    if (a.stateId !== b.stateId) return a.stateId < b.stateId ? -1 : 1;
    return 0;
  });

  return proposals;
}
