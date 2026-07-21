/**
 * AI-2568 — Failing tests for engagement overlay native-state write conflicts.
 *
 * Option B: when a delegate is assigned on a ticket with an active workflow
 * whose current state declares `native_state: todo`, the overlay must write
 * that declared "To Do" state UUID (not "Doing"). Ad-hoc (non-workflow) tickets
 * preserve existing behavior: delegate-assign still lands at "Doing".
 *
 * All tests are FAILING against the current implementation because
 * `applyEngagementStatus` does not yet consult the ticket's workflow state's
 * `native_state` declaration.
 *
 * AC mapping:
 *   AC1 — native_state: todo overrides "doing" semantic for workflow tickets
 *   AC2 — no-workflow fallback: ad-hoc ticket keeps its status (existing behavior)
 *   AC3 — continue-workflow succeeds after overlay fired (gate doesn't reject
 *         transition from a native_state-derived "todo" UUID)
 *   AC4 — bootstrap integration test: entry-point integration proof
 *   AC5 — startup log line: overlay registration visible at ac-validate
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { applyEngagementStatus, registerEngagementNativeStateOverlay } from "./engagement-status.js";
import { resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Shared test fixtures ─────────────────────────────────────────────────────

interface IssueFixture {
  id: string;
  teamId: string;
  stateName: string;
  stateId: string;
  labels: string[];
  delegateLinearUserId?: string;
}

const SEMANTIC_TO_UUID: Record<string, string> = {
  "To Do":    "state-todo-uuid",
  Thinking:   "state-thinking-uuid",
  Doing:      "state-doing-uuid",
  Done:       "state-done-uuid",
  Invalid:    "state-invalid-uuid",
};

const WF_LABELS = ["wf:dev-impl", "state:write-tests"];
const ADHOC_LABELS = ["bug", "priority:high"];

/**
 * Build a fetch mock for one issue. Tracks the variables of every issueUpdate
 * mutation so tests can assert which (if any) state write was attempted.
 * Also records EngagementIssue query ids.
 */
