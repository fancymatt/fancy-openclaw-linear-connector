/**
 * AI-2597: BBS-team commentCreate mutation blocked by connector proxy
 *
 * All write mutations (note, handoff-work, commentCreate, delete-comment, etc.)
 * for BBS-, GEN-, and LIF-team issues fail at the connector proxy level with
 * "Entity not found: Issue — Could not find referenced Issue". Read queries
 * work fine on these teams. AI-team write mutations work fine.
 *
 * These tests cover the 4 ACs and verify the proxy correctly handles write
 * mutations for all teams — AI, BBS, GEN, and LIF — without team-specific
 * filtering, rewriting, or blocking.
 *
 * ── AC of record (captured at intake by astrid, 2026-07-19) ──────────────────
 *   AC1 — "CommentCreate mutations for BBS-, GEN-, and LIF-team issues succeed
 *          through the connector proxy"
 *   AC2 — "All write mutations (note, handoff-work, delete-comment, etc.) work
 *          for BBS/GEN/LIF team issues through the proxy"
 *   AC3 — "AI-team write mutations continue to work (no regression)"
 *   AC4 — "Root cause is fixed at the connector proxy level — not worked around
 *          in individual consumers"
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Test strategy:
 *   Path A (non-intent / raw): standalone write mutation with no workflow intent
 *     header — pure pass-through. This is the path raw CLIs and integrations use.
 *   Path B (intent / governed): write mutation under a workflow intent header,
 *     e.g. a trailing commentCreate after a state-transition issueUpdate.
 *     The AI-2472 skip-B1-for-commentCreate guard applies here.
 *   Path C (identifier-based issueId): BBS/GEN/LIF issues identified by their
 *     human-readable identifier (e.g. "BBS-3") rather than UUID, because the CLI
 *     lacks workflow context to resolve non-AI team issues to UUIDs.
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
      - command: escape
        to: intake
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

// ── Team Test IDs ──────────────────────────────────────────────────────────────

/**
 * BBS/GEN/LIF use their human-readable identifiers directly as the `issueId`
 * in commentCreate mutations because the CLI lacks workflow context to resolve
 * non-AI team issues to UUIDs. The proxy must handle both UUID and
 * human-readable identifiers for ALL teams uniformly.
 */
/**
 * AI-2597: teams under test.
 *
 * `issueUuid` is what the post-resolution forwarded mutation carries.
 * For AI this is already a UUID; for BBS/GEN/LIF this is an identifier that
 * the proxy must resolve to the `resolvedUuid` before forwarding.
 */
const TEAMS = {
  AI: {
    /** The value the mutation carries in its variables (already a UUID for AI). */
    issueUuid: "b4a7c3e1-129f-4a3d-9c8b-0f1e2a3b4c5d",
    /** The internal UUID the proxy resolves to (same as issueUuid for AI). */
    resolvedUuid: "b4a7c3e1-129f-4a3d-9c8b-0f1e2a3b4c5d",
    identifier: "AI-2597",
    teamId: "team-ai",
  },
  BBS: {
    /** Human-readable identifier that starts as the mutation variable value. */
    issueUuid: "BBS-3",
    /** The internal UUID the proxy resolves it to. */
    resolvedUuid: "e9b2c8a1-2345-4b6d-8a9c-0d1e2f3a4b5c",
    identifier: "BBS-3",
    teamId: "team-bbs",
  },
  GEN: {
    issueUuid: "GEN-103",
    resolvedUuid: "a1b2c3d4-5678-4e9f-abcd-ef0123456789",
    identifier: "GEN-103",
    teamId: "team-gen",
  },
  LIF: {
    issueUuid: "LIF-54",
    resolvedUuid: "f0e1d2c3-b4a5-4c6d-8e7f-901234567890",
    identifier: "LIF-54",
    teamId: "team-lif",
  },
};

// ── Mock helpers ───────────────────────────────────────────────────────────────

