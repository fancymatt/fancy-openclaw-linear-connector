/**
 * AI-2041 (P4-C6) — Dev-impl pilot: pure primitives.
 *
 * These cover the two AC that are computable against the ObservationStore alone,
 * with no git config-root or HTTP surface:
 *
 *   - AC6.2 — a before/after **same-category** comparison is producible purely
 *     from stored observation data, given the observation window captured at
 *     apply. (`compareBeforeAfter`)
 *   - AC6.3 — synthetic seed rows are **explicitly flagged as synthetic** and
 *     are distinguishable from organically-appended (real) rows.
 *     (`seedSyntheticObservations` / `syntheticObservationIds`)
 *
 * The full end-to-end loop (AC6.1), the baseline capture at apply (AC6.2 apply
 * half), the AC6.3 follow-up-ticket requirement, and the AC6.4 sign-off gate are
 * exercised in ai-2041-dev-impl-pilot.e2e.test.ts.
 *
 * All of these import from src/pilot/dev-impl-pilot.ts, which does not yet
 * exist — every test here is RED until the pilot harness is implemented.
 */
import { ObservationStore } from "../store/observation-store.js";
import {
  seedSyntheticObservations,
  syntheticObservationIds,
  compareBeforeAfter,
  type SyntheticSeedRow,
} from "./dev-impl-pilot.js";
import type { MetricsBaseline } from "../proposal/apply-pipeline.js";

function memStore(): ObservationStore {
  // ":memory:" keeps each test isolated with no on-disk db file.
  return new ObservationStore(":memory:");
}

describe("AI-2041 AC6.3 — synthetic seed rows are explicitly flagged as synthetic", () => {
  it("flags every row written through the synthetic seeder", () => {
    const store = memStore();
    const rows: SyntheticSeedRow[] = [
      {
        ticket: "AI-SYNTH-1",
        workflow: "dev-impl",
        step: "write-tests",
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: "missing-tests",
      },
      {
        ticket: "AI-SYNTH-2",
        workflow: "dev-impl",
        step: "write-tests",
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: "missing-tests",
      },
    ];

    const ids = seedSyntheticObservations(store, rows);
    expect(ids).toHaveLength(2);

    const synthetic = syntheticObservationIds(store);
    for (const id of ids) {
      expect(synthetic.has(id)).toBe(true);
    }
  });

  it("does NOT flag organically-appended (real) rows as synthetic", () => {
    const store = memStore();

    // A real reject observation, written through the normal append path.
    const realId = store.append({
      ticket: "AI-REAL-1",
      workflow: "dev-impl",
      step: "write-tests",
      fromBody: "tdd",
      reviewerBody: "cra",
      reasonCode: "missing-tests",
    });

    const syntheticIds = seedSyntheticObservations(store, [
      {
        ticket: "AI-SYNTH-1",
        workflow: "dev-impl",
        step: "write-tests",
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: "missing-tests",
      },
    ]);

    const synthetic = syntheticObservationIds(store);
    // The real row is distinguishable from the synthetic ones — the flag is not
    // blanket-applied to the store.
    expect(synthetic.has(realId)).toBe(false);
    expect(synthetic.has(syntheticIds[0])).toBe(true);
  });
});

describe("AI-2041 AC6.2 — before/after same-category comparison is producible from stored data", () => {
  it("computes before (in-window) vs after (post-window) counts for one category", () => {
    const store = memStore();
    const key = { workflow: "dev-impl", step: "write-tests", reasonCode: "missing-tests" };

    // Baseline (before) period: three observations of the SAME category inside
    // the captured window.
    for (let i = 0; i < 3; i++) {
      store.append({
        ticket: `AI-BEFORE-${i}`,
        workflow: key.workflow,
        step: key.step,
        fromBody: "tdd",
        reviewerBody: "cra",
        reasonCode: "missing-tests",
        timestamp: `2026-07-0${i + 1}T00:00:00.000Z`,
      });
    }

    // A different category inside the window — must NOT count toward the
    // same-category comparison.
    store.append({
      ticket: "AI-OTHER",
      workflow: key.workflow,
      step: key.step,
      fromBody: "tdd",
      reviewerBody: "cra",
      reasonCode: "style",
      timestamp: "2026-07-02T00:00:00.000Z",
    });

    // After the apply window closes (until = 2026-07-15), one more same-category
    // observation lands — the "after" side of the comparison.
    store.append({
      ticket: "AI-AFTER-1",
      workflow: key.workflow,
      step: key.step,
      fromBody: "tdd",
      reviewerBody: "cra",
      reasonCode: "missing-tests",
      timestamp: "2026-08-01T00:00:00.000Z",
    });

    const baseline: MetricsBaseline = {
      snapshot: {},
      window: { since: "2026-07-01T00:00:00.000Z", until: "2026-07-15T00:00:00.000Z" },
    };

    const comparison = compareBeforeAfter(store, baseline, key);

    expect(comparison.workflow).toBe(key.workflow);
    expect(comparison.step).toBe(key.step);
    expect(comparison.reasonCode).toBe(key.reasonCode);
    // before = the three same-category rows inside the window (NOT the style row).
    expect(comparison.before).toBe(3);
    // after = the one same-category row that landed past the window.
    expect(comparison.after).toBe(1);
    expect(comparison.window).toEqual(baseline.window);
  });
});
