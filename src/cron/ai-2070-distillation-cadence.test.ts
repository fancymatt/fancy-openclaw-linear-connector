/**
 * AI-2070 (P4-C3) — the SCHEDULED cadence path drives the deterministic engine
 * into the unified C4 store, and the interval stays env-configurable.
 *
 * The headline e2e (ai-2070-prod-trigger.e2e.test.ts) drives `runDistillation`
 * directly. This test proves the other half of AC1 — "a prod trigger invokes the
 * deterministic generation engine on a defined cadence (cron/wake), configurable"
 * — by exercising the REGISTERED timer, not the function underneath it: it is the
 * guard against wiring `runDistillation` correctly but forgetting to thread the
 * unified store through `registerDistillationCron` (the scheduled call site).
 *
 * RED on current `main`: `registerDistillationCron(observationStore)` takes only
 * the observation store and its scheduled tick emits skill_workshop proposals over
 * the gateway — nothing lands in the C4 `ProposalStore`. This suite pins the new
 * registrar signature:
 *
 *   registerDistillationCron(
 *     observationStore: ObservationStore,
 *     proposalStore: GeneratedProposalSink,   // the C4 ../store/proposal-store.ts
 *     ctx: GenerationContext,                  // prod readSurfaces
 *   ): void
 *
 * The interval is read from `P4_DISTILL_INTERVAL` at module load, so each case
 * resets modules and re-imports with the env pinned — proving the cadence is
 * genuinely env-driven, not hard-coded.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GenerationContext } from "../proposal/proposal-generator.js";

const WORKFLOW = "dev-impl";
const STEP = "code-review";
const REASON = "missing-tests";

/** A prod-shaped ctx: one editable guidance surface for the group under test. */
const ctx: GenerationContext = {
  readSurfaces: (workflowId, stateId) => {
    if (workflowId !== WORKFLOW || stateId !== STEP) return [];
    return [
      {
        kind: "guidance",
        path: path.join("workflows", WORKFLOW, `${STEP}.md`),
        content: `# ${STEP}\n\nReview the diff before approving.\n`,
      },
    ];
  },
};

describe("AI-2070 — distillation cadence: the registered timer fires the engine into the unified store", () => {
  let dir: string;
  const savedInterval = process.env.P4_DISTILL_INTERVAL;
  const savedThreshold = process.env.P4_DISTILL_THRESHOLD;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2070-cadence-"));
    jest.resetModules();
    jest.useFakeTimers();
    // The gateway is unreachable in tests; make the legacy path fail fast so the
    // RED state is a clean empty store rather than a hanging socket. The unified
    // path never calls fetch, so this is inert once implemented.
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway in test"));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (savedInterval === undefined) delete process.env.P4_DISTILL_INTERVAL;
    else process.env.P4_DISTILL_INTERVAL = savedInterval;
    if (savedThreshold === undefined) delete process.env.P4_DISTILL_THRESHOLD;
    else process.env.P4_DISTILL_THRESHOLD = savedThreshold;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers on the P4_DISTILL_INTERVAL cadence and its scheduled tick persists a generated proposal to the C4 store", async () => {
    process.env.P4_DISTILL_INTERVAL = "20"; // 20ms raw
    process.env.P4_DISTILL_THRESHOLD = "3";

    // Fresh module instances so DEFAULT_INTERVAL_MS picks up the pinned env, and
    // so the cron + registry we assert against share one process registry.
    const { registerDistillationCron } = await import("./p4-metrics-distillation.js");
    const { getRegisteredCrons } = await import("./registry.js");
    const { ObservationStore } = await import("../store/observation-store.js");
    const { ProposalStore } = await import("../store/proposal-store.js");

    const observationStore = new ObservationStore(path.join(dir, "obs.db"));
    const proposalStore = new ProposalStore(path.join(dir, "proposals.db"));

    // Seed a threshold-crossing (workflow, step, reasonCode) group.
    for (let i = 0; i < 5; i++) {
      observationStore.append({
        ticket: `AI-80${i}`,
        workflow: WORKFLOW,
        step: STEP,
        fromBody: "review",
        reviewerBody: "missing tests",
        reasonCode: REASON,
      });
    }

    registerDistillationCron(observationStore, proposalStore, ctx);

    // AC1: the interval is env-configurable and reflected in the registration.
    const entry = getRegisteredCrons().find((c) => c.name === "p4-metrics-distillation");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toContain("20ms");

    // Before the first tick the store is empty.
    expect(proposalStore.list().length).toBe(0);

    // Advance past one interval and flush the scheduled async run.
    await jest.advanceTimersByTimeAsync(25);

    // The scheduled tick drove generateProposals + persistGeneratedProposals into
    // the unified store — the console queue now has the proposal.
    const queued = proposalStore.list();
    expect(queued.length).toBe(1);
    expect(queued[0].proposal?.targets?.[0]?.path).toBe(path.join("workflows", WORKFLOW, `${STEP}.md`));
    // And the liveness stamp advanced (markCronRun ran after the work).
    expect(entry?.lastRunAt ?? getRegisteredCrons().find((c) => c.name === "p4-metrics-distillation")?.lastRunAt).not.toBeNull();

    observationStore.close();
    proposalStore.close();
  });
});
