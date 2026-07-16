/**
 * AI-2472: Governed transition applies state change but drops its --comment body
 * and reports failure.
 *
 * Observed live on AI-2437 ac-validate: `validated --comment-file x.md` sent TWO
 * GraphQL mutations — an `issueUpdate` (state change) and a `commentCreate`
 * (post the comment body), both under the same sticky `X-Openclaw-Linear-Intent`
 * header. The issueUpdate passed B1 (pre-transition state `ac-validate`) and
 * landed. The commentCreate then hit B1 which re-evaluated the command against
 * the post-transition state `done` — `validated` is not legal in `done` — and
 * rejected. Result: state changed, delegate cleared, comment never posted, CLI
 * reported failure.
 *
 * ── AC of record (captured at intake by astrid, 2026-07-16) ──────────────────
 *   AC1 — "Post the comment before, or atomically with, the state write" (Option A).
 *   AC2 — "Gate B1/W1 enforcement to skip commentCreate mutations on the intent
 *          path" (Option B, defense-in-depth).
 *   AC3 — "Do not run the legality re-check against post-write state" (Option C
 *          simplification: both A+B).
 *   AC4 — "The issueUpdate state transition is still applied correctly" (no
 *          regression: the issueUpdate part of the same request succeeds).
 *   AC5 — "If a comment body is present on the request, the commentCreate
 *          mutation is forwarded to Linear (not silently dropped)" — the
 *          commentCreate mutation is a legitimate mutation and should not be
 *          blocked by workflow state re-gating.
 *
 * These tests are RED against current code — the commentCreate is rejected by
 * B1 after the state transition has already landed, so assertions that the
 * commentCreate was forwarded (AC2, AC5) or that the response contains no
 * workflow-gate error (AC1, AC3) fail.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";
import { createApp } from "./index.js";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 9
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid-ai-2472";
const ISSUE_IDENTIFIER = "AI-2472";

function contextFor(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${state}` }] },
        delegate: delegateUserId ? { id: delegateUserId } : null,
      },
    },
  };
}

function withIdsFor(state: string): object {
  return {
    data: {
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:dev-impl" },
            { id: `${state}-lbl`, name: `state:${state}` },
          ],
        },
      },
    },
  };
}

const TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "ac-validate-lbl", name: "state:ac-validate" },
          { id: "implementation-lbl", name: "state:implementation" },
          { id: "intake-lbl", name: "state:intake" },
          { id: "done-lbl", name: "state:done" },
        ],
      },
    },
  },
};

const TEAM_STATES = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-doing", name: "Doing", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    },
  },
};

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

/**
 * Mutable fetch mock that tracks calls and supports independent context/withIds
 * state, plus exposes setContext for the transition between write 1 and write 2.
 */
