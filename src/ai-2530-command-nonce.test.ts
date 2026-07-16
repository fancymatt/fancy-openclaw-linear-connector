/**
 * AI-2530: `continue-workflow` reuses a stale auth-snapshot across
 * comment-carried transitions and mis-resolves to the PRIOR state's verb.
 *
 * ROOT CAUSE: The per-command auth snapshot (`commandAuthSnapshots`, key
 * `agentId:issueId:intent`, TTL 10 min — proxy.ts) caches the command-start
 * workflow state. AI-2115 Bug 1 added a guard so a state-changing
 * `issueUpdate` re-derives from live state — but on workflow tickets the
 * transition is always comment-carried (raw `issueUpdate` on status/delegate
 * is proxy-blocked), so `isTransitionMutation=false` and the guard never
 * engages. Snapshot invalidation only fires on TERMINAL transitions, so a
 * non-terminal advance leaves the stale snapshot live for the rest of the TTL.
 *
 * FIX (this ticket): include a per-invocation command nonce
 * (`X-Openclaw-Command-Id`) in the snapshot key:
 *   agentId:issueId:intent:commandId
 * A fresh command gets a cache-miss and re-derives from live state; follow-up
 * mutations from the SAME command share the nonce and reuse the snapshot.
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

// Sprint-spawner-shaped: two consecutive NON-TERMINAL states, each with a
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
        labels: { nodes: [{ name: `wf:spawner` }, { name: `state:${state}` }] },
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

function makeMutableFetch(initial: { state: string; delegate: string | null }) {
  let currentContext = contextFor(initial.state, initial.delegate);
  let withIdsState = initial.state;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText);
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
      // Make the write REAL: reflect the new state:* label into the live
      // context so VerifyTransitionWrite passes and the proxy records the
      // transition as `applied`.
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
    return json({
      data: {
        commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-16T00:00:00Z", url: "u" } },
        issueUpdate: { success: true },
      },
    });
  };

  return {
    fetch: mockFetch,
    calls,
    setContext: (state: string, delegate: string | null) => {
      currentContext = contextFor(state, delegate);
    },
    setWithIdsState: (state: string) => { withIdsState = state; },
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

function appliedStateLabels(calls: Array<{ query: string; variables: Record<string, unknown> }>): string[] {
  return calls
    .filter((c) => c.query.includes("ApplyAtomicTransition"))
    .map((c) => JSON.stringify(c.variables));
}

describe("proxy — AI-2530: command-nonce snapshot key prevents stale-state reuse", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Reset PROXY_MIN_CLI_VERSION to 0.3.0 so the tests' "0.3.6" CLI version
    // passes the version floor gate.
    process.env.PROXY_MIN_CLI_VERSION = "0.3.0";

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

    delete process.env.PROXY_MIN_CLI_VERSION;
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

  /**
   * REPRO: TWO separate continue-workflow commands across a non-terminal
   * boundary. Command A advances determining-scope -> spawning-scope.
   * Command B is a FRESH invocation from spawning-scope.
   *
   * Without the fix, Command B reuses Command A's stale snapshot (same key
   * `agentId:issueId:continue-workflow`), resolves to determining-scope's
   * verb `propose-brief`, and silently no-ops.
   *
   * With the fix, each command gets its own nonce -> different snapshot
   * keys -> cache-miss -> fresh resolution -> Command B resolves to
   * spawning-scope's verb `spawn` and lands on `scoping`.
   */
  it("REPRO: second continue-workflow gets a fresh nonce -> resolves to current state's verb", async () => {
    const mf = makeMutableFetch({ state: "determining-scope", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("determining-scope");

    // Command A: determining-scope --propose-brief--> spawning-scope
    const res1 = await send(commentCreateBody("scope brief proposed."), crypto.randomUUID());
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // The command's transition landed: live state is now spawning-scope.
    mf.setContext("spawning-scope", "u-igor");
    mf.setWithIdsState("spawning-scope");

    const callsBefore = mf.calls.length;

    // Command B: a FRESH command from spawning-scope with a DIFFERENT nonce.
    // Must resolve to `spawn` and land on `scoping`.
    const res2 = await send(commentCreateBody("spawning the scoping child."), crypto.randomUUID());
    expect(res2.status).toBe(200);

    const secondCommandCalls = mf.calls.slice(callsBefore);
    const applied = appliedStateLabels(secondCommandCalls);

    // The bug: stale snapshot (state=determining-scope) makes this resolve
    // to `propose-brief` -> no transition from spawning-scope -> silent no-op.
    // Fix: the fresh nonce misses the cache, re-derives, resolves to `spawn`.
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.join(" ")).toContain("scoping-lbl");
  });

  /**
   * GUARD (AI-1860 / AI-2472): the CLI chunks a long --comment body into N
   * separate commentCreate mutations under the SAME sticky intent header. All
   * chunks must share the command nonce so they reuse the snapshot, and chunk
   * 2..N must NOT re-resolve against the post-transition state.
   *
   * This is the AI-1848 "comment silently dropped" incident the snapshot
   * machinery exists to prevent. The fix must NOT break this.
   */
  it("GUARD: chunk 2 of the SAME command shares the nonce -> still delivered after chunk 1's transition", async () => {
    const mf = makeMutableFetch({ state: "determining-scope", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("determining-scope");

    const cmdId = crypto.randomUUID();

    // Chunk 1 — carries the determining-scope -> spawning-scope transition.
    const res1 = await send(commentCreateBody("**Part 1 of 2**\n\nlong body, first half."), cmdId);
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    const callsBefore = mf.calls.length;

    // Chunk 2 — SAME commandId, sent immediately after.
    const res2 = await send(commentCreateBody("**Part 2 of 2**\n\nlong body, second half."), cmdId);
    expect(res2.status).toBe(200);

    // The chunk must reach Linear, not be swallowed by a legality re-check.
    const errMsg = (res2.body?.errors?.[0]?.message as string | undefined) ?? "";
    expect(errMsg).not.toMatch(/not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();

    const forwarded = mf.calls
      .slice(callsBefore)
      .some((c) => c.query.includes("AddComment") && String(c.variables.body ?? "").includes("Part 2 of 2"));
    expect(forwarded).toBe(true);

    // Chunk 2 must NOT drive the state machine a second time. Without the
    // shared nonce, chunk 2 would re-resolve the meta-intent against the
    // now-live spawning-scope and apply `spawn`, advancing the workflow again.
    const extraTransitions = appliedStateLabels(mf.calls.slice(callsBefore));
    expect(extraTransitions).toEqual([]);
  });

  /**
   * HARD-GATE: a request on an intent-resolving path (continue-workflow,
   * request-revision) that arrives WITHOUT X-Openclaw-Command-Id must be
   * rejected with a clear protocol error.
   *
   * This gate exists because no connector-only fix exists for AI-2530
   * (proven in the AI-2530 evidence branch). The skill CLI is the emitter;
   * the host must deploy a CLI that sends the nonce before deploying this
   * connector version.
   */
  it("HARD-GATE: continue-workflow without command nonce is rejected", async () => {
    const mf = makeMutableFetch({ state: "determining-scope", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("determining-scope");

    // Send continue-workflow WITHOUT the X-Openclaw-Command-Id header.
    const res = await send(commentCreateBody("no nonce here"));
    expect(res.status).toBe(200);

    // Must be rejected: no command identity -> can't safely resolve meta-intent.
    expect(res.body.errors).toBeDefined();
    const errMsg = (res.body.errors?.[0]?.message as string | undefined) ?? "";
    expect(errMsg).toContain("X-Openclaw-Command-Id");
  });
});
