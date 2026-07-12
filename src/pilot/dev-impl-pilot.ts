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
 *     → unified proposal store (console-visible)          [AC6.1 stage]
 *     → apply pipeline (versioned, git-committed)           [AC6.1 apply]
 *   with a baseline observation window captured at apply             [AC6.2]
 *   gated on a HUMAN (Matt) sign-off — no AI self-sign-off           [AC6.4]
 *   and, when fed synthetic seed data, a mandatory real-data
 *   verification follow-up ticket + synthetic-flagged rows           [AC6.3]
 *
 * Three entrypoints:
 *
 *   1. stageDevImplPilot — distill → generate → persist; surfaces proposal
 *      in the console for review. No sign-off required.
 *   2. applyStagedProposal — loads a staged proposal by id, gates on a
 *      human sign-off (AC6.4), then applies (version bump + git commit).
 *   3. runDevImplPilot — backward-compatible monolithic orchestrator that
 *      composes (1) and (2) in one call. Existing tests pass unchanged.
 *
 * The two-phase split lets the live pilot flow be: Grover stages (synthetic
 * rows, ref AI-2117) → proposal surfaces in console → Matt reviews and signs
 * off → apply runs. That satisfies AC6.1 as written: generate, review, approve,
 * apply — with review-before-apply enforced by construction.
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

// ── AC6.1 — two-phase pilot: stage + apply ─────────────────────────────────────

// ── Phase 1: Stage (generate + persist, no apply) ─────────────────────────

/**
 * Deps for the stage phase. No sign-off, no configRoot — this phase only
 * reads observations, generates a proposal, and persists it to the console queue.
 */
export interface StagedPilotDeps {
  observationStore: ObservationStore;
  proposalStore: ProposalStore;
  generationContext: GenerationContext;
  now: () => number;
  /** Distillation threshold; defaults to the distillation job default when omitted. */
  threshold?: number;
  /** AC6.3 — true when any observation feeding this run is synthetic. */
  synthetic?: boolean;
  /** AC6.3 — required when `synthetic` is true; the real-data verification ticket. */
  realDataFollowupTicket?: string | null;
}

/**
 * Result from the stage phase: the proposal is persisted in the store (visible
 * in `/admin/api/proposals`) but NOT applied. No version bump, no git commit.
 */
export interface StagedPilotResult {
  proposalId: string;
  status: "staged";
  synthetic: boolean;
  realDataFollowupTicket: string | null;
}

/**
 * Run the pilot's stage phase: distill observation-store data → generate
 * proposals → persist to the console queue. No sign-off required — this phase
 * is read-only with respect to the config root. Returns the persisted proposal id
 * so the caller can surface it for review before applying.
 *
 * Throws when `synthetic` is set without a `realDataFollowupTicket` (AC6.3).
 */
export async function stageDevImplPilot(deps: StagedPilotDeps): Promise<StagedPilotResult> {
  // ── AC6.3 — the accumulation contingency. Enforced at stage time so a
  // synthetic run without a follow-up ticket is refused early, before any
  // proposal is persisted.
  const synthetic = deps.synthetic === true;
  const realDataFollowupTicket = deps.realDataFollowupTicket ?? null;
  if (synthetic && !realDataFollowupTicket) {
    throw new Error(
      "AI-2041 AC6.3: synthetic seed data requires a real-data verification follow-up ticket before the pilot may proceed",
    );
  }

  const { proposalId } = await distillAndPersist({
    observationStore: deps.observationStore,
    proposalStore: deps.proposalStore,
    generationContext: deps.generationContext,
    now: deps.now,
    threshold: deps.threshold,
  });

  return {
    proposalId,
    status: "staged",
    synthetic,
    realDataFollowupTicket,
  };
}

// ── Phase 2: Apply (human-sign-off-gated) ──────────────────────────────────

/**
 * Deps for the apply phase. Takes a proposal id from the stage phase and a
 * human sign-off; loads the persisted proposal from the store and applies it.
 */
export interface ApplyStagedDeps {
  /** The proposal id returned by {@link stageDevImplPilot}. */
  proposalId: string;
  proposalStore: ProposalStore;
  observationStore: ObservationStore;
  /** Git-tracked instance-config root the apply pipeline commits into. */
  configRoot: string;
  now: () => number;
  /** Def-cache reload for YAML applies; wired to resetWorkflowCache in prod. */
  reloadWorkflowDefs?: () => void;
  /** AC6.4 — must be a human sign-off, or the apply is refused. */
  signOff: SignOff | null;
}

/**
 * Apply a previously staged proposal. Loads the proposal from the store by id,
 * checks the human sign-off (AC6.4), captures the baseline window (AC6.2), and
 * runs the apply pipeline (version bump + git commit).
 *
 * Throws {@link SignOffRequiredError} without a human sign-off.
 */
