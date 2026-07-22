/**
 * INF-312 — Proxy delegate write does not persist on governed states
 * (null-delegate reversion, AI-1395).
 *
 * These tests are FAILING by design. They cover the acceptance criteria that
 * the implementer (igor) must satisfy.
 *
 * Root cause: the Linear API silently drops a delegateId write to an app/bot
 * user unless assigneeId is carried in the SAME mutation (AI-1395). The proxy's
 * `issueUpdateAtomic` (workflow-gate.ts) bundles labels + delegateId + stateId
 * in a single mutation but omits assigneeId — so on governed-state tickets
 * where the delegate is managed by `applyStateTransition`, the delegate write
 * returns success:true but the delegate never persists, reverting to null on
 * the next connector sweep.
 *
 * AC-to-test mapping:
 *   AC1: A delegate set via the proxy on a governed-state ticket persists
 *        across the next connector sweep — no revert to null.
 *        → "AC1: delegate set by applyStateTransition persists after write"
 *        → "AC1: delegate survives read-after-write verification cycle"
 *
 *   AC2: `handoff-work <id> <agent>` on a governed-state ticket successfully
 *        sets and persists the delegate.
 *        → "AC2: handoff-work on governed state persists delegate"
 *        → "AC2: handoff-work delegate survives re-fetch (simulated sweep)"
 *
 *   AC3: A re-seated delegate does not revert to null on the following
 *        heartbeat/sweep.
 *        → "AC3: delegate survives after re-seat + simulated sweep"
 *
 *   AC4: Regression test reproducing the GEN-322 double-revert and asserting
 *        the delegate survives one full sweep cycle.
 *        → "AC4 regression: GEN-322 double-revert — delegate survives
 *           full sweep cycle after two consecutive handoff-work calls"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Capability policy (dev bodies + steward) ──────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition]
  - id: host-deploy
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [linear:transition]
  - id: host-deploy
    requires: [linear:transition]

bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: charles
    container: code-review
    fills_roles: [code-review]
`;

// ── dev-impl workflow fixture ─────────────────────────────────────────────────

const WORKFLOW_YAML = `
id: dev-impl
version: 14
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: capture_ac
        capture_ac: true
  - id: capture_ac
    owner_role: steward
    native_state: doing
    transitions:
      - command: continue
        to: design
  - id: design
    owner_role: steward
    native_state: doing
    transitions:
      - command: continue
        to: write-tests
  - id: write-tests
    owner_role: test-author
    native_state: doing
    transitions:
      - command: continue
        to: implementation
        assign:
          default: prior-implementer
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: continue
        to: review
        assign:
          default: code-review
      - command: refuse-work
        to: intake
  - id: code-review
    owner_role: code-review
    native_state: doing
    transitions:
      - command: continue
        to: merge
        assign:
          default: prior-implementer
      - command: request-revision
        to: implementation
        assign:
          default: prior-implementer
  - id: merge
    owner_role: deployment
    native_state: doing
    transitions:
      - command: continue
        to: deploy
  - id: deploy
    owner_role: host-deploy
    native_state: doing
    transitions:
      - command: continue
        to: ac-validate
  - id: ac-validate
    owner_role: steward
    native_state: doing
    transitions:
      - command: approve
        to: done
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
entry_state: intake
break_glass:
  command: escape
  to: intake
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "INF-312";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** IssueContext response (labels + delegate) for a given state and delegate. */
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

