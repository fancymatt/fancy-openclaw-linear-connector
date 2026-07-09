/**
 * AI-1730 — Zero-Child Barrier Auto-Advance in Managing State.
 *
 * Failing tests covering all in-scope acceptance criteria:
 *
 *   AC1: A parent ticket in managing with zero children auto-advances to the
 *        next state immediately on entry.
 *   AC2: A parent ticket in managing where all children are already done (race
 *        condition) also auto-advances on entry.
 *   AC3: A parent ticket in managing with N ≥ 1 in-progress children continues
 *        to wait as before (regression).
 *   AC4: No change to existing story-series / story-lesson behaviour (those always
 *        spawn ≥ 1 child) — regression guard.
 *
 * Test-to-AC mapping is annotated in test names and describe blocks.
 *
 * The implementation lives in barrier.ts (evaluateBarrier / attemptBarrierTransition)
 * and workflow-gate.ts (applyStateTransition post-managing-entry check).
 * These tests cover the barrier module changes; workflow-gate integration is
 * tested via the exported barrier functions that the gate calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateBarrier, attemptBarrierTransition, isChildTerminal, type BarrierResult, type BarrierTransitionResult } from "./barrier.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// AI-1992: barrier-ness is config-driven — the barrier engine reads the parent's
// workflow def to confirm its current state declares `barrier: true`. Build an
// isolated defs dir with the migrated ux-audit/sprint/dev-impl fixtures plus
// minimal vocab-builder/word-build defs (whose managing states are barriers),
// and point the registry at it for this whole file.
const MINIMAL_VOCAB_BUILDER_YAML = `
id: vocab-builder
version: 1
archetype: orchestrator
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: spawning, assign: { mode: required } }
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:word-build
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: review }
  - id: review
    owner_role: steward
    native_state: thinking
    transitions:
      - { command: approve, to: done }
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

const MINIMAL_WORD_BUILD_YAML = `
id: word-build
version: 1
archetype: orchestrator
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: spawning, assign: { mode: required } }
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:vocab-image
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: review }
  - id: review
    owner_role: steward
    native_state: thinking
    transitions:
      - { command: approve, to: done }
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

let _zeroChildDefsDir: string;
let _origZeroChildDefsDir: string | undefined;

beforeAll(() => {
  _origZeroChildDefsDir = process.env.WORKFLOW_DEFS_DIR;
  _zeroChildDefsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1730-defs-"));
  const fixturesDir = path.resolve(process.cwd(), "src/__fixtures__");
  for (const f of ["canonical-ux-audit.yaml", "canonical-sprint.yaml", "canonical-dev-impl.yaml"]) {
    fs.copyFileSync(path.join(fixturesDir, f), path.join(_zeroChildDefsDir, f));
  }
  fs.writeFileSync(path.join(_zeroChildDefsDir, "vocab-builder.yaml"), MINIMAL_VOCAB_BUILDER_YAML, "utf8");
  fs.writeFileSync(path.join(_zeroChildDefsDir, "word-build.yaml"), MINIMAL_WORD_BUILD_YAML, "utf8");
  process.env.WORKFLOW_DEFS_DIR = _zeroChildDefsDir;
  resetWorkflowCache();
});

afterAll(() => {
  if (_origZeroChildDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = _origZeroChildDefsDir;
  else delete process.env.WORKFLOW_DEFS_DIR;
  resetWorkflowCache();
});

beforeEach(() => resetWorkflowCache());

// Dynamic import for onManagingEntry — not yet exported from barrier.ts.
// Using the module namespace avoids a static ESM import failure so the
// evaluateBarrier / attemptBarrierTransition tests still run independently.
import * as barrierModule from "./barrier.js";
type OnManagingEntryFn = (
  parentIdentifier: string,
  authToken: string,
) => Promise<BarrierTransitionResult | null>;
const onManagingEntry = (barrierModule as Record<string, unknown>)[
  "onManagingEntry"
] as OnManagingEntryFn | undefined;

function requireOnManagingEntry(): OnManagingEntryFn {
  if (!onManagingEntry) {
    throw new Error(
      "onManagingEntry is not exported from barrier.ts — " +
      "add `export async function onManagingEntry(parentIdentifier, authToken)` to implement AI-1730 ACs 1–3.",
    );
  }
  return onManagingEntry;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a mock fetch that returns children for the parent. */
