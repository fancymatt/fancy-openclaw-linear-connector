/**
 * AI-2201 — the API-boundary flattener for the `/admin/api/proposals` console.
 *
 * The store persists a {@link ProposalRow} whose C3 payload (`ApplyProposal`)
 * nests everything the review console renders inside `proposal.targets[]` and
 * `proposal.evidenceCluster`. The SPA normalizer (`toProposal` in
 * `web/src/App.tsx`) reads *flat* fields — `title`, `workflowId`, `stateId`,
 * `confidenceScore`, `diffs`, `evidence`, `severity`, `diffStat` — straight off
 * the wire row. Those don't exist at the top level of a `ProposalRow`, so every
 * card rendered as `(untitled proposal)` with empty pills and a `0/0` diff stat.
 *
 * The fix (option 1 of AI-2201: the API owns the shape contract, SPA unchanged)
 * is to project each row into the flat wire shape here. The projection is
 * **lossless** for the values that matter: the C3 adapter
 * (`generated-proposal-adapter.ts`) drops the generator's display metadata, but
 * `failureCount === sum(evidenceCluster.counts)` and
 * `confidenceScore === scoreConfidence(failureCount)` are pure functions of the
 * persisted evidence, so they reproduce the exact values the generator computed —
 * no regeneration, and the two already-stored proposals render immediately.
 *
 * `title`/`severity` were never carried by C3 at all; they are derived
 * deterministically from the workflow/state and failure evidence so the console
 * has meaningful triage signal instead of the SPA's `(untitled)` / `LOW`
 * fallbacks.
 */
import type { ApplyTarget } from "./apply-pipeline.js";
import { scoreConfidence } from "./proposal-generator.js";
import type { ProposalRow } from "../store/proposal-store.js";

/** The evidence cluster as C3 persists it (`{ ticketIds, counts }`). */
interface StoredEvidenceCluster {
  ticketIds?: string[];
  counts?: Record<string, number>;
}

/** One diff surface as the SPA renders it (`ProposalDiff` in ProposalsPage.tsx). */
export interface ConsoleDiff {
  kind: "guidance" | "yaml";
  path: string;
  patch: string;
}

/** One evidence entry as the SPA renders it (`EvidenceCluster` in ProposalsPage.tsx). */
export interface ConsoleEvidence {
  failureType: string;
  occurrences: number;
  timeRange: string;
  ticketIds: string[];
}

/**
 * The flat wire shape the SPA's `toProposal` normalizer reads. Mirrors the
 * console's `Proposal` view model (minus the SPA-only optimistic fields), so the
 * normalizer's `??` fallbacks are never exercised for a real row.
 */
export interface ConsoleProposalView {
  id: string;
  title: string;
  workflowId: string;
  stateId: string;
  status: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  confidenceScore: number;
  createdAt: string;
  diffStat: { added: number; removed: number };
  diffs: ConsoleDiff[];
  evidence: ConsoleEvidence[];
  failureCount: number;
  version: number;
  applyError: string | null;
}

const WORKFLOW_PATH = /^workflows\/([^/]+?)(?:\/([^/]+?))?\.(?:md|ya?ml)$/;

/**
 * Recover `(workflowId, stateId)` from a target path. Guidance targets live at
 * `workflows/<wf>/<state>.md`; a workflow-def YAML at `workflows/<wf>.yaml` names
 * only the workflow, so `stateId` falls back to the def-level `"(schema)"`.
 */
function workflowStateFromPath(path: string): { workflowId: string; stateId: string } {
  const match = WORKFLOW_PATH.exec(path);
  if (!match) return { workflowId: "", stateId: "" };
  const [, workflowId, stateId] = match;
  return { workflowId, stateId: stateId ?? "(schema)" };
}

/** Count added / removed lines across a unified diff, ignoring `+++`/`---` file headers. */
function diffStat(diffs: ConsoleDiff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const { patch } of diffs) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Deterministic severity from the corroborating failure count — the same signal
 * that drives confidence. Gives the console's severity sort meaningful order
 * instead of every card defaulting to LOW.
 */
function deriveSeverity(failureCount: number): "HIGH" | "MEDIUM" | "LOW" {
  if (failureCount >= 8) return "HIGH";
  if (failureCount >= 4) return "MEDIUM";
  return "LOW";
}

function toDiffs(targets: ApplyTarget[]): ConsoleDiff[] {
  return targets.map((t) => ({ kind: t.kind, path: t.path, patch: t.diff }));
}

function toEvidence(cluster: StoredEvidenceCluster, timeRange: string): ConsoleEvidence[] {
  const counts = cluster.counts ?? {};
  const ticketIds = cluster.ticketIds ?? [];
  const reasons = Object.keys(counts).sort();
  if (reasons.length === 0) {
    return ticketIds.length > 0
      ? [{ failureType: "failure", occurrences: ticketIds.length, timeRange, ticketIds }]
      : [];
  }
  // ticketIds are cluster-wide (not per reason); attach the full set to each entry.
  return reasons.map((failureType) => ({
    failureType,
    occurrences: counts[failureType],
    timeRange,
    ticketIds,
  }));
}

/**
 * Project a persisted proposal row into the flat wire shape the console SPA
 * reads. Rows with no C3 payload (`proposal === null` — an apply-only outcome
 * row) still yield a valid, empty-diff card rather than being dropped.
 */
export function toConsoleView(row: ProposalRow): ConsoleProposalView {
  const proposal = row.proposal;
  const targets = proposal?.targets ?? [];
  const cluster = (proposal?.evidenceCluster ?? {}) as StoredEvidenceCluster;

  const { workflowId, stateId } = targets.length > 0
    ? workflowStateFromPath(targets[0].path)
    : { workflowId: "", stateId: "" };

  const failureCount = Object.values(cluster.counts ?? {}).reduce((sum, n) => sum + n, 0);
  const diffs = toDiffs(targets);
  const reasons = Object.keys(cluster.counts ?? {}).sort().join(", ");

  const title = workflowId
    ? reasons
      ? `Recurring ${reasons} in ${workflowId}/${stateId}`
      : `Proposal for ${workflowId}/${stateId}`
    : "(untitled proposal)";

  return {
    id: row.id,
    title,
    workflowId,
    stateId,
    status: row.status,
    severity: deriveSeverity(failureCount),
    confidenceScore: scoreConfidence(failureCount),
    createdAt: row.updatedAt,
    diffStat: diffStat(diffs),
    diffs,
    evidence: toEvidence(cluster, row.updatedAt),
    failureCount,
    version: row.version ?? 1,
    applyError: row.error,
  };
}
