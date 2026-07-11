/**
 * AI-2041 (P4-C6) — Dev-impl learning-loop pilot harness.
 *
 * Implements the contract the test-author (tdd) pinned in the AI-2041 suite.
 * The exported signatures below are the graded seam the tests bind to; the
 * bodies drive the loop on real infrastructure by composing the C1–C5 primitives
 * (observation store, deterministic generation engine, C4 apply pipeline).
 *
 * The pilot drives the full loop on real infrastructure under the C6 elevated-
 * stakes guarantees:
 *
 *   observation-store data
 *     → distillation (cluster + deterministic generation)
 *     → unified proposal store (console-visible)
 *     → apply pipeline (versioned, git-committed)   [AC6.1]
 *   with a baseline observation window captured at apply             [AC6.2]
 *   gated on a HUMAN (Matt) sign-off — no AI self-sign-off           [AC6.4]
 *   and, when fed synthetic seed data, a mandatory real-data
 *   verification follow-up ticket + synthetic-flagged rows           [AC6.3]
 *
 * Contract types below are the seam the tests bind to. The implementer may
 * refine internals freely, but the exported signatures and the AC behaviours the
 * tests assert are the graded contract — escalate to Ai if any is untestable as
 * written rather than quietly changing it.
 */
import {
  UNCLASSIFIED_REASON_CODE,
  type ObservationStore,
  type ReasonCode,
} from "../store/observation-store.js";
import type { ProposalStore } from "../store/proposal-store.js";
import {
  generateProposals,
  type FailureCluster,
  type GenerationContext,
} from "../proposal/proposal-generator.js";
import { persistGeneratedProposals } from "../proposal/generated-proposal-adapter.js";
import { applyProposal, type ApplyDeps, type MetricsBaseline } from "../proposal/apply-pipeline.js";

/** Distillation threshold default, mirroring the P4-C3 distillation job. */
const DEFAULT_THRESHOLD = 3;

// ── AC6.4 — human sign-off ───────────────────────────────────────────────────

export type SignOffKind = "human" | "ai";

/** An apply/deploy authorization. Only a `human` sign-off may apply to prod. */
export interface SignOff {
  approver: string;
  kind: SignOffKind;
}

/**
 * Thrown when the apply/deploy is not authorized by a human sign-off (AC6.4,
 * elevated stakes level 0). Refusal is terminal for that run: no write, no git
 * commit, no version bump.
 */
export class SignOffRequiredError extends Error {
  constructor(message = "human sign-off required to apply the pilot proposal (AC6.4)") {
    super(message);
    this.name = "SignOffRequiredError";
  }
}

// ── AC6.3 — synthetic seed rows ──────────────────────────────────────────────

/** One synthetic observation seed row (AC6.3), written explicitly flagged synthetic. */
export interface SyntheticSeedRow {
  ticket: string;
  workflow: string;
  step: string;
  fromBody: string;
  reviewerBody: string;
  reasonCode: ReasonCode;
  freeText?: string | null;
  timestamp?: string;
}

/**
 * Seed synthetic observation rows into the store, each EXPLICITLY flagged as
 * synthetic (AC6.3). Returns the inserted observation ids.
 */
export function seedSyntheticObservations(
  store: ObservationStore,
  rows: SyntheticSeedRow[],
): number[] {
  return rows.map((row) =>
    store.append({
      ticket: row.ticket,
      workflow: row.workflow,
      step: row.step,
      fromBody: row.fromBody,
      reviewerBody: row.reviewerBody,
      reasonCode: row.reasonCode,
      freeText: row.freeText ?? null,
      timestamp: row.timestamp,
      // AC6.3: every seeded row is written EXPLICITLY flagged synthetic.
      synthetic: true,
    }),
  );
}

/** The set of observation ids currently flagged synthetic in the store (AC6.3). */
export function syntheticObservationIds(store: ObservationStore): Set<number> {
  return store.syntheticIds();
}

// ── AC6.2 — before/after same-category comparison ────────────────────────────

export interface CategoryComparison {
  workflow: string;
  step: string;
  reasonCode: string;
  /** Same-category observation count inside the captured baseline window. */
  before: number;
  /** Same-category observation count after the window closes. */
  after: number;
  window: { since: string; until: string };
}

/**
 * Produce a before/after same-category comparison purely from stored observation
 * data, given the baseline window captured at apply (AC6.2).
 */
export function compareBeforeAfter(
  store: ObservationStore,
  baseline: MetricsBaseline,
  key: { workflow: string; step: string; reasonCode: string },
): CategoryComparison {
  const { since, until } = baseline.window;

  // Same-category rows only — a different reasonCode in the same step must not
  // count toward this comparison. Pull them all once, then partition by the
  // captured window (ISO timestamps sort lexically).
  const rows = store.query({
    workflow: key.workflow,
    step: key.step,
    reasonCode: key.reasonCode as ReasonCode,
    limit: 1000,
  });

  let before = 0;
  let after = 0;
  for (const row of rows) {
    if (row.createdAt >= since && row.createdAt <= until) before += 1;
    else if (row.createdAt > until) after += 1;
  }

  return {
    workflow: key.workflow,
    step: key.step,
    reasonCode: key.reasonCode,
    before,
    after,
    window: { since, until },
  };
}

// ── AC6.1 — the pilot orchestrator ───────────────────────────────────────────