function makeChildrenFetch(children: Array<{ identifier: string; labels: string[] }>): typeof globalThis.fetch {
  return async (_url, _init) => {
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            children: {
              nodes: children.map((c) => ({
                identifier: c.identifier,
                labels: { nodes: c.labels.map((l) => ({ name: l })) },
              })),
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

/** Build a mock fetch for the full attemptBarrierTransition flow. */
function makeTransitionFetch(opts: {
  children: Array<{ identifier: string; labels: string[] }>;
  workflowId?: string;
  parentState?: string;
}): typeof globalThis.fetch {
  const wfId = opts.workflowId ?? "ux-audit";
  const state = opts.parentState ?? "managing";
  const children = opts.children;
  let callCount = 0;

  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    callCount++;

    // Fetch children
    if (query.includes("ParentChildren")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: children.map((c) => ({
                  identifier: c.identifier,
                  labels: { nodes: c.labels.map((l) => ({ name: l })) },
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fetch parent state with label IDs (called for managing state verification and label swap)
    if (query.includes("ParentState") || query.includes("ParentLabels") || query.includes("IssueLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "parent-internal-id",
              team: { id: "team-uuid" },
              labels: {
                nodes: [
                  { id: "wf-lbl", name: `wf:${wfId}` },
                  { id: "state-lbl", name: `state:${state}` },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Label creation
    if (query.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({
          data: { issueLabelCreate: { success: true, issueLabel: { id: "label-new" } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // TeamLabels lookup
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Label swap mutation
    if (query.includes("UpdateLabels") || query.includes("issueUpdate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Comment creation
    if (query.includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected query in makeTransitionFetch: ${query.slice(0, 100)}`);
  };
}

// ── AC1: Zero children → auto-advance ─────────────────────────────────────

describe("AC1: Parent with zero children auto-advances from managing on entry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("evaluateBarrier returns allTerminal=true when parent has zero children", async () => {
    // AC1: The barrier evaluation must treat zero children as satisfied.
    // Currently this returns allTerminal: false (BUG — this test fails first).
    globalThis.fetch = makeChildrenFetch([]);

    const result = await evaluateBarrier("AI-1730", "Bearer tok");

    expect(result.totalChildren).toBe(0);
    expect(result.terminalCount).toBe(0);
    expect(result.allTerminal).toBe(true);
  });

  it("attemptBarrierTransition transitions parent managing → review when zero children", async () => {
    // AC1: Full end-to-end — a ux-audit parent in managing with no children
    // should auto-advance to review. Currently this errors out with
    // "No children found — barrier requires at least one child" (BUG).
    globalThis.fetch = makeTransitionFetch({
      children: [],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.totalChildren).toBe(0);
    expect(result.terminalCount).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("attemptBarrierTransition transitions sprint parent managing → validating when zero children", async () => {
    // AC1: sprint archetype also auto-advances (managing → validating).
    globalThis.fetch = makeTransitionFetch({
      children: [],
      workflowId: "sprint",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.totalChildren).toBe(0);
  });

  it("zero-child auto-advance does not fire for non-orchestrator workflows", async () => {
    // AC1 scope guard: only ux-audit and sprint should auto-advance on zero children.
    globalThis.fetch = makeTransitionFetch({
      children: [],
      workflowId: "dev-impl",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(false);
  });

  it("zero-child auto-advance does not fire if parent is not in managing state", async () => {
    // If the parent has already moved past managing (race), don't double-advance.
    globalThis.fetch = makeTransitionFetch({
      children: [],
      workflowId: "ux-audit",
      parentState: "review",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(false);
  });
});

// ── AC2: All children already done (race condition) ──────────────────────

describe("AC2: Parent where all children are already done auto-advances on entry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("evaluateBarrier returns allTerminal=true when all children are done", async () => {
    // AC2: When children are already terminal at entry time (race between
    // fan-out completion and barrier check), the barrier is satisfied.
    // This already works — regression guard.
    globalThis.fetch = makeChildrenFetch([
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:escape"] },
    ]);

    const result = await evaluateBarrier("AI-1730", "Bearer tok");

    expect(result.allTerminal).toBe(true);
    expect(result.totalChildren).toBe(2);
    expect(result.terminalCount).toBe(2);
  });

  it("attemptBarrierTransition transitions when all children are already done at entry", async () => {
    // AC2: Race condition — children finished before the managing-state entry
    // barrier check runs. Should still auto-advance.
    // This already works — regression guard.
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
        { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.totalChildren).toBe(2);
    expect(result.terminalCount).toBe(2);
  });

  it("auto-advance works with single child already done", async () => {
    // AC2 edge case: exactly one child, already done.
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.totalChildren).toBe(1);
  });
});

// ── AC3: N ≥ 1 in-progress children → continues to wait ────────────────────

describe("AC3: Parent with N ≥ 1 in-progress children continues to wait", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("evaluateBarrier returns allTerminal=false when some children are in-progress", async () => {
    // AC3: The existing behavior must be preserved — parents with active
    // children continue to wait.
    globalThis.fetch = makeChildrenFetch([
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:implementation"] },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
    ]);

    const result = await evaluateBarrier("AI-1730", "Bearer tok");

    expect(result.allTerminal).toBe(false);
    expect(result.totalChildren).toBe(2);
    expect(result.terminalCount).toBe(1);
  });

  it("attemptBarrierTransition does NOT transition when children are in-progress", async () => {
    // AC3: Regression — this must not change.
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:implementation"] },
        { identifier: "AI-2002", labels: ["wf:dev-impl", "state:code-review"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(false);
    expect(result.error).toBeUndefined(); // Not an error — just not ready
  });

  it("single in-progress child keeps parent in managing", async () => {
    // AC3: N=1 in-progress is still "wait".
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:write-tests"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(false);
  });

  it("all children in intake (pre-implementation) keeps parent in managing", async () => {
    // AC3: children haven't started yet.
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:intake"] },
        { identifier: "AI-2002", labels: ["wf:dev-impl", "state:intake"] },
        { identifier: "AI-2003", labels: ["wf:dev-impl", "state:intake"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await attemptBarrierTransition("AI-1730", "Bearer tok");

    expect(result.transitioned).toBe(false);
    expect(result.totalChildren).toBe(3);
  });
});

// ── AC4: No change to story-series / story-lesson behaviour ──────────────

describe("AC4: Existing fan-out behaviour preserved (story-series/story-lesson always spawn ≥ 1 child)", () => {
  it("isChildTerminal correctly identifies done as terminal", () => {
    // AC4 regression: fan-out creates dev-impl children that are NOT terminal.
    // If the zero-child change inadvertently broke terminal detection,
    // the fan-out path would incorrectly auto-advance.
    expect(isChildTerminal(["wf:dev-impl", "state:done"])).toBe(true);
    expect(isChildTerminal(["wf:dev-impl", "state:escape"])).toBe(true);
  });

  it("isChildTerminal correctly identifies non-terminal states", () => {
    // AC4 regression: after fan-out, children start in intake or implementation.
    // These must NOT be considered terminal.
    expect(isChildTerminal(["wf:dev-impl", "state:intake"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:implementation"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:write-tests"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:code-review"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:review"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:managing"])).toBe(false);
  });

  it("evaluateBarrier returns allTerminal=false when N ≥ 1 child in non-terminal state", async () => {
    // AC4 regression: After a successful fan-out of story-series/story-lesson,
    // the parent has ≥ 1 non-terminal child. The barrier must NOT auto-advance.
    globalThis.fetch = makeChildrenFetch([
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:intake"] },
    ]);

    const result = await evaluateBarrier("AI-1730", "Bearer tok");

    expect(result.allTerminal).toBe(false);
    expect(result.totalChildren).toBe(1);
  });

  it("evaluateBarrier returns allTerminal=true only when every single child is terminal", async () => {
    // AC4 regression: N children where all are done → barrier IS satisfied.
    // This is the normal completion path that must still work.
    globalThis.fetch = makeChildrenFetch([
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "AI-2003", labels: ["wf:dev-impl", "state:done"] },
    ]);

    const result = await evaluateBarrier("AI-1730", "Bearer tok");

    expect(result.allTerminal).toBe(true);
    expect(result.totalChildren).toBe(3);
    expect(result.terminalCount).toBe(3);
  });
});

// ── onManagingEntry: entry-time hook (new export required) ───────────────

describe("onManagingEntry — entry-time barrier check (AI-1730)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("AC1: immediately transitions ux-audit parent with zero children", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({ children: [], workflowId: "ux-audit", parentState: "managing" });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
    expect(result!.totalChildren).toBe(0);
  });

  it("AC1: immediately transitions sprint parent with zero children", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({ children: [], workflowId: "sprint", parentState: "managing" });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
  });

  it("AC2: immediately transitions when all children are already done at entry (race condition)", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
        { identifier: "AI-2002", labels: ["wf:dev-impl", "state:escape"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
  });

  it("AC3: does NOT transition when N ≥ 1 in-progress children exist", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:implementation"] },
        { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result?.transitioned ?? false).toBe(false);
  });

  it("AC3: does NOT transition when a single in-progress child exists", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:write-tests"] },
      ],
      workflowId: "ux-audit",
      parentState: "managing",
    });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result?.transitioned ?? false).toBe(false);
  });

  it("does NOT transition if parent is not in managing state (double-advance guard)", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({
      children: [],
      workflowId: "ux-audit",
      parentState: "review",
    });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result?.transitioned ?? false).toBe(false);
  });
});

// ── vocab-builder / word-build: conditional-spawning workflows ────────────

describe("vocab-builder / word-build workflows — zero-child auto-advance (AI-1730)", () => {
  // These workflows spawn 0..N children. The bug manifests here because:
  //   vocab-builder spawns 0..N wf:word-build children (0 when audit finds all words correct)
  //   word-build spawns 0 or 1 wf:vocab-image children (0 when word already has an image)
  // In both cases, zero children must trigger immediate auto-advance from managing.

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("AC1: vocab-builder parent with zero children auto-advances", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({ children: [], workflowId: "vocab-builder", parentState: "managing" });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
  });

  it("AC1: word-build parent with zero children auto-advances", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({ children: [], workflowId: "word-build", parentState: "managing" });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
  });

  it("AC2: word-build parent with single vocab-image child already done auto-advances (race condition)", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:vocab-image", "state:done"] },
      ],
      workflowId: "word-build",
      parentState: "managing",
    });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
  });

  it("AC3: word-build parent with in-progress vocab-image child does NOT auto-advance", async () => {
    const fn = requireOnManagingEntry();
    globalThis.fetch = makeTransitionFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:vocab-image", "state:generating"] },
      ],
      workflowId: "word-build",
      parentState: "managing",
    });

    const result = await fn("AI-1730", "Bearer tok");

    expect(result?.transitioned ?? false).toBe(false);
  });
});
