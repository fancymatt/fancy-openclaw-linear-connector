/**
 * AI-2201 — the Proposals console rendered empty cards because the SPA normalizer
 * reads flat fields (`title`, `workflowId`, `diffs`, `evidence`, …) that the
 * store nests under `proposal.*`. The fix flattens each row at the API boundary
 * (`GET /admin/api/proposals`) via `toConsoleView`.
 *
 * These tests pin the projection against the *exact* shape C3 persists (id +
 * idempotencyKey + targets[] + evidenceCluster), including the two real
 * `dev-impl` proposals from the ticket, and assert the flattened row round-trips
 * through the SPA normalizer contract (no `(untitled)` / `0/0` / empty pills).
 */
import type { ApplyProposal } from "./apply-pipeline.js";
import { scoreConfidence } from "./proposal-generator.js";
import { toConsoleView } from "./proposal-console-view.js";
import type { ProposalRow } from "../store/proposal-store.js";

function guidanceDiff(path: string, added: number): string {
  const addedLines = Array.from({ length: added }, (_, i) => `+added line ${i + 1}`);
  return [`--- a/${path}`, `+++ b/${path}`, "@@ -58,1 +58,8 @@", " context line", ...addedLines].join("\n");
}

function row(overrides: Partial<ProposalRow> & { proposal: ApplyProposal | null }): ProposalRow {
  return {
    id: overrides.id ?? "row-1",
    idempotencyKey: overrides.id ?? "row-1",
    status: "pending",
    version: null,
    commit: null,
    metricsBaseline: null,
    error: null,
    retryable: null,
    staleTargets: null,
    updatedAt: "2026-07-12 18:08:55",
    ...overrides,
  };
}

const writeTestsProposal: ApplyProposal = {
  id: "wt",
  idempotencyKey: "wt",
  targets: [
    {
      kind: "guidance",
      path: "workflows/dev-impl/write-tests.md",
      oldContent: { hash: "h", snapshot: "old" },
      newContent: "new",
      diff: guidanceDiff("workflows/dev-impl/write-tests.md", 5),
    },
  ],
  evidenceCluster: {
    ticketIds: ["AI-2041-SYNTH-1", "AI-2041-SYNTH-2", "AI-2041-SYNTH-3", "AI-2041-SYNTH-4", "AI-2041-SYNTH-5"],
    counts: { "missing-tests": 5 },
  } as unknown as ApplyProposal["evidenceCluster"],
};

