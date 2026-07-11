/**
 * AI-2091 §8 (G4, AI-2058) — pre-mutation compare-and-swap, WIRED on the live path.
 *
 * The code-review bounce (CodeReviewAgent, 2026-07-11T21:34:51Z) found that
 * `assertMutationAgainstCurrentState` shipped as dead code: defined + unit-tested
 * (ai-2091-cas-and-wiring.test.ts §8) and marked active at /health, but with NO
 * call site in `handleProxyRequest` — the exact AI-1808 "logic green, never wired"
 * failure mode this umbrella exists to close. The §8 unit and the §9 /health flag
 * both stay green with the gate unwired, so neither catches it.
 *
 * This suite drives real mutations through the production proxy path
 * (`createApp()` → `/proxy/graphql` → `handleProxyRequest`) and proves the CAS
 * actually fires:
 *
 *   AC (review): "drive a foreign-actor stale mutation through handleProxyRequest
 *   and assert rejection (stale-snapshot-mutation-rejected), AND a legitimate
 *   multi-step self-progression still passes."
 *
 * The safe-wiring constraint the reviewer flagged (a blind snapshotState !==
 * currentState would false-reject legitimate multi-step self-progression, because
 * commandAuthSnapshots reuses the command-start state by design — AI-1848 /
 * AI-1872 / AI-1924) is honored: the CAS keys on a FOREIGN delegate takeover, not
 * on the state advance, and only gates a trailing issueUpdate (a self-progression
 * comment chunk is never gated).
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
import { createApp } from "./index.js";

// ── Fixtures (mirror proxy-ai1860.test.ts / proxy-ai2035-terminal-reentry) ─────

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

// `ping` is a no-comment self-loop in implementation so a TRAILING issueUpdate
// (the shape the CAS gates) can be driven under a stored snapshot without a
// requires_comment block. `ac-fail` is the canonical self-progression command
// whose own transition reassigns the delegate mid-command.
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
      - command: ping
        to: implementation
      - command: submit
        to: ac-validate
        requires_comment: true
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: ac-fail
        to: implementation
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "AI-2091";

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
      const ctx = currentContext as { data: { issue: { labels: unknown; delegate: unknown } } };
      return json({ data: { issue: { labels: ctx.data.issue.labels, delegate: ctx.data.issue.delegate, state: { id: "s-doing" } } } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-11T00:00:00Z", url: "u" } }, issueUpdate: { success: true } } });
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

describe("AI-2091 §8 (G4): pre-mutation CAS is wired into handleProxyRequest", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-g4-cas-"));
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
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const errText = (res: request.Response): string =>
    (res.body?.errors?.[0]?.message as string | undefined) ?? "";

  it("rejects a TRAILING governed mutation after a FOREIGN actor takes the delegate mid-run", async () => {
    // igor is the delegate at implementation. Mutation 1 (`ping`, no comment)
    // passes the gate and stores the command-auth snapshot with the ticket
    // delegate captured as u-igor. A FOREIGN actor then moves the delegate to
    // astrid. Mutation 2 (same sticky intent, an issueUpdate) is authorized by B1
    // off the stored snapshot — but the CAS re-reads the CURRENT delegate before
    // the forward and rejects it as a foreign-takeover overwrite.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("implementation");

    const send = (payload: object) =>
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-igor")
        .set("X-Openclaw-Agent", "igor")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", "ping")
        .send(payload);

    const res1 = await send(issueUpdateTriggerBody());
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // Foreign takeover: a different actor is now the delegate.
    mf.setContext("implementation", "u-astrid");

    const res2 = await send(issueUpdateTriggerBody());
    expect(res2.status).toBe(200);
    // The trailing mutation must be rejected by the CAS, not silently forwarded.
    expect(errText(res2)).toMatch(/delegate changed|stale-snapshot|another actor now owns/i);

    // And the rejection is observable as a first-class operational event.
    const rejects = appState.operationalEventStore.query({ outcome: "stale-snapshot-mutation-rejected" });
    expect(rejects.length).toBeGreaterThan(0);
  });

  it("does NOT reject a legitimate multi-step self-progression (trailing comment after the command's own transition)", async () => {
    // astrid runs ac-fail: mutation 1 (comment) passes the gate and the command's
    // OWN transition moves the ticket to implementation, reassigning the delegate
    // to igor. Mutation 2 (the trailing comment chunk) must NOT be false-rejected
    // — the delegate change is self-progression, not a foreign takeover, and a
    // comment is never gated by the CAS. This is the AI-1848/1872/1924 shape.
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    const send = (payload: object) =>
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-astrid")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", "ac-fail")
        .set("X-Openclaw-Linear-Target", "igor")
        .send(payload);

    const res1 = await send(commentCreateBody("AC failure — chunk 1: findings for the implementer."));
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // The command's own transition applied: state → implementation, delegate → igor.
    mf.setContext("implementation", "u-igor");

    const res2 = await send(commentCreateBody("AC failure — chunk 2: appendix with repro steps."));
    expect(res2.status).toBe(200);
    expect(errText(res2)).not.toMatch(/delegate changed|stale-snapshot|another actor now owns/i);
    expect(res2.body.errors).toBeUndefined();

    // No stale-snapshot rejection was emitted for a legitimate self-progression.
    const rejects = appState.operationalEventStore.query({ outcome: "stale-snapshot-mutation-rejected" });
    expect(rejects.length).toBe(0);
  });

  it("does NOT reject a trailing mutation when the delegate is unchanged (owner still holds the ticket)", async () => {
    // igor stays the delegate across both mutations — no foreign takeover — so the
    // CAS must let the trailing issueUpdate through.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("implementation");

    const send = (payload: object) =>
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-igor")
        .set("X-Openclaw-Agent", "igor")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", "ping")
        .send(payload);

    await send(issueUpdateTriggerBody());
    // delegate unchanged (still u-igor).
    const res2 = await send(issueUpdateTriggerBody());

    expect(res2.status).toBe(200);
    expect(errText(res2)).not.toMatch(/delegate changed|stale-snapshot|another actor now owns/i);
    const rejects = appState.operationalEventStore.query({ outcome: "stale-snapshot-mutation-rejected" });
    expect(rejects.length).toBe(0);
  });
});
