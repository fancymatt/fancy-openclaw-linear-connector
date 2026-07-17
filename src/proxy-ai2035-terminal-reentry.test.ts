/**
 * AI-2035: ticket bounced Done→Doing 3s after reviewer close, re-triggering dispatch.
 *
 * Observed on AI-2027: a reviewer's semantic command emits >1 mutation under one
 * sticky `X-Openclaw-Linear-Intent` header. Write 1 (legit close) transitions the
 * ticket to the terminal `done` state and calls `recordAppliedState(id, "done")`.
 * Write 2 — the trailing same-turn mutation ~3s later, inside Linear's
 * read-after-write lag window — re-enters the proxy. `applyStateTransition`
 * derives its source from the lag-prone live reads (which STILL return the
 * pre-Done state) and never consults the authoritative `getAppliedState` that
 * write 1 populated, so it matches the forward `validated`/`continue` edge off
 * the stale pre-Done source and overwrites Done → re-dispatch storm.
 *
 * ── Why the existing harness masks this ──────────────────────────────────────
 * `proxy-ai1860.test.ts::runTwoStepCommand` flips `setContext` to the
 * destination between the two mutations. That models the NON-lag case where the
 * live read has already caught up — precisely the case that does not reproduce
 * the bounce. This regression holds context AND withIds at the pre-Done state on
 * the trailing mutation (the true lag case) and asserts the trailing mutation
 * issues NO second `ApplyAtomicTransition` off `done`.
 *
 * ── AC of record (captured at intake by astrid, 2026-07-10) ──────────────────
 *   AC3 — "Regression coverage for the Done→immediate-reopen race, simulating
 *          the read-after-write lag case: context/withIds still return the
 *          pre-Done state on the trailing mutation, and the test asserts no
 *          ApplyAtomicTransition is issued off `done`."
 *
 * This test is RED against current code (the trailing mutation issues a second
 * ApplyAtomicTransition, overwriting Done). Guard A (terminal re-entry guard,
 * lag-proof via getAppliedState) makes it GREEN. Guard B alone (snapshot
 * invalidation) does NOT satisfy it — in the lag case the live gate read is
 * itself stale, so only the getAppliedState-backed guard stops the write.
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

// ── Fixtures (mirror proxy-ai1860.test.ts) ────────────────────────────────────

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

// ac-validate → validated(continue) → done(terminal): the reviewer-close edge.
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
        requires_comment: true
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

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "AI-2035";

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
          // AI-2557: injected team ownership for inherited-label filtering.
          { id: "ac-validate-lbl", name: "state:ac-validate", team: { id: "team-uuid" } },
          { id: "implementation-lbl", name: "state:implementation", team: { id: "team-uuid" } },
          { id: "intake-lbl", name: "state:intake", team: { id: "team-uuid" } },
          { id: "done-lbl", name: "state:done", team: { id: "team-uuid" } },
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
 * Stateful fetch mock. Unlike proxy-ai1860's harness we expose independent
 * setters and, critically, DO NOT flip context to `done` in the lag scenario —
 * the whole point is that the live reads still lag at the pre-Done state on the
 * trailing mutation.
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
      // Unreadable read-back → the atomic write is accepted unverified (fail-open,
      // AI-1762), so the legit close write applies + records appliedState=done
      // without the mock having to model post-write labels.
      return json({ data: { issue: null } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-10T00:00:00Z", url: "u" } }, issueUpdate: { success: true } } });
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

// ── Suite ────────────────────────────────────────────────────────────────────

describe("proxy — AI-2035: reviewer Done is terminal against a same-turn trailing write (lag case)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2035-test-"));
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

  const atomicCount = (calls: Array<{ query: string }>) =>
    calls.filter((c) => c.query.includes("ApplyAtomicTransition")).length;

  it("AC3: trailing same-turn mutation after Done issues NO second ApplyAtomicTransition when live reads still lag at pre-Done", async () => {
    // Write 1: legit reviewer close. continue-workflow → validated at ac-validate,
    // transitions the ticket to the terminal `done` and records appliedState=done.
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    const send = (payload: object) =>
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-astrid")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", "continue-workflow")
        .send(payload);

    const res1 = await send(issueUpdateTriggerBody());
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // Write 1 must have applied exactly one atomic transition (→ done).
    const afterFirst = atomicCount(mf.calls);
    expect(afterFirst).toBe(1);

    // LAG: do NOT advance context/withIds. Both live reads still return the
    // pre-Done state on the trailing mutation (the read-after-write window).
    // (No setContext("done", ...) here — that is exactly what masks the bug.)

    // Write 2: the trailing same-turn chunk under the same sticky intent.
    const res2 = await send(commentCreateBody("reviewer notes — trailing chunk, same turn"));
    expect(res2.status).toBe(200);

    // The trailing mutation must NOT issue a second atomic write off `done`.
    // CURRENT (buggy) code matches the forward validated→done edge off the stale
    // pre-Done source and writes again → afterSecond === 2 (the Done→Doing bounce).
    const afterSecond = atomicCount(mf.calls);
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond).toBe(1);
  });

  it("AC2: the trailing write is handled terminally (no silent forward re-write of a closed ticket)", async () => {
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    const send = (payload: object) =>
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-astrid")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", "continue-workflow")
        .send(payload);

    await send(issueUpdateTriggerBody());
    const res2 = await send(commentCreateBody("trailing chunk"));

    // Whatever the surface disposition, no ApplyAtomicTransition may have re-opened
    // the ticket: the recorded terminal `done` is authoritative against the lagged
    // trailing write. A second atomic write here is the reopen bug.
    const atomicVars = mf.calls
      .filter((c) => c.query.includes("ApplyAtomicTransition"))
      .map((c) => c.variables);
    // Exactly the single legit close write — no re-write.
    expect(atomicVars.length).toBe(1);
    expect(res2.status).toBe(200);
  });
});