/** Build a context response for workflow-label queries. */
function contextFor(state: string, delegate: string | null, identifier: string): object {
  return {
    data: {
      issue: {
        identifier,
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${state}` }] },
        delegate: delegate ? { id: delegate } : null,
      },
    },
  };
}

/**
 * Build an IssueWithLabels response (for setStateAtomic / applyStateTransition)
 * OR the AI-2597 UUID-resolution query response.
 * `id` is set to `resolvedUuid` when provided, otherwise `identifier`.
 */
function withIdsFor(teamId: string, identifier: string, resolvedUuid?: string): object {
  return {
    data: {
      issue: {
        id: resolvedUuid ?? identifier,
        identifier,
        team: { id: teamId },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:dev-impl" },
            { id: "intake-lbl", name: "state:intake" },
            { id: "done-lbl", name: "state:done" },
          ],
        },
      },
    },
  };
}

/** Team labels response — all state:* labels the team owns. */
function teamLabelsFor(): object {
  return {
    data: {
      team: {
        labels: {
          nodes: [
            { id: "intake-lbl", name: "state:intake" },
            { id: "implementation-lbl", name: "state:implementation" },
            { id: "ac-validate-lbl", name: "state:ac-validate" },
            { id: "done-lbl", name: "state:done" },
          ],
        },
      },
    },
  };
}

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

/**
 * Mutable fetch mock that tracks calls and supports updating context mid-test.
 */
function makeMockFetch(initial: {
  state: string;
  delegate: string | null;
  teamId: string;
  identifier: string;
  /** AI-2597: the UUID the proxy's resolution query should return. */
  resolvedUuid?: string;
}): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  setContext: (state: string, delegate: string | null) => void;
} {
  let currentState = initial.state;
  let currentDelegate = initial.delegate;
  const { teamId, identifier, resolvedUuid } = initial;
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

    // AI-2597: UUID resolution query — return the resolved UUID so the proxy
    // rewrites the identifier before forwarding.
    if (q.includes("issue(id: $id) { id }")) {
      if (resolvedUuid) {
        return json({ data: { issue: { id: resolvedUuid } } });
      }
      // Fallback: return the identifier as-is (no resolution needed).
      return json({ data: { issue: { id: identifier } } });
    }

    // Workflow label queries — must succeed for any team so enforcement can proceed
    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels") && !q.includes("TeamStateLabels")) {
      return json(contextFor(currentState, currentDelegate, identifier));
    }
    if (q.includes("IssueWithLabels")) {
      return json(withIdsFor(teamId, identifier, resolvedUuid));
    }
    if (q.includes("TeamStateLabels")) {
      return json({
        data: {
          issue: {
            team: { labels: teamLabelsFor().data.team.labels },
          },
        },
      });
    }
    if (q.includes("TeamLabels")) {
      return json(teamLabelsFor());
    }
    if (q.includes("TeamStates")) {
      return json(TEAM_STATES);
    }
    if (q.includes("VerifyTransitionWrite") || q.includes("VerifyAtomicWrite")) {
      return json({ data: { issue: null } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    // Default: accept as a successful Linear API mutation
    return json({
      data: {
        commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-19T00:00:00Z", url: "u" } },
        issueUpdate: { success: true },
        commentDelete: { success: true },
      },
    });
  };

  return {
    fetch: mockFetch,
    calls,
    setContext: (state, delegate) => {
      currentState = state;
      currentDelegate = delegate;
    },
  };
}

// ── Request builders ───────────────────────────────────────────────────────────

function commentCreateReq(issueId: string, body: string) {
  return {
    operationName: "AddComment",
    query: `mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id createdAt url } }
    }`,
    variables: { issueId, body },
  };
}

function deleteCommentReq(commentId: string) {
  return {
    operationName: "DeleteComment",
    query: `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
    variables: { id: commentId },
  };
}