function makeMutableFetch(initial: { state: string; delegate: string | null }): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  setContext: (state: string, delegate: string | null) => void;
  setWithIdsState: (state: string) => void;
} {
  let currentContext = contextFor(initial.state, initial.delegate);
  let withIdsState = initial.state;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const q = parsed.query ?? "";

    const json = (payload: object) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      return json(currentContext);
    }
    if (q.includes("IssueWithLabels")) {
      return json(withIdsFor(withIdsState));
    }
    if (q.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: TEAM_LABELS.data.team.labels } } } });
    }
    if (q.includes("TeamLabels")) {
      return json(TEAM_LABELS);
    }
    if (q.includes("TeamStates")) {
      return json(TEAM_STATES);
    }
    if (q.includes("VerifyTransitionWrite")) {
      return json({ data: { issue: null } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-16T00:00:00Z", url: "u" } }, issueUpdate: { success: true } } });
  };

  return {
    fetch: mockFetch,
    calls,
    setContext: (state, delegate) => { currentContext = contextFor(state, delegate); },
    setWithIdsState: (state) => { withIdsState = state; },
  };
}

function commentCreateBody(body: string) {
  return {
    operationName: "AddComment",
    query: `mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id createdAt url } }
    }`,
    variables: { issueId: ISSUE_UUID, body },
  };
}

function issueUpdateTriggerBody() {
  return {
    operationName: "TriggerTransition",
    query: `mutation TriggerTransition($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id: ISSUE_UUID },
  };
}

const commentCreateCount = (calls: Array<{ query: string }>) =>
  calls.filter((c) => c.query.includes("commentCreate") && !c.query.includes("VerifyTransitionWrite") && !c.query.includes("SatisfiedByComment") && !c.query.includes("VerifyComment")).length;

// ── Suite ────────────────────────────────────────────────────────────────────

describe("proxy — AI-2472: commentCreate must NOT be dropped under sticky intent after state transition", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2472-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Helper: send a request to the proxy with the standard governed-ticket headers.
   */
  const sendWithIntent = (payload: object, intent = "continue-workflow") =>
    request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", intent)
      .send(payload);

  it("AC4: issueUpdate state transition is applied correctly (the first mutation succeeds)", async () => {
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    const res1 = await sendWithIntent(issueUpdateTriggerBody());
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // The ApplyAtomicTransition should have been issued exactly once.
    const atomicCalls = mf.calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);

    // The intent was meta-resolved to `validated`.
    expect(res1.body._workflowTransition).toBeDefined();
    expect(res1.body._workflowTransition.to).toBe("done");
  });

  it("AC5: commentCreate forwarded to Linear when sent under sticky intent AFTER state transition — comment is NOT dropped", async () => {
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    // Write 1: issueUpdate (state transition) — succeeds.
    const res1 = await sendWithIntent(issueUpdateTriggerBody());
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // Advance the context to `done` to simulate the state transition having
    // landed. The live reads now return the terminal state.
    mf.setContext("done", null);
    mf.setWithIdsState("done");

    // Count how many commentCreate calls were forwarded by write 1.
    const afterFirst = commentCreateCount(mf.calls);

    // Write 2: commentCreate under the same sticky intent.
    // The fix must forward this to Linear, NOT reject it at B1.
    const res2 = await sendWithIntent(commentCreateBody("reviewer sign-off: all ACs verified"));

    // ── THIS IS THE FIX ASSERTION ─────────────────────────────────────────────
    // The commentCreate mutation must be forwarded to Linear, not blocked at B1.
    // Under the buggy code, B1 rejects it because `validated` is not legal in
    // terminal `done`, and the response contains a workflow-gate error.
    expect(res2.body.errors).toBeUndefined();

    // The commentCreate was forwarded to Linear (one additional call).
    const afterSecond = commentCreateCount(mf.calls);
    expect(afterSecond).toBe(afterFirst + 1);

    // The forwarded commentCreate contains the comment body.
    const forwardedComments = mf.calls.filter(
      (c) => c.query.includes("commentCreate") &&
        !c.query.includes("VerifyTransitionWrite") &&
        !c.query.includes("SatisfiedByComment") &&
        !c.query.includes("VerifyComment") &&
        c.variables?.body === "reviewer sign-off: all ACs verified"
    );
    expect(forwardedComments.length).toBeGreaterThanOrEqual(1);
  });

  it("AC2: commentCreate forwarded count increases — not blocked by B1", async () => {
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    // Write 1: issueUpdate
    await sendWithIntent(issueUpdateTriggerBody());
    const afterFirst = commentCreateCount(mf.calls);

    // Advance context to post-transition state
    mf.setContext("done", null);
    mf.setWithIdsState("done");

    // Write 2: commentCreate
    const res2 = await sendWithIntent(commentCreateBody("sign-off record"));
    expect(res2.status).toBe(200);

    // The commentCreate must reach Linear. Under the bug, this assertion
    // fails because B1 rejects the mutation before forwarding.
    const afterSecond = commentCreateCount(mf.calls);
    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("AC3: commentCreate sent after state transition returns success (no workflow-gate error)", async () => {
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    // Write 1: issueUpdate — transitions ac-validate → done
    await sendWithIntent(issueUpdateTriggerBody());

    // Advance context to done (post-transition)
    mf.setContext("done", null);
    mf.setWithIdsState("done");

    // Write 2: commentCreate — must NOT be blocked by B1 after fix
    const res2 = await sendWithIntent(commentCreateBody("AC sign-off record"));

    // The response must NOT contain a workflow-gate rejection.
    // Under the bug, this contains `[Proxy] 'continue-workflow' has no continue
    // transition in state 'done'`.
    expect(res2.body.errors).toBeUndefined();
    // The response should have data (from the forwarded Linear response).
    expect(res2.body.data).toBeDefined();
  });

  it("AC1: the comment body survives in a two-mutation sequence (regression: no B1 rejection on commentCreate)", async () => {
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("implementation");

    // submit (implementation → ac-validate) with a comment.
    // Use `submit` intent directly (no meta-resolution needed).
    const res1 = await sendWithIntent(issueUpdateTriggerBody(), "submit");
    expect(res1.body.errors).toBeUndefined();

    mf.setContext("ac-validate", "u-astrid");
    mf.setWithIdsState("ac-validate");

    // Second mutation: commentCreate under same sticky intent.
    const commentText = "Ready for review. All ACs covered.";
    const res2 = await sendWithIntent(commentCreateBody(commentText), "submit");

    // Must NOT get a B1 workflow rejection.
    expect(res2.body.errors).toBeUndefined();

    // The comment body reached Linear.
    const forwardedComments = mf.calls.filter(
      (c) => c.query.includes("commentCreate") &&
        !c.query.includes("VerifyTransitionWrite") &&
        !c.query.includes("SatisfiedByComment") &&
        !c.query.includes("VerifyComment") &&
        c.variables?.body === commentText
    );
    expect(forwardedComments.length).toBeGreaterThanOrEqual(1);
  });
});