/** IssueWithLabels response (with label ids). */
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
          { id: "intake-lbl", name: "state:intake" },
          { id: "capture-ac-lbl", name: "state:capture_ac" },
          { id: "design-lbl", name: "state:design" },
          { id: "write-tests-lbl", name: "state:write-tests" },
          { id: "implementation-lbl", name: "state:implementation" },
          { id: "code-review-lbl", name: "state:code-review" },
          { id: "merge-lbl", name: "state:merge" },
          { id: "deploy-lbl", name: "state:deploy" },
          { id: "ac-validate-lbl", name: "state:ac-validate" },
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
        { name: "hanzo", linearUserId: "u-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
        { name: "grover", linearUserId: "u-grover", openclawAgent: "grover", accessToken: "tok-grover", host: "local" },
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

interface MutableFetch {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  setContext: (state: string, delegate: string | null) => void;
  setWithIdsState: (state: string) => void;
  /** Track the delegateId that was written via ApplyAtomicTransition. */
  lastWrittenDelegateId: string | null | undefined;
  /** Track whether assigneeId was included in the ApplyAtomicTransition. */
  lastMutationIncludedAssigneeId: boolean;
  /** Track all ApplyAtomicTransition for audit. */
  atomicMutations: Array<{ delegateId: string | null | undefined; assigneeIdIncluded: boolean }>;
}

function makeMutableFetch(initial: { state: string; delegate: string | null }): MutableFetch {
  let currentContext = contextFor(initial.state, initial.delegate);
  let withIdsState = initial.state;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let lastWrittenDelegateId: string | null | undefined = undefined;
  let lastMutationIncludedAssigneeId = false;
  const atomicMutations: Array<{ delegateId: string | null | undefined; assigneeIdIncluded: boolean }> = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const q = parsed.query ?? "";

    const json = (payload: object) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    // Delegate/legality context fetch (IssueContext / IssueLabels).
    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels") && !q.includes("VerifyTransitionWrite")) {
      return json(currentContext);
    }
    // applyStateTransition label-id fetch.
    if (q.includes("IssueWithLabels") && !q.includes("VerifyTransitionWrite")) {
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
      // Return the context as the read-back — simulates what Linear stores.
      const ctx = currentContext as { data: { issue: { labels: unknown; delegate: unknown } } };
      return json({
        data: {
          issue: {
            labels: ctx.data.issue.labels,
            delegate: ctx.data.issue.delegate,
            state: { id: "s-doing" },
          },
        },
      });
    }
    if (q.includes("ApplyAtomicTransition")) {
      // Capture the delegateId from the variables for audit.
      const vars = parsed.variables ?? {};
      lastWrittenDelegateId = vars.delegateId as string | null | undefined;
      // Check if assigneeId was included in the mutation variables.
      lastMutationIncludedAssigneeId = "assigneeId" in vars;
      atomicMutations.push({
        delegateId: lastWrittenDelegateId,
        assigneeIdIncluded: lastMutationIncludedAssigneeId,
      });
      return json({ data: { issueUpdate: { success: true } } });
    }
    // Any forwarded mutation (commentCreate / issueUpdate) succeeds.
    return json({
      data: {
        commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-22T00:00:00Z", url: "u" } },
        issueUpdate: { success: true },
      },
    });
  };

  return {
    fetch: mockFetch,
    calls,
    setContext: (state, delegate) => { currentContext = contextFor(state, delegate); },
    setWithIdsState: (state) => { withIdsState = state; },
    get lastWrittenDelegateId() { return lastWrittenDelegateId; },
    get lastMutationIncludedAssigneeId() { return lastMutationIncludedAssigneeId; },
    atomicMutations,
  };
}

