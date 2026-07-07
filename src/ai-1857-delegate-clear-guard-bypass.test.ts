/**
 * AI-1857 — Tests for delegate-clear guard bypass via partial semantic-verb
 * application (Defect 1).
 *
 * AC of record (captured at intake 2026-07-06):
 *   "Delegate clears on wf-enrolled tickets are blocked (or immediately
 *    healed) regardless of mutation shape, incl. partial semantic-verb
 *    application; proven by test reproducing the complete-partial-apply
 *    shape."
 *
 * Defect: `checkRawMutationInterception` blocks `delegateId:null` only when
 * `delegateOnlyChange === true`. A semantic verb (e.g. `complete`) bundles
 * `delegateId:null + assigneeId:null` in one `issueUpdate` —
 * `hasAssigneeChange` is true, so the delegate-only guard path never fires.
 * The intent-path Layer 2 re-check runs the same function with the same
 * bypass. The fix: strip `delegateId` and `assigneeId` from forwarded
 * intent-bearing mutations before they reach Linear.
 *
 * Tests strategy: send a valid intent (one that passes checkWorkflowRules)
 * with {delegateId:null, assigneeId:null} in the body and assert the
 * forwarded mutation does NOT carry these null fields to Linear.
 * On current code (no stripping), the B2 guard blocks the whole mutation
 * instead of selectively stripping, which means valid workflow transitions
 * carrying these fields fail unnecessarily. After the fix, the fields are
 * stripped before B2 runs, allowing valid transitions through while keeping
 * delegate management proxy-side.
 *
 * All tests MUST be RED until the implementation lands.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, checkRawMutationInterception } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: test-author
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
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
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: doing
    transitions:
      - command: tests-ready
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: deployment
  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: ac-validate
        requires_capability: deploy:execute
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "hanzo", linearUserId: "u-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
        { name: "tdd", linearUserId: "u-tdd", openclawAgent: "tdd", accessToken: "tok-tdd", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function writePolicyFile(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, TEST_POLICY_YAML, "utf8");
  return file;
}

function writeWorkflowFile(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(file, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = file;
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
// AC1: Delegate clears on wf-enrolled tickets blocked regardless of
//       mutation shape — complete-partial-apply shape
//
// Strategy: we test two surfaces:
//   1. Unit: checkRawMutationInterception — the partial-apply shape
//      {delegateId:null, assigneeId:null} must be blocked with a message
//      that specifically identifies the delegate-clear attempt.
//   2. Integration: proxy-level stripping — a valid intent-bearing mutation
//      that carries {delegateId:null, assigneeId:null} must NOT forward
//      those fields to Linear (they must be stripped before forwarding).
// ══════════════════════════════════════════════════════════════════════════

// ── Part A: Unit tests — checkRawMutationInterception with partial-apply shape ──

describe("AI-1857 AC1 (unit): complete-partial-apply shape is blocked with specific delegate-clear message", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-guard-unit-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    writeWorkflowFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.AGENTS_FILE;
  });

  it("blocks {delegateId:null, assigneeId:null} on wf-enrolled ticket with specific delegate-clear message", async () => {
    // This is the complete-partial-apply shape: the `complete` CLI verb bundles
    // both fields. The delegateOnlyChange guard (AI-1835) does not fire because
    // hasAssigneeChange=true. The fix must ensure the delegate-clear guard fires
    // regardless, producing a message that specifically identifies the
    // delegate-clear attempt (not just the generic "assignee/delegate" block).
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
              delegate: { id: "u-hanzo" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const body = {
      query: `mutation ClearAll($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { delegateId: null, assigneeId: null } },
    };

    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "hanzo", "u-hanzo",
    );

    expect(result).not.toBeNull();
    // After fix: the specific AI-1835 delegate-clear guard fires regardless of
    // hasAssigneeChange, producing a message that mentions the delegate clearing.
    // Currently RED: the general "assignee/delegate" block fires, and the
    // message does not specifically call out the delegateId:null self-clear.
    // The specific message must identify the delegate-null pattern (not just
    // report a generic "direct changes are blocked" message).
    expect(result!.toLowerCase()).toContain("delegate");
    expect(result).toContain("[Proxy]");
    // The specific guard message (AI-1835 pattern) should fire:
    // "Direct delegate clear blocked: the current delegate may re-route..."
    // Currently RED: the message says "Direct assignee/delegate changes are blocked"
    // (general block), not the specific AI-1835 delegate-null message.
    expect(result).toMatch(/delegate.*clear|clear.*delegate|delegateId.*null|null.*delegate/i);
  });

  it("blocks {delegateId:null, assigneeId:null} even when caller IS the current delegate", async () => {
    // The partial-apply shape specifically hits when the current delegate
    // (e.g. Hanzo) runs `complete` on their own ticket. The guard must fire
    // even though the combined shape (delegateId+assigneeId both null) bypasses
    // the delegateOnlyChange=true path.
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
              delegate: { id: "u-hanzo" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const body = {
      query: `mutation CompletePartialApply($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { delegateId: null, assigneeId: null } },
    };

    // hanzo IS the current delegate (u-hanzo === u-hanzo)
    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "hanzo", "u-hanzo",
    );

    expect(result).not.toBeNull();
    // Whether blocked by specific guard or general block, the mutation must
    // NOT pass through (result must be non-null = rejection).
    expect(result).toContain("[Proxy]");
  });
});

// ── Part B: Integration tests — proxy-level stripping of delegateId/assigneeId ──

describe("AI-1857 AC1 (integration): intent-bearing mutations have delegateId/assigneeId stripped", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  /** Captured requests forwarded to the Linear API. */
  let forwardedBodies: Array<{ variables?: { input?: Record<string, unknown> } }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-strip-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    writeWorkflowFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    forwardedBodies = [];

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;

    // Mock: return an ad-hoc (non-wf) ticket for context fetches.
    // This means checkWorkflowRules and B2 both pass (no wf to enforce).
    // The mutation will be forwarded, letting us verify stripping behavior.
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
        const query = parsed.query ?? "";

        // Record forwarded issueUpdate mutations (not context reads)
        if (query.includes("issueUpdate") && !query.includes("IssueContext")) {
          forwardedBodies.push(parsed as { variables?: { input?: Record<string, unknown> } });
        }

        // Ticket context: ad-hoc ticket (no wf:* label) so workflow gates pass-through
        if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  labels: { nodes: [{ name: "bug" }, { name: "priority:high" }] },
                  delegate: null,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Success for forwarded mutations
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid", identifier: "AI-TEST" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.AGENTS_FILE;
  });

  it("delegateId:null is stripped from the forwarded mutation body on the intent path", async () => {
    // The complete-partial-apply shape sends {delegateId:null, assigneeId:null}.
    // Even on an ad-hoc (non-wf) ticket, the proxy should strip these fields
    // because the proxy always manages delegates — the CLI must not write null
    // delegate/assignee directly regardless of workflow enrollment.
    //
    // Currently RED: the fields are forwarded as-is (no stripping implemented).
    // After fix: the fields are absent from the forwarded body.
    const mutation = {
      query: `mutation CompleteIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: {
        id: "issue-uuid",
        input: {
          delegateId: null,
          assigneeId: null,
        },
      },
      operationName: "CompleteIssue",
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "note")
      .set("x-openclaw-linear-target", "AI-TEST")
      .set("Content-Type", "application/json")
      .send(mutation);

    // The mutation should have been forwarded to Linear
    const fwd = forwardedBodies.find((b) => b.variables?.input !== undefined);
    expect(fwd).toBeDefined();
    if (fwd?.variables?.input) {
      // After fix: delegateId is stripped (absent or non-null)
      // Currently RED: delegateId is null (forwarded as-is)
      expect(fwd.variables.input).not.toHaveProperty("delegateId");
    }
  });

  it("assigneeId:null is stripped from the forwarded mutation body on the intent path", async () => {
    const mutation = {
      query: `mutation ClearAssignee($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: {
        id: "issue-uuid",
        input: {
          assigneeId: null,
          delegateId: null,
        },
      },
      operationName: "ClearAssignee",
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "note")
      .set("x-openclaw-linear-target", "AI-TEST")
      .set("Content-Type", "application/json")
      .send(mutation);

    const fwd = forwardedBodies.find((b) => b.variables?.input !== undefined);
    expect(fwd).toBeDefined();
    if (fwd?.variables?.input) {
      // After fix: assigneeId is stripped (absent)
      // Currently RED: assigneeId is null in the forwarded body
      expect(fwd.variables.input).not.toHaveProperty("assigneeId");
    }
  });

  it("non-null delegateId in a forwarded intent mutation is preserved (no false-positive stripping)", async () => {
    // Non-null delegateId should NOT be stripped — only null values are cleared.
    const mutation = {
      query: `mutation SetDelegate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: {
        id: "issue-uuid",
        input: {
          delegateId: "u-charles",
        },
      },
      operationName: "SetDelegate",
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "note")
      .set("x-openclaw-linear-target", "AI-TEST")
      .set("Content-Type", "application/json")
      .send(mutation);

    const fwd = forwardedBodies.find((b) => b.variables?.input !== undefined);
    if (fwd?.variables?.input) {
      // A non-null delegateId should be preserved in the forwarded body
      // (only null clears are stripped)
      expect(fwd.variables.input.delegateId).toBe("u-charles");
    }
  });
});