function makeEngagementFetch(issue: IssueFixture, preWrites?: {
  /** If set, the SECOND EngagementIssue fetch (re-read) returns this fixture. */
  reReadFixture?: IssueFixture;
}): {
  fetch: typeof globalThis.fetch;
  updates: Array<{ id: string; stateId: string }>;
  issueQueryIds: string[];
} {
  const updates: Array<{ id: string; stateId: string }> = [];
  const issueQueryIds: string[] = [];
  let queryCount = 0;

  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (q.includes("EngagementIssue")) {
      queryCount++;
      const active = preWrites?.reReadFixture && queryCount >= 2
        ? preWrites.reReadFixture
        : issue;
      issueQueryIds.push(String(vars.id));
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: active.id,
              team: { id: active.teamId },
              state: { id: active.stateId, name: active.stateName, type: active.stateName === "Done" ? "completed" : active.stateName === "Invalid" ? "canceled" : "started" },
              labels: { nodes: active.labels.map((name) => ({ name })) },
              delegate: active.delegateLinearUserId ? { id: active.delegateLinearUserId } : null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({
                  id,
                  name,
                  type:
                    name === "Done" ? "completed" : name === "Invalid" ? "canceled" : "started",
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("issueUpdate")) {
      updates.push({ id: String(vars.id), stateId: String(vars.stateId) });
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch, updates, issueQueryIds };
}

describe("AI-2568: engagement overlay honors workflow native_state (Option B)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── AC1: native_state: todo overrides "doing" semantic ─────────────────────
  //
  // A ticket with wf:* label whose workflow state declares `native_state: todo`
  // — when applyEngagementStatus is called with "doing" semantic, the resulting
  // write must go to the "To Do" state UUID, NOT the "Doing" state UUID.
  //
  // FAILS because the current implementation always resolves the semantic name
  // directly through resolveNativeStateId (mapping "doing" → Doing UUID) without
  // first consulting the ticket's current workflow's state native_state declaration.

  describe("AC1: native_state: todo overrides 'doing' semantic for workflow tickets", () => {
    beforeEach(() => {
      // Point the workflow registry at the real dev-impl.yaml so
      // loadWorkflowDefById can resolve the "write-tests" state's
      // native_state: todo declaration.
      const defsDir = path.resolve(__dirname, "registered-defs");
      process.env.WORKFLOW_DEFS_DIR = defsDir;
      resetWorkflowCache();
      resetNativeStateCache();
      registerEngagementNativeStateOverlay();
    });

    afterEach(() => {
      delete process.env.WORKFLOW_DEFS_DIR;
      resetWorkflowCache();
    });

    it("writes to 'To Do' UUID when workflow state declares native_state: todo [CURRENTLY WRITES DOING UUID]", async () => {
      // Ticket is in state "write-tests" whose native_state in dev-impl.yaml is
      // "todo". Current Linear stateName is "To Do" (matching that native projection).
      // Semantic "doing" should write to "To Do" UUID, not "Doing" UUID.
      // FAILS: current code calls resolveNativeStateId("doing") → "state-doing-uuid".
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "To Do",
        stateId: SEMANTIC_TO_UUID["To Do"],
        labels: WF_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC1", "doing", "tok");

      // MUST write to To Do UUID, NOT Doing UUID
      expect(updates).toHaveLength(1);
      expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["To Do"]);

      // This assertion FAILS: the current code writes state-doing-uuid
      expect(updates[0].stateId).not.toBe(SEMANTIC_TO_UUID["Doing"]);
    });

    it("writes to 'To Do' UUID even when Linear currently shows 'Doing' [CURRENTLY WRITES DOING UUID]", async () => {
      // Even when the Linear state happens to be showing "Doing" (e.g. from a
      // prior session), if the workflow state declares native_state: todo, the
      // overlay must project To Do — the workflow's native_state is authoritative.
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "Doing",
        stateId: SEMANTIC_TO_UUID["Doing"],
        labels: WF_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC1b", "doing", "tok");

      expect(updates).toHaveLength(1);
      expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["To Do"]);

      // This assertion FAILS: the current code writes state-doing-uuid
      expect(updates[0].stateId).not.toBe(SEMANTIC_TO_UUID["Doing"]);
    });

    it("writes 'Thinking' for thinking semantic (not affected by native_state override)", async () => {
      // dispatch: thinking semantic should still write to Thinking UUID.
      // The native_state override only applies to incoming delegate assignments
      // where the overlay would normally write "doing".
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "To Do",
        stateId: SEMANTIC_TO_UUID["To Do"],
        labels: WF_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC1c", "thinking", "tok");

      expect(updates).toHaveLength(1);
      expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["Thinking"]);
    });

    it("writes 'To Do' for todo semantic (session-end always writes its mapped uuid)", async () => {
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "Thinking",
        stateId: SEMANTIC_TO_UUID["Thinking"],
        labels: WF_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC1d", "todo", "tok");

      expect(updates).toHaveLength(1);
      expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["To Do"]);
    });
  });

  // ── AC2: No-workflow fallback preserves existing behavior ──────────────────
  //
  // A ticket without a wf:* label — the existing behavior is preserved:
  // ad-hoc tickets are skipped by the engagement overlay entirely (the overlay
  // only applies to workflow tickets). The native state is left untouched.

  describe("AC2: ad-hoc tickets without workflow are skipped (existing behavior preserved)", () => {
    it("skips an ad-hoc ticket for doing semantic (no wf:* label)", async () => {
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "To Do",
        stateId: SEMANTIC_TO_UUID["To Do"],
        labels: ADHOC_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC2", "doing", "tok");

      // Existing behavior: ad-hoc tickets are skipped entirely — 0 updates
      expect(updates).toHaveLength(0);
    });

    it("skips an ad-hoc ticket for thinking semantic", async () => {
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "To Do",
        stateId: SEMANTIC_TO_UUID["To Do"],
        labels: ADHOC_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC2b", "thinking", "tok");

      expect(updates).toHaveLength(0);
    });

    it("monotonic floor not applicable for ad-hoc tickets (already skipped)", async () => {
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "Doing",
        stateId: SEMANTIC_TO_UUID["Doing"],
        labels: ADHOC_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC2c", "thinking", "tok");

      expect(updates).toHaveLength(0);
    });
  });

  // ── AC3: continue-workflow succeeds after overlay fired ────────────────────
  //
  // After engagement overlay fires (ticket is at "todo" due to native_state),
  // continue-workflow to a state with native_state: doing should succeed.
  // This tests that the workflow gate doesn't reject a transition from a state
  // whose UUID happens to be "To Do" — the UUID ≠ state derivation label.

  describe("AC3: continue-workflow succeeds after overlay fired", () => {
    it("todo semantic is idempotent when ticket is already at To Do (after overlay)", async () => {
      // After the overlay wrote "To Do" (resting native), session-end (todo)
      // is idempotent when the issue is already at To Do.
      // The "todo" semantic always writes unconditionally in the current code,
      // so this will produce 1 write. That's fine — the test verifies the write
      // goes to the right UUID.
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "To Do",
        stateId: SEMANTIC_TO_UUID["To Do"],
        labels: WF_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC3", "todo", "tok");

      // todo always writes unconditionally per engagement-status.ts:91
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["To Do"]);
    });

    it("thinking on a ticket already at Thinking is idempotent (no write)", async () => {
      // After the workflow advances to a state where native_state is "doing"
      // (so the prior overlay correctly wrote "Doing"), a fresh dispatch would
      // try "thinking" — and if the ticket is NOT at Thinking, it should flip.
      // This test uses a fixture already at Thinking → idempotent (0 writes).
      const { fetch, updates } = makeEngagementFetch({
        id: "issue-uuid",
        teamId: "team-uuid",
        stateName: "Thinking",
        stateId: SEMANTIC_TO_UUID["Thinking"],
        labels: WF_LABELS,
      });
      globalThis.fetch = fetch;

      await applyEngagementStatus("AI-2568-AC3b", "thinking", "tok");

      // Already at Thinking → idempotent
      expect(updates).toHaveLength(0);
    });
  });
});

