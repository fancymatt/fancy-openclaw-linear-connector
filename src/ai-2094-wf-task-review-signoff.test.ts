/**
 * AI-2094 — wf:task review→Done edge: failing tests (TDD, write-tests state).
 *
 * Defect (surfaced live on GEN-103): a `wf:task` ticket that reaches `review`
 * looks un-closable through the normal states. Two symptoms, one confirmed
 * root cause (Igor diagnosis, Astrid-confirmed):
 *
 *   (a) `approve` "silently declines" — review, sign-off and doing all map to
 *       native_state: todo, so `approve` advances the state:* label
 *       review→sign-off but the Linear column stays To Do. It LOOKS like nothing
 *       happened; the ticket actually needs a SECOND continue (`accept`, run by
 *       the requester) to reach Done.
 *   (b) `continue-workflow` "mis-routes to assign" — getCurrentState returns the
 *       FIRST /^state:/i label via .find(); a stale/duplicate `state:routing`
 *       label (never stripped) binds resolution to `routing`, whose continue
 *       transition is `assign` — bouncing the ticket back to routing.
 *
 * These tests grade the fix against the AC-of-record captured at intake by
 * astrid (2026-07-11). Each test names the AC it proves. Tests that assert NEW
 * behavior (AC2/AC3/AC5) are RED against current code; tests that guard a
 * load-bearing invariant the fix must PRESERVE (AC1/AC4) are green-guards and
 * are labeled as such (they go red only under the rejected fix direction #1 or a
 * label-hygiene regression).
 *
 * Fixture: src/__fixtures__/canonical-task.yaml (verbatim task.yaml v1).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  resolveMetaIntent,
  buildStateTransitionReminder,
  applyStateTransition,
  resolveTransitionTargets,
  resolveTransitionDelegate,
  loadWorkflowDefById,
  resetWorkflowCache,
  type WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

// Capability policy staffing task's three owner_roles so role resolution
// (resolveBodiesForRole / resolveTransitionTargets) works in-process.
const TASK_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]

bodies:
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: astrid
    container: steward
    fills_roles: [department-head]
  - id: worker1
    container: dev
    fills_roles: [worker]
  - id: worker2
    container: dev
    fills_roles: [worker]
`;

const TOK = "Bearer test-token";
const ISSUE = "AI-2094";

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Fetch mock for the read-only surfaces (resolveMetaIntent / fetchTicketContext,
 * buildStateTransitionReminder / fetchWorkflowLabels). Both queries return
 * `issue.labels.nodes[].name`; the labels are returned in the order given, so a
 * caller can encode a stale-label ordering.
 */
function makeCtxFetch(labelNames: string[]): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("TeamStates")) {
      return jsonResponse({ data: { team: { states: { nodes: [] } } } });
    }
    return jsonResponse({
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
          delegate: null,
        },
      },
    });
  }) as unknown as typeof globalThis.fetch;
}

interface FetchCall {
  body: { query?: string; variables?: Record<string, unknown> };
}

/**
 * Fetch mock for applyStateTransition: serves IssueWithLabels, TeamLabels,
 * TeamStates, issueLabelCreate and the ApplyAtomicTransition mutation, and
 * records every call so a test can inspect the label set written.
 */
