/**
 * AI-2095: wf:task has a working completion path and a recoverable break-glass.
 *
 * Two defects, both in the `task` workflow definition:
 *
 *   1. Completion path. The ticket reported that `continue-workflow` from
 *      `review` mis-resolved to `assign` (demanding an assignment target) and
 *      that the review→done edge could not be triggered by an agent verb. The
 *      generic-verb resolver (`resolveMetaIntent`) resolves `continue-workflow`
 *      to the current state's `generic: continue` edge — so the fix is to
 *      guarantee EVERY forward edge carries `generic: continue`, letting a
 *      single agent verb carry a ticket intake → … → done. These tests pin that
 *      contract per state (and in particular assert review resolves to `approve`,
 *      NOT `assign`).
 *
 *   2. Break-glass roach motel. `break_glass.to` pointed at a terminal `escape`
 *      state whose only legal move was `escape` again, so an escaped ticket
 *      could never reach a clean terminal by agent verbs. The fix mirrors the
 *      dev-impl AI-1710 model: `break_glass.to: intake` and the terminal escape
 *      state is removed. These tests assert the fixed structure.
 *
 * The fixture `canonical-task.yaml` mirrors the deployed `task` def WITH the fix
 * applied (same pattern as `canonical-dev-impl.yaml`).
 */

import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  resolveMetaIntent,
  loadWorkflowRegistry,
  resetWorkflowCache,
  type WorkflowDef,
} from "./workflow-gate.js";

const CANONICAL_TASK = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");
const ISSUE_ID = "issue-uuid";
const TOKEN = "test-token";

/** Minimal IssueContext fetch mock: the ticket carries the wf:task label. */
function mockTaskLabelFetch(): typeof globalThis.fetch {
  return (async (url: unknown) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    return new Response(
      JSON.stringify({
        data: { issue: { labels: { nodes: [{ name: "wf:task" }] }, delegate: null } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

describe("AI-2095: wf:task completion path + recoverable break-glass", () => {
  let originalFetch: typeof globalThis.fetch;
  let priorDefPath: string | undefined;
  let priorDefsDir: string | undefined;

  beforeEach(() => {
    priorDefPath = process.env.WORKFLOW_DEF_PATH;
    priorDefsDir = process.env.WORKFLOW_DEFS_DIR;
    // Single-file mode: the registry holds exactly this def, keyed by its id ("task").
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK;
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockTaskLabelFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (priorDefPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
    else process.env.WORKFLOW_DEF_PATH = priorDefPath;
    if (priorDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = priorDefsDir;
    resetWorkflowCache();
  });

  // ── Defect 1: completion path — continue-workflow carries the whole chain ──

  it.each([
    ["intake", "request"],
    ["routing", "assign"],
    ["doing", "submit"],
    ["review", "approve"],
    ["sign-off", "accept"],
  ])("continue-workflow from '%s' resolves to '%s'", async (state, expected) => {
    const result = await resolveMetaIntent("continue-workflow", ISSUE_ID, TOKEN, state);
    expect(result).toEqual({ resolved: expected });
  });

  it("review's forward verb is 'approve', NOT 'assign' (the reported mis-resolution)", async () => {
    const result = await resolveMetaIntent("continue-workflow", ISSUE_ID, TOKEN, "review");
    expect(result).toEqual({ resolved: "approve" });
    expect(result).not.toEqual({ resolved: "assign" });
  });

  it.each([
    ["review", "request-changes"],
    ["sign-off", "reject"],
  ])("request-revision from '%s' resolves to '%s'", async (state, expected) => {
    const result = await resolveMetaIntent("request-revision", ISSUE_ID, TOKEN, state);
    expect(result).toEqual({ resolved: expected });
  });

  it("every non-terminal state has a generic:continue forward edge (no dead ends)", async () => {
    const def = (await loadWorkflowRegistry()).get("task") as WorkflowDef;
    const nonTerminal = def.states.filter((s) => s.kind !== "terminal");
    // Collect any state missing a generic:continue forward edge; the assertion
    // reports the offending state ids directly (jest's expect() takes no message arg).
    const deadEnds = nonTerminal
      .filter((s) => !(s.transitions ?? []).some((t) => t.generic === "continue"))
      .map((s) => s.id);
    expect(deadEnds).toEqual([]);
  });

  // ── Defect 2: break-glass is recoverable, not a terminal trap ──────────────

  it("break_glass re-enters at 'intake', not a terminal escape state", async () => {
    const def = (await loadWorkflowRegistry()).get("task") as WorkflowDef;
    expect(def.break_glass?.command).toBe("escape");
    expect(def.break_glass?.to).toBe("intake");
  });

  it("the terminal 'escape' roach-motel state is removed", async () => {
    const def = (await loadWorkflowRegistry()).get("task") as WorkflowDef;
    expect(def.states.find((s) => s.id === "escape")).toBeUndefined();
  });

  it("break_glass.to points at a real, non-terminal state with a forward exit", async () => {
    const def = (await loadWorkflowRegistry()).get("task") as WorkflowDef;
    const target = def.states.find((s) => s.id === def.break_glass?.to);
    // break_glass.to must reference a defined, non-terminal state.
    expect(target).toBeDefined();
    expect(target?.kind).not.toBe("terminal");
    // intake affords both a forward path (request→routing→…→done) and a demote exit.
    const commands = (target?.transitions ?? []).map((t) => t.command);
    expect(commands).toContain("demote");
    expect(commands).toContain("request");
  });

  // ── Deploy-critical: removing `escape` must carry a migrations mapping ──────
  // AC3 (AI-1914, validateDefStateRemovals) refuses to ACTIVATE a def that drops
  // a state without a migrations entry or a strand_acknowledged ack. Omitting
  // this would (a) fail the v2 def closed on load and (b) leave the already-wedged
  // `state:escape` tickets (GEN-103, AI-1755) stranded — the def-state-migration
  // sweep only relabels states that have a mapping. Target = break_glass.to.
  it("maps the removed 'escape' state to 'intake' (AC3 activation + auto-migration of wedged tickets)", async () => {
    const def = (await loadWorkflowRegistry()).get("task") as WorkflowDef;
    expect(def.migrations?.escape).toBe("intake");
    expect(def.migrations?.escape).toBe(def.break_glass?.to);
    // The mapping target must itself be a real, live state (else the sweep re-strands).
    expect(def.states.find((s) => s.id === def.migrations?.escape)).toBeDefined();
  });
});
