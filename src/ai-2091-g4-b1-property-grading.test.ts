/**
 * AI-2091 §G4 (re-scoped to B1): B1 delegate-only enforcement emits
 * `stale-snapshot-mutation-rejected` on the live path.
 *
 * After AI-2115 (main commit 7234784), the G4 pre-mutation CAS
 * (`assertMutationAgainstCurrentState`) became unreachable: AI-2115 made
 * `issueUpdate` mutations skip snapshot reuse, so B1's delegate-only check
 * catches foreign-takeover issueUpdates BEFORE the CAS can run.
 *
 * Steward decision (Astrid, Option 1): remove the dead G4 CAS and re-scope
 * the G4 property ("no stale-snapshot foreign mutation commits") onto B1's
 * live path. B1 must emit `stale-snapshot-mutation-rejected` when it rejects
 * a foreign-takeover issueUpdate. This boot-path integration test proves
 * the property end-to-end through `createApp()` → `/proxy/graphql`.
 *
 * Test 1 (RED): B1 blocks a foreign-takeover issueUpdate AND emits the
 *   operational event. Currently fails because B1 logs + returns a string
 *   but does NOT write to the operational event store.
 *
 * Test 2 (GREEN): Legitimate issueUpdate from the actual delegate passes
 *   without blocking or emitting.
 *
 * Test 3 (GREEN): Self-progression (ac-fail with trailing comment) passes —
 *   the delegate change is self-initiated, and comments aren't issueUpdate
 *   so B1 uses the snapshot delegate (matching caller).
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

// ── Fixtures (mirror ai-2091-g4-cas-wiring.test.ts) ─────────────────────

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

// ── Test suite ────────────────────────────────────────────────────────────

describe("AI-2091 G4 re-scoped: B1 emits stale-snapshot-mutation-rejected on delegate-only block", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-g4-b1-"));
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

  // ── Test 1: RED — B1 blocks foreign-takeover and emits the event ──────

  it("B1 rejects a foreign-takeover issueUpdate and emits stale-snapshot-mutation-rejected", async () => {
    // The ticket is in implementation, delegated to astrid.
    // igor (not the delegate) sends an issueUpdate mutation via the proxy.
    // B1 must block with "not the current delegate" AND write
    // stale-snapshot-mutation-rejected to the operational event store.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("implementation");

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.7")
      .set("X-Openclaw-Linear-Intent", "ping")
      .send(issueUpdateTriggerBody());

    expect(res.status).toBe(200);

    // B1's delegate-only block already fires on this branch — verify the
    // rejection message is present (GREEN guard: B1 works).
    expect(errText(res)).toMatch(/not the current delegate/i);

    // B1 must emit the operational event so the property is observable.
    // This assertion is RED: B1 currently returns the string but does NOT
    // write to operationalEventStore.
    const rejects = appState.operationalEventStore.query({
      outcome: "stale-snapshot-mutation-rejected",
    });
    expect(rejects.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 2: GREEN — legitimate delegate passes ────────────────────────

  it("legitimate issueUpdate from the actual delegate passes without blocking or stale-snapshot event", async () => {
    // Same setup but igor IS the delegate. The mutation should succeed and
    // no stale-snapshot event should be emitted.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("implementation");

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.7")
      .set("X-Openclaw-Linear-Intent", "ping")
      .send(issueUpdateTriggerBody());

    expect(res.status).toBe(200);
    // No B1 block — the delegate IS the caller.
    expect(res.body.errors).toBeUndefined();

    // No stale-snapshot rejection event for a legitimate mutation.
    const rejects = appState.operationalEventStore.query({
      outcome: "stale-snapshot-mutation-rejected",
    });
    expect(rejects.length).toBe(0);
  });

  // ── Test 3: GREEN — self-progression survives ─────────────────────────

  it("legitimate multi-step self-progression (ac-fail with trailing comment) still passes", async () => {
    // astrid runs ac-fail at ac-validate. Mutation 1 (commentCreate) passes.
    // The command's own transition reassigns delegate to igor.
    // Mutation 2 (trailing commentCreate) must NOT be falsely rejected —
    // commentCreate is NOT issueUpdate, so the snapshot IS stored and B1
    // uses the snapshot delegate (u-astrid = caller). Self-progression works.
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    const send = (payload: object) =>
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-astrid")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.7")
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
    expect(errText(res2)).not.toMatch(/not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();

    // No stale-snapshot rejection for legitimate self-progression.
    const rejects = appState.operationalEventStore.query({
      outcome: "stale-snapshot-mutation-rejected",
    });
    expect(rejects.length).toBe(0);
  });
});