function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamLabels: Array<{ id: string; name: string }>;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mock = (async (_url: string, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as FetchCall["body"];
    calls.push({ body: parsed });
    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: "internal-uuid",
            identifier: ISSUE,
            team: { id: "team-uuid" },
            labels: { nodes: opts.issueLabels },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return jsonResponse({ data: { team: { labels: { nodes: opts.teamLabels } } } });
    }
    if (query.includes("TeamStates")) {
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-doing-uuid", name: "Doing", type: "started" },
                { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
                { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("issueLabelCreate")) {
      return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("UpdateDelegate")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: mock, calls };
}

describe("AI-2094 — wf:task review→Done edge (label hygiene + legibility)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalDefPath: string | undefined;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let tmpDir: string;

  beforeAll(() => {
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2094-test-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TASK_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // Single-file mode → the registry holds exactly the `task` def.
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK_FIXTURE;
  });

  afterAll(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    };
    restore("WORKFLOW_DEF_PATH", originalDefPath);
    restore("WORKFLOW_DEFS_DIR", originalDefsDir);
    restore("CAPABILITY_POLICY_PATH", originalPolicyPath);
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── AC1: Two-gate machine preserved (regression guard) ──────────────────
  // "NO review → done edge. Forward path stays
  //  review --approve--> sign-off --accept--> done."
  // Green-guard: goes RED under the rejected fix direction #1 (making review's
  // approve resolve to `done` terminal), which would delete the requester gate.
  describe("AC1 — two-gate machine (no review→done edge)", () => {
    let def: WorkflowDef;
    beforeEach(async () => {
      const loaded = await loadWorkflowDefById("task");
      if (!loaded) throw new Error("task def failed to load from canonical-task.yaml");
      def = loaded;
    });

    it("review advances to sign-off on approve — never directly to done", () => {
      const review = def.states.find((s) => s.id === "review");
      expect(review).toBeDefined();
      const approve = review!.transitions?.find((t) => t.command === "approve");
      expect(approve?.to).toBe("sign-off");
      // The load-bearing invariant: review has NO edge whose target is done.
      const toDone = (review!.transitions ?? []).filter((t) => t.to === "done");
      expect(toDone).toHaveLength(0);
    });

    it("done is reachable ONLY through sign-off (anti-orphan, AI-1375)", () => {
      const signOff = def.states.find((s) => s.id === "sign-off");
      expect(signOff!.transitions?.find((t) => t.command === "accept")?.to).toBe("done");
      // No state other than sign-off may target done.
      const nonSignOffToDone = def.states
        .filter((s) => s.id !== "sign-off")
        .flatMap((s) => (s.transitions ?? []).map((t) => ({ from: s.id, to: t.to })))
        .filter((e) => e.to === "done");
      expect(nonSignOffToDone).toEqual([]);
    });

    it("done is a terminal state", () => {
      const done = def.states.find((s) => s.id === "done");
      expect(done?.kind).toBe("terminal");
    });
  });

  // ── AC2 + AC5: stale state:routing must never bind continue → assign ─────
  // "a stale state:routing can never bind continue-workflow to assign."
  // AC5: confirm against the GEN-103-shaped label dump (two state:* labels).
  // RED today: getCurrentState().find() returns the FIRST state:* label; with
  // routing ordered first, resolution binds to routing → continue = assign.
  describe("AC2/AC5 — duplicate/stale state:* label resolution", () => {
    it("control: a clean review ticket resolves continue → approve", async () => {
      globalThis.fetch = makeCtxFetch(["wf:task", "state:review"]);
      const res = await resolveMetaIntent("continue-workflow", ISSUE, TOK);
      expect(res).toEqual({ resolved: "approve" });
    });

    it("stale state:routing present (routing ordered first) still resolves continue → approve, NOT assign", async () => {
      // GEN-103 shape: a prior state:routing label was never stripped, so the
      // ticket carries BOTH state:routing and state:review.
      globalThis.fetch = makeCtxFetch(["wf:task", "state:routing", "state:review"]);
      const res = await resolveMetaIntent("continue-workflow", ISSUE, TOK);
      expect(res).not.toEqual({ resolved: "assign" });
      expect(res).toEqual({ resolved: "approve" });
    });

    it("resolution is order-independent: stale state:routing ordered last also resolves to approve", async () => {
      globalThis.fetch = makeCtxFetch(["wf:task", "state:review", "state:routing"]);
      const res = await resolveMetaIntent("continue-workflow", ISSUE, TOK);
      expect(res).not.toEqual({ resolved: "assign" });
      expect(res).toEqual({ resolved: "approve" });
    });
  });

  // ── AC2: single-state:*-label invariant on transition (write path) ──────
  // "every transition strips the prior state:* label so exactly one is ever
  //  present." Even when a ticket has drifted to TWO state:* labels, applying a
  //  transition must leave exactly one (the destination).
  describe("AC2 — transition strips prior state:* labels (exactly one remains)", () => {
    it("approve from review strips both stale state:routing and state:review, leaving only state:sign-off", async () => {
      const stateLabelIds = new Set(["routing-lbl", "review-lbl", "signoff-lbl"]);
      const { fetch: mock, calls } = makeTransitionFetch({
        issueLabels: [
          { id: "wf-lbl", name: "wf:task" },
          { id: "routing-lbl", name: "state:routing" }, // stale, never stripped
          { id: "review-lbl", name: "state:review" },
          { id: "prio-lbl", name: "priority:high" },
        ],
        teamLabels: [{ id: "signoff-lbl", name: "state:sign-off" }],
      });
      globalThis.fetch = mock;

      // sourceStateOverride pins the true source; delegateOverride:null skips
      // delegate resolution (roster-independent) so we isolate the label swap.
      const result = await applyStateTransition("approve", ISSUE, TOK, {
        sourceStateOverride: "review",
        delegateOverride: null,
      });
      expect(result.status).toBe("applied");

      const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
      expect(updateCall).toBeDefined();
      const labelIds = (updateCall!.body.variables as { labelIds: string[] }).labelIds;

      // Non-state labels are preserved.
      expect(labelIds).toContain("wf-lbl");
      expect(labelIds).toContain("prio-lbl");
      // Exactly one state:* label — the destination — remains.
      const stateLabels = labelIds.filter((id) => stateLabelIds.has(id));
      expect(stateLabels).toEqual(["signoff-lbl"]);
      expect(labelIds).not.toContain("routing-lbl");
      expect(labelIds).not.toContain("review-lbl");
    });
  });

  // ── AC3: same-column legibility for review --approve ────────────────────
  // The CLI / wake-brief response must explicitly state that the ticket
  // "advanced to sign-off — requester must run `accept` (continue-workflow) to
  // close", so a todo→todo transition is not perceived as a silent decline.
  // RED today: buildStateTransitionReminder emits a generic "You are now in
  // state: sign-off" with no advance/requester/close framing.
  describe("AC3 — same-column advance is legible (not a silent decline)", () => {
    it("approve response names the sign-off advance and the required second accept gate", async () => {
      globalThis.fetch = makeCtxFetch(["wf:task", "state:review"]);
      const msg = await buildStateTransitionReminder("approve", ISSUE, TOK);
      expect(msg).not.toBeNull();
      const text = msg ?? "";
      // Frames it as a real forward move to sign-off...
      expect(text.toLowerCase()).toContain("advanced to sign-off");
      // ...owned by the requester...
      expect(text.toLowerCase()).toContain("requester");
      // ...who must run `accept` to close (the second continue gate).
      expect(text.toLowerCase()).toContain("accept");
      expect(text.toLowerCase()).toContain("close");
    });
  });

  // ── AC4: regression — two-continue tail lands in Done, delegate/assignee
  //         cleared (regression guard). "Note the tail is TWO continue steps."
  // Green-guard: encodes the happy-path contract the fix must not regress.
  describe("AC4 — review→approve→sign-off→accept→done is a two-continue tail", () => {
    it("both approve (at review) and accept (at sign-off) are continue-workflow steps", async () => {
      // Continue step #1: review --approve--> sign-off.
      globalThis.fetch = makeCtxFetch(["wf:task", "state:review"]);
      expect(await resolveMetaIntent("continue-workflow", ISSUE, TOK)).toEqual({ resolved: "approve" });

      // Continue step #2: sign-off --accept--> done.
      globalThis.fetch = makeCtxFetch(["wf:task", "state:sign-off"]);
      expect(await resolveMetaIntent("continue-workflow", ISSUE, TOK)).toEqual({ resolved: "accept" });
    });

    it("landing in done clears the delegate and leaves no assignee (terminal)", async () => {
      const def = await loadWorkflowDefById("task");
      const signOff = def!.states.find((s) => s.id === "sign-off");
      const accept = signOff!.transitions?.find((t) => t.command === "accept");
      expect(accept?.generic).toBe("continue");

      // Delegate cleared at the terminal destination.
      const delegate = await resolveTransitionDelegate("done", accept, def!, ISSUE);
      expect(delegate).toBeNull();

      // No assignable body at a terminal destination (assignee cleared).
      const targets = await resolveTransitionTargets(accept!, def!);
      expect(targets.mode).toBe("none");
      expect(targets.bodies).toEqual([]);

      const done = def!.states.find((s) => s.id === "done");
      expect(done?.native_state).toBe("done");
    });
  });
});