describe("AI-2201 toConsoleView", () => {
  it("derives workflow/state from the target path", () => {
    const v = toConsoleView(row({ id: "wt", proposal: writeTestsProposal }));
    expect(v.workflowId).toBe("dev-impl");
    expect(v.stateId).toBe("write-tests");
  });

  it("reproduces the generator's confidence from persisted evidence (lossless)", () => {
    const v = toConsoleView(row({ id: "wt", proposal: writeTestsProposal }));
    expect(v.failureCount).toBe(5);
    expect(v.confidenceScore).toBe(scoreConfidence(5));
    expect(v.confidenceScore).toBeGreaterThan(0);
    expect(v.confidenceScore).toBeLessThanOrEqual(1);
  });

  it("flattens targets into renderable diffs with a non-zero diff stat", () => {
    const v = toConsoleView(row({ id: "wt", proposal: writeTestsProposal }));
    expect(v.diffs).toHaveLength(1);
    expect(v.diffs[0]).toMatchObject({ kind: "guidance", path: "workflows/dev-impl/write-tests.md" });
    // 5 added content lines; the +++ header must NOT be counted.
    expect(v.diffStat).toEqual({ added: 5, removed: 0 });
  });

  it("maps the evidence cluster into per-reason entries carrying the ticket ids", () => {
    const v = toConsoleView(row({ id: "wt", proposal: writeTestsProposal }));
    expect(v.evidence).toEqual([
      {
        failureType: "missing-tests",
        occurrences: 5,
        timeRange: "2026-07-12 18:08:55",
        ticketIds: ["AI-2041-SYNTH-1", "AI-2041-SYNTH-2", "AI-2041-SYNTH-3", "AI-2041-SYNTH-4", "AI-2041-SYNTH-5"],
      },
    ]);
  });

  it("derives a non-empty title and a meaningful severity", () => {
    const v = toConsoleView(row({ id: "wt", proposal: writeTestsProposal }));
    expect(v.title).toBe("Recurring missing-tests in dev-impl/write-tests");
    expect(v.title).not.toBe("(untitled proposal)");
    expect(v.severity).toBe("MEDIUM"); // failureCount 5 → MEDIUM
  });

  it("passes status, createdAt and applyError through from the row", () => {
    const v = toConsoleView(
      row({ id: "wt", proposal: writeTestsProposal, status: "apply-failed", error: "git commit failed" }),
    );
    expect(v.status).toBe("apply-failed");
    expect(v.createdAt).toBe("2026-07-12 18:08:55");
    expect(v.applyError).toBe("git commit failed");
  });

  it("handles a code-review proposal (the ticket's second row) the same way", () => {
    const codeReview: ApplyProposal = {
      id: "cr",
      idempotencyKey: "cr",
      targets: [
        {
          kind: "guidance",
          path: "workflows/dev-impl/code-review.md",
          oldContent: { hash: "h", snapshot: "old" },
          newContent: "new",
          diff: guidanceDiff("workflows/dev-impl/code-review.md", 4),
        },
      ],
      evidenceCluster: {
        ticketIds: ["AI-2041-SYNTH-6", "AI-2041-SYNTH-7", "AI-2041-SYNTH-8", "AI-2041-SYNTH-9"],
        counts: { "code-review": 4 },
      } as unknown as ApplyProposal["evidenceCluster"],
    };
    const v = toConsoleView(row({ id: "cr", proposal: codeReview }));
    expect(v.workflowId).toBe("dev-impl");
    expect(v.stateId).toBe("code-review");
    expect(v.failureCount).toBe(4);
    expect(v.severity).toBe("MEDIUM");
    expect(v.diffStat.added).toBe(4);
  });

  it("recovers workflow (def-level state) from a YAML target path", () => {
    const yamlProposal: ApplyProposal = {
      id: "y",
      idempotencyKey: "y",
      targets: [
        {
          kind: "yaml",
          path: "workflows/dev-impl.yaml",
          oldContent: { hash: "h", snapshot: "version: 1" },
          newContent: "version: 2",
          diff: "--- a/workflows/dev-impl.yaml\n+++ b/workflows/dev-impl.yaml\n@@ -1,1 +1,2 @@\n version: 1\n+# note",
        },
      ],
      evidenceCluster: { ticketIds: ["A", "B"], counts: { drift: 2 } } as unknown as ApplyProposal["evidenceCluster"],
    };
    const v = toConsoleView(row({ id: "y", proposal: yamlProposal }));
    expect(v.workflowId).toBe("dev-impl");
    expect(v.stateId).toBe("(schema)");
    expect(v.diffs[0].kind).toBe("yaml");
  });

  it("does not drop an apply-only row that has no C3 proposal payload", () => {
    const v = toConsoleView(row({ id: "orphan", proposal: null, status: "applied" }));
    expect(v.id).toBe("orphan");
    expect(v.status).toBe("applied");
    expect(v.diffs).toEqual([]);
    expect(v.diffStat).toEqual({ added: 0, removed: 0 });
    expect(v.evidence).toEqual([]);
  });

  it("scales severity to HIGH for a large failure cluster", () => {
    const big: ApplyProposal = {
      ...writeTestsProposal,
      evidenceCluster: {
        ticketIds: ["a"],
        counts: { "missing-tests": 6, correctness: 4 },
      } as unknown as ApplyProposal["evidenceCluster"],
    };
    const v = toConsoleView(row({ id: "big", proposal: big }));
    expect(v.failureCount).toBe(10);
    expect(v.severity).toBe("HIGH");
    // multi-reason title lists both, sorted
    expect(v.title).toBe("Recurring correctness, missing-tests in dev-impl/write-tests");
    expect(v.evidence.map((e) => e.failureType)).toEqual(["correctness", "missing-tests"]);
  });
});