function issueUpdateReq(id: string) {
  return {
    operationName: "TriggerTransition",
    query: `mutation TriggerTransition($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Count calls to a specific mutation operation in the fetch mock (excluding proxy-internal queries). */
const countMutationCalls = (
  calls: Array<{ query: string }>,
  operationPrefix: string,
): number =>
  calls.filter((c) => {
    const q = c.query;
    return (
      q.includes(operationPrefix) &&
      !q.includes("Verify") &&
      !q.includes("Satisfied") &&
      !q.includes("ApplyAtomic") &&
      !q.includes("TeamLabels") &&
      !q.includes("TeamStates") &&
      !q.includes("IssueContext") &&
      !q.includes("IssueWithLabels") &&
      !q.includes("TeamStateLabels")
    );
  }).length;

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

// ── Suite ────────────────────────────────────────────────────────────────────

describe("proxy — AI-2597: cross-team write mutations (BBS/GEN/LIF) succeed", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2597-test-"));
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
   * Raw (non-intent) proxy request — pure pass-through.
   */
  const rawPost = (payload: object) =>
    request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .send(payload);

  /**
   * Intent-bearing proxy request (governed command path).
   */
  const intentPost = (payload: object, intent: string) =>
    request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", intent)
      .set("X-Openclaw-Command-Id", crypto.randomUUID())
      .send(payload);

  // ── AC1: CommentCreate for BBS/GEN/LIF ──────────────────────────────────

  describe("AC1: commentCreate succeeds for BBS/GEN/LIF team issues", () => {
    for (const [teamName, team] of Object.entries(TEAMS)) {
      it(`${teamName} commentCreate via non-intent path forwards to Linear`, async () => {
        const mf = makeMockFetch({
          state: "intake",
          delegate: "u-astrid",
          teamId: team.teamId,
          identifier: team.identifier,
          resolvedUuid: team.resolvedUuid,
        });
        globalThis.fetch = mf.fetch;

        // For BBS/GEN/LIF the issueUuid is a human-readable identifier — the
        // proxy must resolve it to the UUID before forwarding (AI-2597).
        const res = await rawPost(commentCreateReq(team.issueUuid, `${teamName} comment`));

        expect(res.status).toBe(200);
        expect(res.body.errors).toBeUndefined();

        // The commentCreate must have been forwarded to Linear
        const forwarded = countMutationCalls(mf.calls, "commentCreate");
        expect(forwarded).toBeGreaterThanOrEqual(1);

        // AI-2597: the forwarded issueId must be the resolved UUID (not the
        // human-readable identifier) for all teams.
        const bodyMatch = mf.calls.some(
          (c) =>
            c.query.includes("commentCreate") &&
            c.query.startsWith("mutation") &&
            !c.query.includes("VerifyTransition") &&
            c.variables?.issueId === team.resolvedUuid &&
            c.variables?.body === `${teamName} comment`,
        );
        expect(bodyMatch).toBe(true);
      });

      it(`${teamName} commentCreate under sticky intent forwards to Linear`, async () => {
        const mf = makeMockFetch({
          state: "intake",
          delegate: "u-astrid",
          teamId: team.teamId,
          identifier: team.identifier,
          resolvedUuid: team.resolvedUuid,
        });
        globalThis.fetch = mf.fetch;

        // Send commentCreate under a workflow intent — the AI-2472 skip-B1
        // guard must allow the commentCreate for ANY team, not just AI.
        const res = await intentPost(commentCreateReq(team.issueUuid, `${teamName} governed comment`), "accept");

        expect(res.status).toBe(200);

        // The commentCreate must be forwarded (not silently dropped or blocked)
        const comments = countMutationCalls(mf.calls, "commentCreate");
        expect(comments).toBeGreaterThanOrEqual(1);
      });
    }
  });

  // ── AC2: All write mutations for BBS/GEN/LIF ────────────────────────────

  describe("AC2: all write mutations work for BBS/GEN/LIF teams", () => {
    const bbs = TEAMS.BBS;
    const gen = TEAMS.GEN;
    const lif = TEAMS.LIF;

    it("BBS commentCreate (non-intent) — raw note passes through", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: bbs.teamId, identifier: bbs.identifier, resolvedUuid: bbs.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(commentCreateReq(bbs.issueUuid, "BBS raw note"));
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(countMutationCalls(mf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    it("BBS commentCreate under sticky intent — governed path forwards", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: bbs.teamId, identifier: bbs.identifier, resolvedUuid: bbs.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await intentPost(commentCreateReq(bbs.issueUuid, "BBS governed comment"), "accept");
      expect(res.status).toBe(200);
      expect(countMutationCalls(mf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    it("GEN commentCreate (non-intent) — raw note passes through", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: gen.teamId, identifier: gen.identifier, resolvedUuid: gen.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(commentCreateReq(gen.issueUuid, "GEN raw note"));
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(countMutationCalls(mf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    it("LIF commentCreate (non-intent) — raw note passes through", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: lif.teamId, identifier: lif.identifier, resolvedUuid: lif.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(commentCreateReq(lif.issueUuid, "LIF raw note"));
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(countMutationCalls(mf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    it("BBS delete-comment (non-intent) — forwarded", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: bbs.teamId, identifier: bbs.identifier, resolvedUuid: bbs.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(deleteCommentReq("c-bbs-1"));
      expect(res.status).toBe(200);
      expect(countMutationCalls(mf.calls, "commentDelete")).toBeGreaterThanOrEqual(1);
    });

    it("BBS delete-comment under sticky intent — forwarded", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: bbs.teamId, identifier: bbs.identifier, resolvedUuid: bbs.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await intentPost(deleteCommentReq("c-bbs-2"), "accept");
      expect(res.status).toBe(200);
      expect(countMutationCalls(mf.calls, "commentDelete")).toBeGreaterThanOrEqual(1);
    });

    it("BBS issueUpdate (non-intent) — raw state write forwarded", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: bbs.teamId, identifier: bbs.identifier, resolvedUuid: bbs.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(issueUpdateReq(bbs.issueUuid));
      expect(res.status).toBe(200);
    });
  });

  // ── AC3: AI-team writes still work ──────────────────────────────────────

  describe("AC3: AI-team write mutations continue to work (no regression)", () => {
    const ai = TEAMS.AI;

    it("AI commentCreate (non-intent) — still works", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: ai.teamId, identifier: ai.identifier, resolvedUuid: ai.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(commentCreateReq(ai.issueUuid, "AI raw comment"));
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(countMutationCalls(mf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    it("AI commentCreate under sticky intent — still works", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: ai.teamId, identifier: ai.identifier, resolvedUuid: ai.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await intentPost(commentCreateReq(ai.issueUuid, "AI governed comment"), "accept");
      expect(res.status).toBe(200);
      expect(countMutationCalls(mf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    it("AI delete-comment (non-intent) — still works", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: ai.teamId, identifier: ai.identifier, resolvedUuid: ai.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(deleteCommentReq("c-ai-1"));
      expect(res.status).toBe(200);
    });

    it("AI issueUpdate (non-intent) — still works", async () => {
      const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: ai.teamId, identifier: ai.identifier, resolvedUuid: ai.resolvedUuid });
      globalThis.fetch = mf.fetch;
      const res = await rawPost(issueUpdateReq(ai.issueUuid));
      expect(res.status).toBe(200);
    });
  });

  // ── AC4: Root cause fixed at proxy level ────────────────────────────────

  describe("AC4: root cause fixed at connector proxy level — not worked around in consumers", () => {
    /**
     * The proxy must forward write mutations identically for all teams.
     * If there were team-based filtering, BBS and AI mutations with
     * identical structure would produce different forwarding behavior.
     */
    it("forwards commentCreate identically for each team — no team-based filtering", async () => {
      const results: Array<{ team: string; forwarded: number }> = [];

      for (const [teamName, team] of Object.entries(TEAMS)) {
        const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: team.teamId, identifier: team.identifier, resolvedUuid: team.resolvedUuid });
        globalThis.fetch = mf.fetch;

        const res = await rawPost(commentCreateReq(team.issueUuid, "cross-team body"));
        expect(res.status).toBe(200);
        expect(res.body.errors).toBeUndefined();

        results.push({
          team: teamName,
          forwarded: countMutationCalls(mf.calls, "commentCreate"),
        });
      }

      // Every team's commentCreate must have been forwarded
      for (const r of results) {
        expect(r.forwarded).toBeGreaterThanOrEqual(1);
      }
    });

    /**
     * The fix must be in the proxy path (proxy.ts / workflow-gate.ts),
     * not patched in the CLI or webhook layer. Verify the proxy's
     * upstream Linear fetch was called.
     */
    it("BBS write mutations reach the proxy's upstream Linear fetch", async () => {
      const bbsMf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: TEAMS.BBS.teamId, identifier: TEAMS.BBS.identifier, resolvedUuid: TEAMS.BBS.resolvedUuid });
      globalThis.fetch = bbsMf.fetch;

      const res = await rawPost(commentCreateReq(TEAMS.BBS.issueUuid, "BBS via proxy"));
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();

      // The proxy must have made at least one call to the mock
      expect(bbsMf.calls.length).toBeGreaterThan(0);

      // At least one must be the commentCreate forward
      expect(countMutationCalls(bbsMf.calls, "commentCreate")).toBeGreaterThanOrEqual(1);
    });

    /**
     * The proxy must not silently drop BBS write mutations on the intent
     * path while allowing the same mutation for AI. It must also not apply
     * any team-based transformation to the mutation body — but it MUST
     * resolve human-readable identifiers to UUIDs for all teams (AI-2597).
     */
    it("proxy resolves identifiers to UUIDs for every team", async () => {
      for (const [teamName, team] of Object.entries(TEAMS)) {
        const mf = makeMockFetch({ state: "intake", delegate: "u-astrid", teamId: team.teamId, identifier: team.identifier, resolvedUuid: team.resolvedUuid });
        globalThis.fetch = mf.fetch;

        const body = `test comment for ${teamName}`;
        await rawPost(commentCreateReq(team.issueUuid, body));

        // The forwarded issueId must be the resolved UUID (AI-2597)
        const forwarded = mf.calls.some(
          (c) =>
            c.query.includes("commentCreate") &&
            c.query.startsWith("mutation") &&
            !c.query.includes("VerifyTransition") &&
            c.variables?.issueId === team.resolvedUuid,
        );
        expect(forwarded).toBe(true);
      }
    });
  });
});