export async function applyStagedProposal(deps: ApplyStagedDeps): Promise<PilotResult> {
  // ── AC6.4 — elevated stakes level 0: a HUMAN sign-off gates the apply.
  if (!deps.signOff || deps.signOff.kind !== "human") {
    throw new SignOffRequiredError();
  }

  const { proposalId, proposalStore, observationStore, configRoot, now } = deps;

  // Load the staged proposal from the unified store.
  const row = proposalStore.getById(proposalId);
  if (!row || !row.proposal) {
    throw new Error(
      `AI-2041: staged proposal not found in store (id=${proposalId}). ` +
        "Run stageDevImplPilot first to generate and persist the proposal.",
    );
  }

  const proposal = row.proposal;

  // ── AC6.2 — capture a defined baseline observation window at apply. The
  // proposal's targets tell us which workflow/step to scope the window to.
  // Use the first target's path to infer the workflow and step.
  const workflowId = inferWorkflowFromTargets(proposal);
  const stepId = inferStepFromTargets(proposal);

  const stepRows = observationStore.query({
    workflow: workflowId,
    step: stepId,
    limit: 1000,
  });
  const until = new Date(now()).toISOString();
  const earliest = stepRows.map((r) => r.createdAt).sort()[0];
  const since = earliest && earliest <= until ? earliest : until;
  const baseline: MetricsBaseline = {
    snapshot: { workflow: workflowId, step: stepId },
    window: { since, until },
  };

  // ── AC6.1 (apply) — apply to dev-impl guidance: versioned + git-committed,
  // atomic and TOCTOU-guarded.
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
    synthetic: false, // synthetic provenance is on the staged result, not carried here
    realDataFollowupTicket: null,
  };
}

// ── Monolithic orchestrator (backward-compatible) ────────────────────────────

/**
 * Deps for the monolithic orchestrator — composes stage + apply in one call.
 * Kept for backward compatibility with the original test suite.
 */
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

  // ── AC6.3 — enforced at stage time.
  const synthetic = deps.synthetic === true;
  const realDataFollowupTicket = deps.realDataFollowupTicket ?? null;

  // Stage phase: distill → generate → persist (no apply).
  const staged = await stageDevImplPilot({
    observationStore: deps.observationStore,
    proposalStore: deps.proposalStore,
    generationContext: deps.generationContext,
    now: deps.now,
    threshold: deps.threshold,
    synthetic,
    realDataFollowupTicket,
  });

  // Apply phase: human-sign-off-gated → version bump + git commit.
  const result = await applyStagedProposal({
    proposalId: staged.proposalId,
    proposalStore: deps.proposalStore,
    observationStore: deps.observationStore,
    configRoot: deps.configRoot,
    now: deps.now,
    reloadWorkflowDefs: deps.reloadWorkflowDefs,
    signOff: deps.signOff,
  });

  return {
    proposalId: result.proposalId,
    status: "applied",
    version: result.version,
    commit: result.commit,
    baseline: result.baseline,
    synthetic,
    realDataFollowupTicket,
  };
}

// ── Internal: shared distill-and-persist ────────────────────────────────────

interface DistillDeps {
  observationStore: ObservationStore;
  proposalStore: ProposalStore;
  generationContext: GenerationContext;
  now: () => number;
  threshold?: number;
}

/**
 * Shared internal: distill observation data, generate proposals, and persist
 * the first one. Returns the persisted proposal id.
 */
async function distillAndPersist(deps: DistillDeps): Promise<{ proposalId: string }> {
  const { observationStore, proposalStore, generationContext } = deps;
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

  return { proposalId: proposal.id };
}

// ── Internal: target inference helpers ──────────────────────────────────────

/**
 * Infer the workflow id from a proposal's targets. A guidance target at
 * `workflows/<wf>/<state>.md` yields workflow `<wf>`; a yaml target at
 * `workflows/<wf>.yaml` yields workflow `<wf>`.
 */
function inferWorkflowFromTargets(proposal: { targets: Array<{ kind: string; path: string }> }): string {
  for (const target of proposal.targets) {
    const parts = target.path.replace(/^\//, "").split("/");
    if (parts[0] === "workflows" && parts.length >= 2) {
      // Strip extension from the last segment if it's .yaml.
      return parts[1].replace(/\.yaml$/, "");
    }
  }
  return "unknown";
}

/**
 * Infer the step id from a guidance target's path:
 * `workflows/<wf>/<state>.md` → `<state>`. Falls back to "unknown" for
 * yaml-only proposals.
 */
function inferStepFromTargets(proposal: { targets: Array<{ kind: string; path: string }> }): string {
  for (const target of proposal.targets) {
    if (target.kind === "guidance") {
 const segments = target.path.replace(/^\//, "").split("/");
      if (segments.length >= 3) {
        return segments[2].replace(/\.md$/, "");
      }
    }
  }
  return "unknown";
}