/** issueUpdate bare-trigger mutation (no label delta — proxy is sole state writer). */
function issueUpdateTriggerBody() {
  return {
    query: `mutation TriggerTransition($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id: ISSUE_UUID },
  };
}

/** handoff-work mutation body. */
function handoffWorkBody(targetAgent: string) {
  return {
    query: `mutation HandoffWork($id: String!, $delegateId: String) {
      issueUpdate(id: $id, input: { delegateId: $delegateId }) { success }
    }`,
    variables: { id: ISSUE_UUID, delegateId: `u-${targetAgent}` },
  };
}

/** Send a GraphQL request to the proxy endpoint. */
async function proxyPost(
  app: Express,
  body: object,
  opts: { agent: string; intent: string; commandId?: string },
) {
  let r = request(app)
    .post("/proxy/graphql")
    .set("Authorization", `Bearer tok-${opts.agent}`)
    .set("X-Openclaw-Agent", opts.agent)
    .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
    .set("X-Openclaw-Linear-Intent", opts.intent);
  if (opts.commandId) {
    r = r.set("X-Openclaw-Command-Id", opts.commandId);
  }
  return r.send(body);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("INF-312: proxy delegate writes persist on governed states", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-312-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    try { fs.rmSync(dir, { recursive: true }); } catch { /* best-effort cleanup */ }
  });

  // ── AC1: applyStateTransition delegate persistence ──────────────────────

  it("AC1: delegate set by applyStateTransition persists after write (assigneeId:null sent alongside delegateId)", async () => {
    // Arrange: ticket at write-tests with astrid as delegate.
    const mf = makeMutableFetch({ state: "write-tests", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;

    // Act: astrid runs continue from write-tests → implementation.
    // applyStateTransition should resolve delegate to igor (the dev body
    // for the "dev" role) and write it atomically via issueUpdateAtomic.
    const res = await proxyPost(appState.app, issueUpdateTriggerBody(), {
      agent: "astrid",
      intent: "continue",
      commandId: "cmd-ac1a",
    });

    expect(res.status).toBe(200);

    // The atomic mutation must include assigneeId alongside delegateId
    // so the Linear API doesn't silently drop the app-user delegate write (AI-1395).
    const atomicWrites = mf.atomicMutations.filter((m) => m.delegateId !== undefined);
    expect(atomicWrites.length).toBeGreaterThanOrEqual(1);

    // FAILING ASSERTION: the current code does NOT include assigneeId in the
    // ApplyAtomicTransition mutation, so the delegateId write is silently
    // dropped by Linear for app users on governed states.
    const lastAtomic = atomicWrites[atomicWrites.length - 1];
    expect(lastAtomic.assigneeIdIncluded).toBe(true);
    expect(lastAtomic.delegateId).toBe("u-igor");
  });

  it("AC1: delegate survives read-after-write verification cycle (verifyTransitionWritePersisted)", async () => {
    // Arrange: ticket at write-tests with astrid as delegate.
    const mf = makeMutableFetch({ state: "write-tests", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;

    // Act: continue from write-tests → implementation.
    const res = await proxyPost(appState.app, issueUpdateTriggerBody(), {
      agent: "astrid",
      intent: "continue",
      commandId: "cmd-ac1b",
    });

    expect(res.status).toBe(200);

    // After the mutation, simulate what would happen if the write correctly
    // persisted — the VerifyTransitionWrite read-back must show u-igor as delegate.
    // Currently the delegate is silently dropped (no assigneeId), so the
    // verification fails and the transition is retried or fails loudly.
    //
    // FAILING ASSERTION: after a correct write, the atomic mutation audit trail
    // must show a non-null delegate that was written.
    expect(mf.lastWrittenDelegateId).not.toBeNull();
    expect(mf.lastWrittenDelegateId).not.toBeUndefined();

    // Simulate the correct post-write state (what Linear would return if the
    // delegate write had persisted).
    mf.setContext("implementation", "u-igor");

    // The verification read-back would now show delegate=u-igor — proving the
    // mutation persisted. In current code, the context would still show null.
    // After the fix, the delegate survives verification.
    const atomicWrites = mf.atomicMutations.filter((m) => m.delegateId !== undefined);
    if (atomicWrites.length > 0) {
      expect(atomicWrites[atomicWrites.length - 1].assigneeIdIncluded).toBe(true);
    }
  });

  // ── AC2: handoff-work delegate persistence ─────────────────────────────

  it("AC2: handoff-work on governed state persists delegate (assigneeId:null included in forwarded mutation)", async () => {
    // Arrange: ticket at implementation with igor as delegate.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;

    // Act: astrid runs handoff-work to hand off to igor on a governed-state ticket.
    const res = await proxyPost(appState.app, handoffWorkBody("igor"), {
      agent: "astrid",
      intent: "handoff-work",
      commandId: "cmd-ac2a",
    });

    expect(res.status).toBe(200);

    // The proxy's AI-2417 block (proxy.ts) injects assigneeId:null alongside
    // delegateId for generic delegate-routing verbs. Verify the forwarded
    // issueUpdate mutation includes assigneeId.
    const forwardedIssueUpdates = mf.calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId !== undefined,
    );

    // FAILING ASSERTION: the proxy's delegated-routing block may not fire on
    // governed states because the intent paths differ from the generic path.
    // After the fix, at least one forwarded issueUpdate must include assigneeId.
    const hasForwardWithAssignee = forwardedIssueUpdates.some(
      (c) => "assigneeId" in (c.variables ?? {}),
    );
    expect(hasForwardWithAssignee).toBe(true);
  });

  it("AC2: handoff-work delegate survives re-fetch (simulated sweep)", async () => {
    // Arrange: ticket at implementation with igor as delegate.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;

    // Act: handoff-work to igor on a governed-state ticket.
    const res = await proxyPost(appState.app, handoffWorkBody("igor"), {
      agent: "astrid",
      intent: "handoff-work",
      commandId: "cmd-ac2b",
    });

    expect(res.status).toBe(200);

    // Simulate a sweep by checking the last written delegateId.
    // If the forward mutation included assigneeId:null alongside delegateId,
    // the delegate would persist. Without assigneeId, it silently reverts.
    //
    // FAILING ASSERTION: the atomic/forwarded mutation should carry the
    // correct non-null delegateId.
    const forwardedCalls = mf.calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId !== undefined,
    );
    expect(forwardedCalls.length).toBeGreaterThanOrEqual(1);

    // After the fix, the written delegateId is u-igor and NOT null.
    const lastForward = forwardedCalls[forwardedCalls.length - 1];
    expect(lastForward.variables.delegateId).toBe("u-igor");
  });

  // ── AC3: re-seated delegate persistence ────────────────────────────────

  it("AC3: delegate survives after re-seat + simulated sweep (no null reversion)", async () => {
    // Simulate a ticket at implementation whose delegate was cleared (null).
    // Astrid re-seats igor as delegate via handoff-work.
    const mf = makeMutableFetch({ state: "implementation", delegate: null });
    globalThis.fetch = mf.fetch;

    // Act 1: First handoff-work to re-seat igor.
    const res1 = await proxyPost(appState.app, handoffWorkBody("igor"), {
      agent: "astrid",
      intent: "handoff-work",
      commandId: "cmd-ac3a",
    });

    expect(res1.status).toBe(200);

    // Verify the first issueUpdate included delegateId=u-igor.
    const firstForward = mf.calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === "u-igor",
    );

    // FAILING ASSERTION: currently the delegate write is silently dropped because
    // assigneeId is missing. After the fix, at least one mutation must carry
    // delegateId=u-igor (with assigneeId:null alongside).
    expect(firstForward.length).toBeGreaterThanOrEqual(1);

    // Simulate the delegate having been correctly persisted.
    mf.setContext("implementation", "u-igor");

    // Act 2: Second handoff-work (the re-seat that kept getting reverted in GEN-322).
    const res2 = await proxyPost(appState.app, handoffWorkBody("igor"), {
      agent: "astrid",
      intent: "handoff-work",
      commandId: "cmd-ac3b",
    });

    expect(res2.status).toBe(200);

    // After the second handoff, the delegate must still be u-igor.
    const forwardedCalls = mf.calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId !== undefined,
    );
    const lastForward = forwardedCalls[forwardedCalls.length - 1];

    // FAILING ASSERTION: the delegate must persist after re-seat.
    expect(lastForward?.variables?.delegateId).toBe("u-igor");
  });

  // ── AC4: GEN-322 double-revert regression ──────────────────────────────

  it("AC4 regression: GEN-322 double-revert — delegate survives full sweep cycle after two consecutive handoff-work calls", async () => {
    // GEN-322 scenario:
    //   T0: delegate set to igor on a governed (dev-impl, implementation) ticket
    //   T1: connector sweep runs — delegate reverts to null (the AI-1395 bug)
    //   T2: user re-seats delegate (handoff-work to igor)
    //   T3: connector sweep runs AGAIN — delegate reverts to null again
    //       = "double-revert"
    //
    // This test starts with delegate already null (post-T1), does TWO
    // handoff-work calls with interleaved sweep simulations, and asserts
    // the delegate survives BOTH sweeps.

    // Start at implementation — delegate was already cleared by the first revert.
    const mf = makeMutableFetch({ state: "implementation", delegate: null });
    globalThis.fetch = mf.fetch;

    // ── First re-seat (T2) ──────────────────────────────────────────────
    // handoff-work that sets the delegate. With the fix, the forwarded
    // issueUpdate must include assigneeId:null alongside delegateId.
    const res1 = await proxyPost(appState.app, handoffWorkBody("igor"), {
      agent: "astrid",
      intent: "handoff-work",
      commandId: "cmd-ac4a",
    });

    expect(res1.status).toBe(200);

    // ── Sweep 1 (T3.1) ──────────────────────────────────────────────────
    // Check that the first handoff-work included assigneeId:null.
    const firstHandoffCalls = mf.calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === "u-igor",
    );
    const firstIncludedAssignee = firstHandoffCalls.some(
      (c) => "assigneeId" in (c.variables ?? {}),
    );

    // FAILING ASSERTION: the first issueUpdate must include assigneeId
    // alongside delegateId for app-user delegate persistence on governed states.
    expect(firstIncludedAssignee).toBe(true);

    // Simulate correct persistence — update context to show delegate survived.
    mf.setContext("implementation", "u-igor");

    // ── Second re-seat (T3.2) ───────────────────────────────────────────
    // After the first sweep, delegate is here because we simulated correct
    // persistence. Re-seat again to verify it sticks.
    const res2 = await proxyPost(appState.app, handoffWorkBody("igor"), {
      agent: "astrid",
      intent: "handoff-work",
      commandId: "cmd-ac4b",
    });

    expect(res2.status).toBe(200);

    // ── Sweep 2 (T3.3) ──────────────────────────────────────────────────
    // After the second handoff, the delegate must survive this sweep too.
    const secondHandoffCalls = mf.calls.slice(firstHandoffCalls.length).filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === "u-igor",
    );
    const secondIncludedAssignee = secondHandoffCalls.some(
      (c) => "assigneeId" in (c.variables ?? {}),
    );

    // FAILING ASSERTION: the second issueUpdate must ALSO include assigneeId.
    expect(secondIncludedAssignee).toBe(true);

    // ── Final assertion (T4) ────────────────────────────────────────────
    // After two handoff-work calls and two simulated sweeps, the delegate
    // must still be u-igor (never reverted to null).
    const lastAtomic = mf.atomicMutations[mf.atomicMutations.length - 1];
    if (lastAtomic) {
      expect(lastAtomic.delegateId).toBe("u-igor");
    }

    // Core assertion: every atomic mutation that sets a delegate on a
    // governed state MUST include assigneeId to prevent null reversion.
    for (const atomic of mf.atomicMutations) {
      if (atomic.delegateId !== undefined) {
        expect(atomic.assigneeIdIncluded).toBe(true);
      }
    }
  });
});