export interface PilotDeps {
  observationStore: ObservationStore;
  proposalStore: ProposalStore;
  generationContext: GenerationContext;
  /** Git-tracked instance-config root the apply pipeline commits into. */
  configRoot: string;
  now: () => number;
  /** Distillation threshold; defaults to the distillation job default when omitted. */
  threshold?: number;
  /** Def-cache reload for YAML applies; wired to resetWorkflowCache in prod. */
  reloadWorkflowDefs?: () => void;
  /** AC6.4 — must be a human sign-off, or the run is refused. */
  signOff: SignOff | null;
  /** AC6.3 — true when any observation feeding this run is synthetic. */
  synthetic?: boolean;
  /** AC6.3 — required when `synthetic` is true; the real-data verification ticket. */
  realDataFollowupTicket?: string | null;
}

export interface PilotResult {
  proposalId: string;
  status: "applied";
  version: number;
  commit: string;
  baseline: MetricsBaseline;
  synthetic: boolean;
  realDataFollowupTicket: string | null;
}

/**
 * Run the dev-impl learning-loop pilot end to end. See the module header for the
 * AC mapping. Throws {@link SignOffRequiredError} without a human sign-off
 * (AC6.4); throws when `synthetic` is set without a `realDataFollowupTicket`
 * (AC6.3). On success, returns the applied proposal's version, commit, and the
 * baseline observation window captured at apply (AC6.2).
 */
export async function runDevImplPilot(deps: PilotDeps): Promise<PilotResult> {
  // ── AC6.4 — elevated stakes level 0: a HUMAN sign-off gates the whole run.
  // Checked FIRST, before any distillation, persist, write, commit or version
  // bump, so an AI self-sign-off (or none) leaves the config root untouched.
  if (!deps.signOff || deps.signOff.kind !== "human") {
    throw new SignOffRequiredError();
  }

  // ── AC6.3 — the accumulation contingency. If this run is fed synthetic seed
  // data, a real-data verification follow-up ticket MUST be on record, or we
  // refuse rather than call the AC met on synthetic data with no follow-up.
  const synthetic = deps.synthetic === true;
  const realDataFollowupTicket = deps.realDataFollowupTicket ?? null;
  if (synthetic && !realDataFollowupTicket) {
    throw new Error(
      "AI-2041 AC6.3: synthetic seed data requires a real-data verification follow-up ticket before the pilot may proceed",
    );
  }

  const { observationStore, proposalStore, generationContext, configRoot, now } = deps;
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;

  // ── AC6.1 (distill) — generate a proposal FROM observation-store data, not a
  // hand-built cluster. This mirrors the P4-C3 distillation job: read the metric
  // rollup, bridge each threshold-crossing (workflow, step, reason) pattern to a
  // FailureCluster, and feed the deterministic generation engine.
  const metrics = observationStore.metrics({ threshold });
  const clusters: FailureCluster[] = metrics.items
    .filter((item) => item.exceedsThreshold && item.reasonCode !== UNCLASSIFIED_REASON_CODE)
    .map((item) => ({
      workflow: item.workflow,
      step: item.step,
      reasonCode: item.reasonCode,
      count: item.count,
      exceedsThreshold: true,
      ticketIds: item.tickets,
    }));

  const generated = generateProposals(clusters, generationContext);
  if (generated.length === 0) {
    throw new Error(
      "AI-2041 AC6.1: no proposal was generated from observation-store data — " +
        `no (workflow, step, reason) pattern crossed threshold=${threshold} with an editable surface`,
    );
  }

  // Persist through the C4 adapter so the proposal surfaces in the
  // `/admin/api/proposals` console queue and is applyable by idempotency key.
  const [proposal] = persistGeneratedProposals(proposalStore, generated);

  // ── AC6.2 — capture a defined baseline observation window at apply. `since`
  // is the start of the step's accumulation, `until` is the apply moment; both
  // ISO, and `since ≤ until` by construction, so the window never runs backward.
  const primary = generated[0];
  const stepRows = observationStore.query({
    workflow: primary.workflowId,
    step: primary.stateId,
    limit: 1000,
  });
  const until = new Date(now()).toISOString();
  const earliest = stepRows.map((r) => r.createdAt).sort()[0];
  const since = earliest && earliest <= until ? earliest : until;
  const baseline: MetricsBaseline = {
    snapshot: {
      workflow: primary.workflowId,
      step: primary.stateId,
      counts: primary.evidenceCluster.counts,
      failureCount: primary.failureCount,
    },
    window: { since, until },
  };

  // ── AC6.1 (apply) — apply to dev-impl guidance: versioned + git-committed,
  // atomic and TOCTOU-guarded. The baseline window is captured at apply and
  // durably attached to the applied record (AC6.2). The unified ProposalStore
  // doubles as the apply pipeline's idempotency store.
  const applyDeps: ApplyDeps = {
    configRoot,
    store: proposalStore,
    captureMetrics: () => baseline,
    reloadWorkflowDefs: deps.reloadWorkflowDefs ?? (() => {}),
    now,
  };

  const result = await applyProposal(proposal, applyDeps);
  if (result.status !== "applied") {
    throw new Error(
      `AI-2041 AC6.1: apply did not land (status=${result.status}` +
        (result.staleTargets ? `, stale=${result.staleTargets.join(",")}` : "") +
        (result.error ? `, error=${result.error}` : "") +
        ")",
    );
  }
  if (result.version === undefined || result.commit === undefined) {
    throw new Error("AI-2041 AC6.1: apply reported neither version nor commit");
  }

  return {
    proposalId: proposal.id,
    status: "applied",
    version: result.version,
    commit: result.commit,
    baseline: result.metricsBaseline ?? baseline,
    synthetic,
    realDataFollowupTicket,
  };
}
