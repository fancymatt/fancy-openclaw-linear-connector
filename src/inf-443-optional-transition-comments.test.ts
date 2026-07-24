/**
 * INF-443: Stop requiring comments on routine transitions.
 *
 * Today `checkWorkflowRules`'s comment gate (AI-1731, workflow-gate.ts ~line
 * 3203) enforces `requires_comment: true` on any *matched* transition — which
 * currently includes ordinary forward-progress moves like `submit` in the
 * canonical dev-impl workflow. Separately, `refuse-work` and `needs-human`
 * bypass the matched-transition gate entirely (they return early in
 * checkWorkflowRules, before line 3203 is ever reached) and today enforce NO
 * comment requirement at all.
 *
 * This ticket flips both defects into one consistent policy:
 *   - Routine forward-progress actions (continue-workflow, begin-workflow,
 *     accept, submit, complete-work) must succeed with an empty/null comment.
 *   - Actions that carry a human-facing reason (refuse-work, needs-human,
 *     request-changes / request-revision, block) must keep requiring a
 *     non-empty comment, INCLUDING refuse-work and needs-human, which do not
 *     require one today — this test asserts the gap is closed, not just that
 *     no regression occurs.
 *   - A transition-carried comment (posted via commentCreate in the same
 *     request) must not increment any recent-comment rate-limit or dedup
 *     counter — it is not "extra" agent chatter, it's a mandatory field.
 *   - The comment-handling component must be wired at bootstrap and
 *     observable via /health (the AI-1808 dead-code guard pattern).
 *
 * AC mapping:
 *   AC1 — continue-workflow, begin-workflow, accept, submit, complete-work
 *         succeed with comment/comment-file empty or absent.
 *   AC2 — refuse-work, needs-human, request-changes (request-revision meta-
 *         intent), block continue to require a non-empty comment and fail
 *         with a clear validation error when it is missing.
 *   AC3 — transition-carried comments do not increment the agent's recent-
 *         comment rate-limit/dedup counters (speculative: no such counter
 *         exists yet in the codebase; asserted against a `commentStats`-
 *         shaped /health field the implementer is expected to add).
 *   AC4 — dist/index.js boots and /health exposes the comment-handling
 *         component's liveness (placeholder name `transitionCommentLogic`).
 *
 * Test scope: proxy integration tests (through the HTTP layer), plus one
 * production-bootstrap test that spawns dist/index.js directly.
 *
 * NOTE for the implementer: this file intentionally fails until:
 *   - the requires_comment gate in checkWorkflowRules stops firing for
 *     routine/forward transitions (or those transitions stop carrying
 *     requires_comment: true in the canonical workflow defs),
 *   - refuse-work and needs-human grow an explicit non-empty-comment check
 *     (they currently return null / an unrelated error before ever reaching
 *     the requires_comment gate),
 *   - a commentStats-shaped counter (or equivalent) is added to /health and
 *     wired so transition-carried comments are excluded from it, and
 *   - a `transitionCommentLogic` component is registered in createApp() and
 *     surfaced on /health, mirroring `remediationActor` (src/index.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Test fixtures ────────────────────────────────────────────────────────

const PROXY_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: code-review
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
`;

// INF-443: routine forward transitions (accept, submit, complete) still carry
// requires_comment: true here, matching the canonical dev-impl.yaml's current
// AI-1731 posture (comment-requirement.test.ts) — AC1 must pass in spite of
// the flag, not because this fixture conveniently omits it. `request-changes`
// and `block` also carry it — they're the human-reasoned transitions this
// ticket says must keep requiring a comment.
const PROXY_WORKFLOW_YAML = `
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
      # requires_comment: true is set here on purpose, mirroring the
      # canonical dev-impl.yaml's current AI-1731 posture (see
      # comment-requirement.test.ts). AC1 asserts this routine forward
      # transition succeeds anyway — the fix must stop honoring
      # requires_comment for routine actions, not merely rely on the
      # test fixture omitting the flag.
      - command: accept
        to: implementation
        requires_comment: true
      - command: demote
        to: __ad_hoc__
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        generic: continue
        assign:
          mode: required
          constraint: not-implementer
        requires_comment: true
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation
        generic: revision
        requires_comment: true
      - command: block
        to: blocked
        requires_comment: true
  - id: blocked
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: complete
        to: done
        requires_capability: deploy:execute
        requires_comment: true
      - command: reject
        to: implementation
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const IMPLEMENTATION_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u1" } } },
};

const CODE_REVIEW_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] }, delegate: { id: "u4" } } },
};

const DEPLOYMENT_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] }, delegate: { id: "u2" } } },
};

const INTAKE_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] }, delegate: { id: "u3" } } },
};

// ── Test infrastructure ──────────────────────────────────────────────────

function writeProxyAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok", host: "local" },
      { name: "hanzo", linearUserId: "u2", openclawAgent: "hanzo", accessToken: "tok2", host: "local" },
      { name: "astrid", linearUserId: "u3", openclawAgent: "astrid", accessToken: "tok3", host: "local" },
      { name: "reviewer", linearUserId: "u4", openclawAgent: "reviewer", accessToken: "tok4", host: "local" },
    ],
  }), "utf8");
  return file;
}

function makeProxyFetch(labelResponse: object) {
  const originalFetch = globalThis.fetch;
  return async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return originalFetch(url, init);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
    if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels")) {
      return new Response(JSON.stringify(labelResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (parsed.query?.includes("TeamStates")) {
      return new Response(JSON.stringify({
        data: { team: { states: { nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-doing", name: "Doing", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ] } } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Upstream forward response
    return new Response(
      JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid" } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

function noCommentMutation() {
  return {
    query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
    variables: { id: "issue-uuid" },
  };
}

function withCommentMutation(body: string) {
  return {
    query: `mutation commentCreate($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }`,
    variables: { issueId: "issue-uuid", body },
  };
}

function expectNoCommentError(res: request.Response) {
  expect(res.status).toBe(200);
  if (res.body.errors) {
    for (const err of res.body.errors) {
      expect(err.message).not.toContain("comment");
      expect(err.message).not.toContain("--comment-file");
    }
  }
}

function expectCommentRequiredError(res: request.Response) {
  expect(res.status).toBe(200);
  expect(res.body.errors).toBeDefined();
  expect(res.body.errors[0].message).toContain("comment");
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1: routine forward-progress actions succeed without a comment
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy — INF-443 AC1: routine transitions do not require a comment", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf443-ac1-"));
    process.env.AGENTS_FILE = writeProxyAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), PROXY_POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, PROXY_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("accept at intake succeeds with an empty/absent comment", async () => {
    globalThis.fetch = makeProxyFetch(INTAKE_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send(noCommentMutation());

    expectNoCommentError(res);
  });

  it("submit at implementation succeeds with an empty/absent comment", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Target", "reviewer")
      .send(noCommentMutation());

    expectNoCommentError(res);
  });

  it("submit at implementation succeeds when commentCreate body is an empty string", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Target", "reviewer")
      .send(withCommentMutation(""));

    expectNoCommentError(res);
  });

  it("complete-work (intent 'complete') at deployment succeeds with an empty/absent comment", async () => {
    globalThis.fetch = makeProxyFetch(DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send(noCommentMutation());

    expectNoCommentError(res);
  });

  it("continue-workflow (meta-intent resolving to submit) succeeds without a comment", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "continue-workflow")
      .set("X-Openclaw-Linear-Target", "reviewer")
      .set("X-Openclaw-Command-Id", "inf443-ac1-continue-workflow")
      .send(noCommentMutation());

    expectNoCommentError(res);
  });

  // begin-workflow does not exist yet anywhere in the connector (no CLI verb,
  // no intent branch) — it is a placeholder the AC names explicitly. Modeled
  // here as a meta-intent that should resolve to `accept` at intake, the same
  // way continue-workflow resolves to whatever the current state's forward
  // transition is. This is expected to fail until begin-workflow is wired up
  // at all, independent of the comment-requirement fix.
  it("begin-workflow at intake succeeds without a comment (new meta-intent, not yet wired)", async () => {
    globalThis.fetch = makeProxyFetch(INTAKE_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "begin-workflow")
      .set("X-Openclaw-Command-Id", "inf443-ac1-begin-workflow")
      .send(noCommentMutation());

    // Pinned to actual success, not just "no comment-shaped error" — today
    // begin-workflow does not exist as an intent at all, so it is rejected as
    // an illegal command before ever reaching a comment gate. A loose
    // "error doesn't mention comment" check would pass on that unrelated
    // rejection and hide the fact that begin-workflow isn't wired up yet.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: human-reasoned actions continue to require a non-empty comment
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy — INF-443 AC2: human-reasoned transitions still require a comment", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf443-ac2-"));
    process.env.AGENTS_FILE = writeProxyAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), PROXY_POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, PROXY_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  // ── refuse-work: today bypasses the requires_comment gate entirely ──────

  it("refuse-work fails with a clear validation error when the comment is missing", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send(noCommentMutation());

    expectCommentRequiredError(res);
    expect(res.body.errors[0].message).toContain("--comment-file");
  });

  it("refuse-work succeeds when a non-empty comment is attached", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send(withCommentMutation("Blocked on missing credentials for the staging DB."));

    expectNoCommentError(res);
  });

  // ── needs-human: today bypasses the requires_comment gate entirely ──────

  // astrid is the delegate on INTAKE_RESPONSE (id u3) — the caller must be the
  // current delegate (or steward) to get past the earlier delegate-only gate
  // and reach whatever gate governs needs-human's comment requirement.
  it("needs-human fails with a clear validation error when the comment is missing", async () => {
    globalThis.fetch = makeProxyFetch(INTAKE_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send(noCommentMutation());

    expectCommentRequiredError(res);
    expect(res.body.errors[0].message).toContain("--comment-file");
  });

  it("needs-human succeeds when a non-empty comment is attached", async () => {
    globalThis.fetch = makeProxyFetch(INTAKE_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send(withCommentMutation("Need a decision from Matt on which vendor to use."));

    expect(res.status).toBe(200);
    // Not a bare "no mention of comment" check — the sanctioned escape hatch
    // text also happens to say "--comment", which would make a loose check
    // spuriously pass today. Pin to the actual claim: with a comment attached,
    // this must not be rejected for missing a required comment.
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("requires a comment");
        expect(err.message).not.toContain("--comment-file");
      }
    }
  });

  // ── request-changes / request-revision: regression, already YAML-gated ──

  it("request-changes at code-review fails with a clear validation error when the comment is missing", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Feedback-Category", "correctness")
      .send(noCommentMutation());

    expectCommentRequiredError(res);
    expect(res.body.errors[0].message).toContain("--comment-file");
  });

  it("request-revision (meta-intent resolving to request-changes) fails without a comment", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "request-revision")
      .set("X-Openclaw-Command-Id", "inf443-ac2-request-revision")
      .set("X-Openclaw-Feedback-Category", "style")
      .send(noCommentMutation());

    expectCommentRequiredError(res);
  });

  it("request-changes at code-review succeeds when a non-empty comment is attached", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Feedback-Category", "correctness")
      .set("X-Openclaw-From-Body", "charles")
      .send(withCommentMutation("Tests fail on edge case X. Fix and re-submit."));

    expectNoCommentError(res);
  });

  // ── block: not an existing intent; modeled as a real YAML transition ───

  it("block at code-review fails with a clear validation error when the comment is missing", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "block")
      .send(noCommentMutation());

    expectCommentRequiredError(res);
    expect(res.body.errors[0].message).toContain("--comment-file");
  });

  it("block at code-review succeeds when a non-empty comment is attached", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "block")
      .send(withCommentMutation("Blocked: upstream API contract is not finalized yet."));

    expectNoCommentError(res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3: transition-carried comments do not feed the rate-limit/dedup counter
// ═══════════════════════════════════════════════════════════════════════════
//
// Speculative: no recent-comment rate-limit or dedup counter currently exists
// in the codebase (verified: no `commentStats`, `recentComment`, or
// `commentRateLimit` field on /health, no such module under src/). Per the
// ticket's own fallback instruction, this section asserts the shape the
// implementer is expected to add: a `commentStats` object on /health whose
// count only reflects free-standing agent comments, not comments carried by
// a transition command in the same request.

describe("proxy — INF-443 AC3: transition-carried comments excluded from rate-limit/dedup counters", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf443-ac3-"));
    process.env.AGENTS_FILE = writeProxyAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), PROXY_POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, PROXY_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("/health exposes a commentStats liveness field with a transition-carried counter", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.commentStats).toBeDefined();
    expect(typeof res.body.commentStats.transitionCarriedComments).toBe("number");
    expect(typeof res.body.commentStats.recentAgentComments).toBe("number");
  });

  it("a comment carried by submit does not increment recentAgentComments for charles", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const before = await request(appState.app).get("/health");
    const beforeCount = before.body.commentStats.recentAgentComments as number;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Target", "reviewer")
      .send(withCommentMutation("Implemented all AC. Tests pass. Ready for review."));

    expect(res.status).toBe(200);

    const after = await request(appState.app).get("/health");
    const afterCount = after.body.commentStats.recentAgentComments as number;

    // The comment was mandatory transition metadata, not a free-standing
    // agent comment — it must not count against charles's recent-comment
    // rate-limit / dedup window.
    expect(afterCount).toBe(beforeCount);
  });

  it("a comment carried by refuse-work does not increment recentAgentComments for the caller", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const before = await request(appState.app).get("/health");
    const beforeCount = before.body.commentStats.recentAgentComments as number;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send(withCommentMutation("Blocked on missing credentials for the staging DB."));

    expect(res.status).toBe(200);

    const after = await request(appState.app).get("/health");
    const afterCount = after.body.commentStats.recentAgentComments as number;

    expect(afterCount).toBe(beforeCount);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4: comment-handling logic component is wired at bootstrap
// ═══════════════════════════════════════════════════════════════════════════

const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

function writeBootstrapAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: "u-astrid",
          openclawAgent: "astrid",
          accessToken: "tok-astrid",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("INF-443 AC4: transitionCommentLogic bootstrap wiring", () => {
  let server: ChildProcess | null = null;
  let dir: string;
  const PORT = 4900 + (process.pid % 300);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-443-boot-"));
    process.env.AGENTS_FILE = writeBootstrapAgents(dir);
  });

  afterAll(() => {
    if (server) {
      server.kill("SIGTERM");
    }
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.AGENTS_FILE;
  });

  it("dist/index.js boots and /health exposes transitionCommentLogic liveness", async () => {
    // Skip if dist/ hasn't been built — same guard as remediation-bootstrap.test.ts.
    if (!fs.existsSync(DIST_ENTRY)) {
      console.warn(`SKIP: ${DIST_ENTRY} not found — run 'npm run build' before this test.`);
      return;
    }

    const env = {
      ...process.env,
      PORT: String(PORT),
      ADMIN_SECRET: "inf-443-test",
      DATA_DIR: dir,
      NODE_ENV: "production",
    };

    server = spawn(process.execPath, [DIST_ENTRY], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.resolve(__dirname, ".."),
    });

    let body: Record<string, unknown> | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (res.ok) {
          body = (await res.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        // Server not ready yet — retry.
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(body).not.toBeNull();

    // The comment-handling logic component must be wired in createApp() —
    // visible in /health without waiting for a real transition to occur.
    // This is the AI-1808 dead-code guard: importable-but-unregistered
    // components have shipped before (AI-1773, AI-1775).
    expect(body!.transitionCommentLogic).toBeDefined();
    const live = body!.transitionCommentLogic as Record<string, unknown>;
    expect(live.registered).toBe(true);
  }, 15_000);
});
