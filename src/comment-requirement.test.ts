/**
 * AI-1731: Enforce comment requirement on continue-workflow transitions.
 *
 * When an agent runs `linear continue-workflow <id> <reviewer>` (which resolves
 * to `submit`) without `--comment-file`, the proxy must reject the transition.
 * The same enforcement applies to `request-revision` (resolves to transitions
 * like `request-changes`, `reject`, `ac-fail`) and any transition marked
 * `requires_comment: true` in the workflow definition.
 *
 * INF-443 amendment: routine forward-progress transitions (continue, begin,
 * accept, submit, complete) are now EXEMPT from requires_comment, even when
 * the workflow def marks them requires_comment: true — that flag is meant for
 * human-reasoned transitions (request-changes, block, reject, ac-fail), not
 * ordinary spine progress. `submit` is one of the exempted commands, so the
 * AC1/AC2/AI-1769 tests below that used to pin "submit requires a comment"
 * now pin the opposite (submit is exempt) and the general
 * requires_comment/satisfied-by mechanism is instead exercised against
 * `reject` (still requires_comment: true, not in the routine set).
 *
 * AC mapping:
 *   AC1: submit at implementation without comment → allowed (INF-443: routine, exempt)
 *   AC2: submit at implementation with comment → allowed
 *   AC3: no regression on other states (intake, write-tests, code-review approve, deployment deploy)
 *   AC4: request-revision transitions also enforce comment requirement
 *
 * Test scope: proxy integration tests (end-to-end through the HTTP layer).
 *
 * Implementation notes for the implementer:
 *   - The `requires_comment: true` field is already defined in WorkflowTransition
 *     (workflow-gate.ts). It is now set on relevant transitions in the test
 *     YAML fixture and should be added to the canonical dev-impl.yaml.
 *   - The proxy (proxy.ts) must check for a comment body before forwarding an
 *     intent-bearing request whose matched transition has requires_comment: true.
 *   - A comment is detected when the request GraphQL body contains a
 *     `commentCreate` mutation with a non-empty body. The existing
 *     `extractCommentBody` helper in proxy.ts already does this.
 *   - The `checkWorkflowRules` function should accept an additional parameter
 *     `hasComment?: boolean` (after isMetaIntent, default false) that the
 *     proxy passes based on extractCommentBody. When requires_comment is true
 *     and hasComment is false, reject with a clear error naming the transition
 *     and --comment-file.
 *   - Break-glass (escape) should be exempt from comment requirement.
 *   - The canonical dev-impl.yaml fixture (src/__fixtures__/canonical-dev-impl.yaml)
 *     must be updated to add requires_comment: true on submit, request-changes,
 *     reject, and ac-fail transitions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

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

// Workflow def with requires_comment on transitions that need it.
// submit (implementation→code-review), request-changes, reject, ac-fail.
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
      - command: accept
        to: implementation
      - command: demote
        to: __ad_hoc__
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
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
  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
      - command: reject
        to: implementation
        requires_comment: true
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
          { id: "s-thinking", name: "Thinking", type: "started" },
          { id: "s-backlog", name: "Backlog", type: "unstarted" },
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

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests: proxy end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy — AI-1731 comment requirement integration", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-comment-test-"));
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

  // ── AC1 (INF-443): submit at implementation without comment → allowed (routine, exempt) ──

  it("INF-443 AC1: allows submit at implementation when the request body is an issueUpdate (no commentCreate) — routine transition, exempt from requires_comment", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Target", "reviewer")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
        expect(err.message).not.toContain("--comment-file");
      }
    }
  });

  // AC1 (INF-443): rejection message quality — now exercised against `reject`
  // (still requires_comment: true, not in the INF-443 routine-command set).
  it("AC1: rejection message names --comment-file and the transition", async () => {
    globalThis.fetch = makeProxyFetch(DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "reject")
      .set("X-Openclaw-Feedback-Category", "missing-tests")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.body.errors[0].message).toMatch(/reject.*comment|--comment-file.*reject/i);
  });

  // ── AC2: submit at implementation with comment → allowed ──────────────

  it("AC2: allows submit at implementation when the request contains a commentCreate with body", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Target", "reviewer")
      .send({
        query: `mutation commentCreate($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }`,
        variables: { issueId: "issue-uuid", body: "Implemented all AC. Tests pass. Ready for review." },
      });

    expect(res.status).toBe(200);
    // Should NOT be rejected by comment gate
    // May be rejected by other gates (delegate, target) — but NOT comment
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
        expect(err.message).not.toContain("--comment-file");
      }
    }
  });

  // AC2 (INF-443): empty comment body does NOT satisfy the requirement — now
  // exercised against `reject` since `submit` is exempt from requires_comment.
  it("AC2: rejects reject at deployment when commentCreate body is empty string", async () => {
    globalThis.fetch = makeProxyFetch(DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "reject")
      .set("X-Openclaw-Feedback-Category", "missing-tests")
      .send({
        query: `mutation commentCreate($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }`,
        variables: { issueId: "issue-uuid", body: "" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
  });

  // ── AC3: no regression on other states ────────────────────────────────

  it("AC3: accept at intake passes without comment (no requires_comment)", async () => {
    globalThis.fetch = makeProxyFetch(INTAKE_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("AC3: approve at code-review passes without comment (no requires_comment)", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "approve")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("AC3: deploy at deployment — rejected only by capability gate, not comment", async () => {
    globalThis.fetch = makeProxyFetch(DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "deploy")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    // charles lacks deploy:execute — should be rejected by capability, NOT comment
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
        expect(err.message).not.toContain("--comment-file");
      }
    }
  });

  it("AC3: escape passes without comment (break-glass exempt)", async () => {
    globalThis.fetch = makeProxyFetch(IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("AC3: continue-workflow (meta-intent resolving to accept) at intake passes without comment", async () => {
    globalThis.fetch = makeProxyFetch(INTAKE_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "continue-workflow")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // Accept at intake has no requires_comment, so continue-workflow→accept should pass
    expect(res.status).toBe(200);
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
      }
    }
  });

  // ── AC4: request-revision transitions enforce comment requirement ────

  it("AC4: rejects request-changes at code-review without comment", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Feedback-Category", "correctness")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
    expect(res.body.errors[0].message).toContain("--comment-file");
  });

  it("AC4: allows request-changes at code-review with comment", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Feedback-Category", "correctness")
      .set("X-Openclaw-From-Body", "charles")
      .send({
        query: `mutation commentCreate($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }`,
        variables: { issueId: "issue-uuid", body: "Tests fail on edge case X. Fix and re-submit." },
      });

    expect(res.status).toBe(200);
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
      }
    }
  });

  it("AC4: rejects reject at deployment without comment", async () => {
    globalThis.fetch = makeProxyFetch(DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "reject")
      .set("X-Openclaw-Feedback-Category", "missing-tests")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
  });

  it("AC4: allows reject at deployment with comment", async () => {
    globalThis.fetch = makeProxyFetch(DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "reject")
      .set("X-Openclaw-Feedback-Category", "missing-tests")
      .send({
        query: `mutation commentCreate($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }`,
        variables: { issueId: "issue-uuid", body: "Build fails on staging. Reverting." },
      });

    expect(res.status).toBe(200);
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
      }
    }
  });

  // AC4: request-revision (meta-intent resolving to request-changes) without comment
  it("AC4: rejects request-revision (meta-intent) at code-review without comment", async () => {
    globalThis.fetch = makeProxyFetch(CODE_REVIEW_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "reviewer")
      .set("X-Openclaw-Linear-Intent", "request-revision")
      // AI-2530 gates the intent-resolving path (continue-workflow /
      // request-revision) on a per-invocation nonce. Without it this request is
      // rejected at the header guard and never reaches the comment requirement
      // this test exists to prove (AI-2536).
      .set("X-Openclaw-Command-Id", "ai1731-ac4-request-revision")
      .set("X-Openclaw-Feedback-Category", "style")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
    // Pin the rejection to the comment requirement itself. If the AI-2530 header
    // guard ever rejects this request again, the assertion above fails for the
    // wrong reason and this one names it — the silent coverage loss of AI-2536.
    expect(res.body.errors[0].message).not.toContain("X-Openclaw-Command-Id");
  });

  // ── AI-1769 AC2: X-Openclaw-Comment-Satisfied-By ──────────────────────
  // A dedup-suppressed comment may satisfy requires_comment when the CLI
  // points at the existing comment that already carries the feedback. The
  // proxy verifies issue match, recency, and authorship — fail-closed.

  function makeSatisfiedByFetch(labelResponse: object, commentNode: object | null) {
    const base = makeProxyFetch(labelResponse);
    return async (url: unknown, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
      if (typeof url === "string" && url.includes("api.linear.app") && parsed.query?.includes("SatisfiedByComment")) {
        return new Response(JSON.stringify({ data: { comment: commentNode } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return base(url, init);
    };
  }

  // INF-443: `submit` is now exempt from requires_comment (routine transition),
  // so the satisfied-by fail-closed mechanics below are exercised against
  // `reject` (still requires_comment: true, at deployment, caller hanzo/u2)
  // instead — the general satisfied-by verification logic is unrelated to
  // which specific transition triggered the comment requirement.
  const VALID_SATISFIED_COMMENT = {
    id: "comment-dup-1",
    createdAt: new Date(Date.now() - 20_000).toISOString(), // 20s old
    user: { id: "u2" }, // hanzo
    issue: { id: "issue-uuid", identifier: "AI-999" },
  };

  function satisfiedByReject() {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "reject")
      .set("X-Openclaw-Feedback-Category", "missing-tests")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-dup-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });
  }

  it("AI-1769: allows reject without commentCreate when a verified satisfied-by comment is referenced", async () => {
    globalThis.fetch = makeSatisfiedByFetch(DEPLOYMENT_RESPONSE, VALID_SATISFIED_COMMENT);

    const res = await satisfiedByReject();
    expect(res.status).toBe(200);
    if (res.body.errors) {
      for (const err of res.body.errors) {
        expect(err.message).not.toContain("comment");
        expect(err.message).not.toContain("--comment-file");
      }
    }
  });

  it("AI-1769: rejects satisfied-by pointing at a comment on a DIFFERENT issue (fail-closed)", async () => {
    globalThis.fetch = makeSatisfiedByFetch(DEPLOYMENT_RESPONSE, {
      ...VALID_SATISFIED_COMMENT,
      issue: { id: "other-issue-uuid", identifier: "AI-111" },
    });

    const res = await satisfiedByReject();
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
  });

  it("AI-1769: rejects a stale satisfied-by comment (older than 1h, fail-closed)", async () => {
    globalThis.fetch = makeSatisfiedByFetch(DEPLOYMENT_RESPONSE, {
      ...VALID_SATISFIED_COMMENT,
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });

    const res = await satisfiedByReject();
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
  });

  it("AI-1769: rejects a satisfied-by comment authored by someone else (fail-closed)", async () => {
    globalThis.fetch = makeSatisfiedByFetch(DEPLOYMENT_RESPONSE, {
      ...VALID_SATISFIED_COMMENT,
      user: { id: "u9" },
    });

    const res = await satisfiedByReject();
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
  });

  it("AI-1769: rejects satisfied-by when the comment lookup returns null (fail-closed)", async () => {
    globalThis.fetch = makeSatisfiedByFetch(DEPLOYMENT_RESPONSE, null);

    const res = await satisfiedByReject();
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("comment");
  });
});