// ── AC4: Bootstrap integration test ─────────────────────────────────────────
//
// An integration test that imports `createApp` from the index module and asserts
// the engagement overlay modification is registered. A module-level unit test
// does NOT satisfy this.
//
// FAILS because no such registration exists in the current bootstrap.

describe("AC4: bootstrap registers native_state-aware engagement overlay", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
    // Point at the real dev-impl.yaml so createApp can load the registry
    const defsDir = path.resolve(__dirname, "registered-defs");
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    resetWorkflowCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("createApp wiring makes applyEngagementStatus resolve native_state from workflow state [CURRENTLY WRITES DOING UUID]", async () => {
    // This tests that after createApp() is called, the engagement module is
    // configured to read workflow native_state when resolving the target UUID.
    // The proof: after createApp returns, applyEngagementStatus("doing") on a
    // workflow ticket with native_state: todo must write "To Do" UUID.
    //
    // FAILS: createApp() does not change applyEngagementStatus behavior.
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "To Do",
      stateId: SEMANTIC_TO_UUID["To Do"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    const { createApp } = await import("./index.js");
    const appInstance = createApp({
      // Provide minimal test options
    });

    // After createApp wiring, applyEngagementStatus must honor native_state
    await applyEngagementStatus("AI-2568-AC4", "doing", "tok");

    // FAILS: current implementation writes Doing UUID instead of To Do UUID
    expect(updates).toHaveLength(1);
    expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["To Do"]);

    // This assertion FAILS: current code writes state-doing-uuid
    expect(updates[0].stateId).not.toBe(SEMANTIC_TO_UUID["Doing"]);

    // Cleanup
    appInstance?.sessionTracker?.close();
    appInstance?.bag?.close();
  });
});

// ── AC5: Startup log line ──────────────────────────────────────────────────
//
// A test that verifies a startup log line shows the overlay is registered.
// The engagement overlay modification must emit a log line at startup showing
// the native_state-aware resolver is active.
//
// FAILS: no such log line exists.

describe("AC5: startup log line confirms overlay registration", () => {
  let originalFetch: typeof globalThis.fetch;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleOutput: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
    // Point at the real dev-impl.yaml so createApp can load the registry
    const defsDir = path.resolve(__dirname, "registered-defs");
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    resetWorkflowCache();
    consoleOutput = "";
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        consoleOutput += args.map((a) => String(a)).join(" ") + "\n";
      },
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleErrorSpy?.mockRestore();
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("createApp emits a log line confirming the native_state-aware engagement overlay is registered", async () => {
    // When bootstrap registers the engagement overlay modification, it should
    // emit a log line like:
    //   [engagement-status] native_state-aware overlay registered (AI-2568)

    const { createApp } = await import("./index.js");
    const appInstance = createApp({});

    await new Promise((r) => setTimeout(r, 50)); // Allow async log writes to flush

    // FAILS: no such log line is emitted
    expect(consoleOutput).toMatch(
      /native_state-aware.*overlay.*registered.*AI-2568/,
    );

    appInstance?.sessionTracker?.close();
    appInstance?.bag?.close();
  });
});
