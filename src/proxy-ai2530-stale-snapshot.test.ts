/**
 * AI-2530: `continue-workflow` reuses a stale auth-snapshot across
 * comment-carried transitions and mis-resolves to the PRIOR state's verb.
 *
 * The per-command auth snapshot (`commandAuthSnapshots`, key
 * `agentId:issueId:intent`, TTL 10 min) caches the command-start workflow
 * state. AI-2115 Bug 1 added a guard so a state-changing `issueUpdate`
 * re-derives from live state and never reuses the snapshot — but on workflow
 * tickets the transition is always comment-carried (raw `issueUpdate` on
 * status/delegate is proxy-blocked), so `isTransitionMutation` is false and
 * the guard never engages. The snapshot invalidation only fires on TERMINAL
 * transitions, so a non-terminal advance leaves the stale snapshot live for
 * the rest of the TTL.
 *
 * Net: a second `continue-workflow` fired from the next state resolves the
 * meta-intent against the PRIOR state and applies the prior state's verb ->
 * `no-transition` -> silent HTTP-200 decline.
 *
 * Shape mirrors sprint-spawner's `determining-scope -> spawning-scope ->
 * scoping`: two consecutive comment-carried `continue-workflow` calls.
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

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
roles:
  - id: dev
    requires: [linear:transition]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
`;

// sprint-spawner-shaped: two consecutive NON-TERMINAL states, each with a
// `generic: continue` transition, so `continue-workflow` is legal from both.
const WORKFLOW_YAML = `
id: spawner
version: 1
archetype: single-task
entry_state: determining-scope
states:
  - id: determining-scope
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: propose-brief
        to: spawning-scope
        generic: continue
        requires_comment: true
  - id: spawning-scope
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: scoping
        generic: continue
        requires_comment: true
  - id: scoping
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: complete-work
        to: done
        generic: continue
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "LIF-28";

function contextFor(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:spawner" }, { name: `state:${state}` }] },
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
            { id: "wf-lbl", name: "wf:spawner" },
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
          { id: "determining-scope-lbl", name: "state:determining-scope" },
          { id: "spawning-scope-lbl", name: "state:spawning-scope" },
          { id: "scoping-lbl", name: "state:scoping" },
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
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

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
      // Make the write REAL: reflect the new state:* label into the live
      // context so VerifyTransitionWrite passes and the proxy records the
      // transition as `applied`. Without this the first command dies at
      // `transition-write-unverified` and never exercises the applied-path
      // invalidation the fix hangs off — a red baseline for the wrong reason.
      const vars = parsed.variables ?? {};
      const addedIds = (vars.labelIds as string[] | undefined) ?? [];
      const target = ["determining-scope", "spawning-scope", "scoping", "done"]
        .find((s) => addedIds.includes(`${s}-lbl`));
      if (target) {
        currentContext = contextFor(target, "u-igor");
        withIdsState = target;
      }
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

/** Which state:* label did an ApplyAtomicTransition write? */
function appliedStateLabels(calls: Array<{ query: string; variables: Record<string, unknown> }>): string[] {
  return calls
    .filter((c) => c.query.includes("ApplyAtomicTransition"))
    .map((c) => JSON.stringify(c.variables));
}

describe("proxy — AI-2530: stale auth-snapshot across comment-carried transitions", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2530-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "spawner.yaml");
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
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const send = (payload: object, commandId?: string) => {
    let r = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "continue-workflow");
    if (commandId) r = r.set("X-Openclaw-Command-Id", commandId);
    return r.send(payload);
  };

  it("REPRO: second continue-workflow from spawning-scope must resolve to that state's verb (spawn -> scoping), not the prior state's", async () => {
    const mf = makeMutableFetch({ state: "determining-scope", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("determining-scope");

    // Continue #1: determining-scope --propose-brief--> spawning-scope
    const res1 = await send(commentCreateBody("scope brief proposed."), "cmd-A");
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // The command's transition landed: live state is now spawning-scope.
    mf.setContext("spawning-scope", "u-igor");
    mf.setWithIdsState("spawning-scope");

    const callsBefore = mf.calls.length;

    // Continue #2: a SEPARATE command, fired from spawning-scope, within TTL.
    // It must resolve to `spawn` and land on `scoping`.
    const res2 = await send(commentCreateBody("spawning the scoping child."), "cmd-B");
    expect(res2.status).toBe(200);

    const secondCommandCalls = mf.calls.slice(callsBefore);
    const applied = appliedStateLabels(secondCommandCalls);

    // BUG: the stale snapshot (state=determining-scope) makes this resolve to
    // `propose-brief`, which has no transition from spawning-scope ->
    // no-transition -> no ApplyAtomicTransition at all -> silent decline.
    expect(applied.length).toBeGreaterThan(0);
    // FIX: it must move the ticket onto `scoping`.
    expect(applied.join(" ")).toContain("scoping-lbl");
  });

  /**
   * GUARD (AI-1860 / AI-2472): the CLI chunks a long --comment body into N
   * separate commentCreate mutations under the SAME sticky intent header
   * (skill `issues.ts:573`, `client.ts:69`). Chunk 1 carries the transition;
   * chunks 2..N MUST still be delivered and must not be re-gated against the
   * post-transition state — that is the AI-1848 "comment silently dropped"
   * incident this snapshot machinery exists to prevent.
   *
   * This is the case any AI-2530 fix must not break, and the existing AI-1860
   * suite does NOT cover it: 9 of its 11 tests simulate the transition via
   * setContext while the mock leaves the write unverified, so their
   * transitions never reach `status === "applied"` and the applied-path
   * invalidation never fires. This test uses a mock where the write really
   * lands, so the invalidation path is genuinely exercised.
   */
  it("GUARD: chunk 2 of the SAME continue-workflow command is still delivered after chunk 1's transition applied", async () => {
    const mf = makeMutableFetch({ state: "determining-scope", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("determining-scope");

    // Chunk 1 — carries the determining-scope -> spawning-scope transition.
    const res1 = await send(commentCreateBody("**Part 1 of 2**\n\nlong body, first half."), "cmd-C");
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    const callsBefore = mf.calls.length;

    // Chunk 2 — same command, same intent header, sent immediately after.
    const res2 = await send(commentCreateBody("**Part 2 of 2**\n\nlong body, second half."), "cmd-C");
    expect(res2.status).toBe(200);

    // The chunk must reach Linear, not be swallowed by a legality re-check.
    const errMsg = (res2.body?.errors?.[0]?.message as string | undefined) ?? "";
    expect(errMsg).not.toMatch(/not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();

    const forwarded = mf.calls
      .slice(callsBefore)
      .some((c) => c.query.includes("AddComment") && String(c.variables.body ?? "").includes("Part 2 of 2"));
    expect(forwarded).toBe(true);

    // ...and chunk 2 must NOT drive the state machine a second time. This is
    // the invariant the `key === snapshotKey` preservation actually protects:
    // without the snapshot, chunk 2 re-resolves the meta-intent against the
    // now-live `spawning-scope` and applies `spawn`, so an N-chunk comment
    // advances the workflow N times. Delivery alone is not sufficient.
    const extraTransitions = appliedStateLabels(mf.calls.slice(callsBefore));
    expect(extraTransitions).toEqual([]);
  });
});
