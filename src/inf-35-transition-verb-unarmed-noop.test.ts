/**
 * INF-35: Workflow transition verbs silently no-op with exit 0 on unarmed
 * tickets, and report a stale state in the response envelope.
 *
 * Bug: When a workflow transition verb (accept, escape, submit, demote, ...)
 * runs on a ticket with no `wf:*` label, checkWorkflowRules() hits the §4.6
 * pass-through (`if (!workflowId) return null`), the proxy forwards the
 * mutation, and since no workflow-armed mutation applies, the result is a
 * no-op with exit 0 — indistinguishable from success.
 *
 * AC1 — A workflow transition verb run on a ticket with no `wf:*` label
 *     fails loudly: checkWorkflowRules returns a rejection string (non-null)
 *     explaining the ticket is not on a workflow and naming the legal next
 *     move.
 * AC2 — The `state` field in the forwarded mutation response envelope
 *     reflects the ticket's actual current state, or is absent. It must
 *     never report a stale/incorrect state alongside a no-op.
 * AC3 — All direct transition verbs (accept, escape, submit, demote,
 *     validated, ac-fail, needs-human, continue (meta-resolved), ...) are
 *     gated the same way at the §4.6 boundary. Safe verbs (note, begin-work,
 *     observe-issue) remain pass-through.
 * AC4 — Regression test: transition verb on an unarmed ticket → non-null
 *     rejection from checkWorkflowRules, proxy returns error, ticket unchanged.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Shared test fixtures ─────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, workflow:break-glass]
roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
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
      - command: demote
        to: __ad_hoc__
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
        requires_comment: true
      - command: needs-human
        to: blocked
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
      - command: ac-fail
        to: implementation
        requires_comment: true
  - id: blocked
    kind: normal
    native_state: todo
    transitions:
      - command: unblock
        to: implementation
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Create a fetch mock for a ticket with NO wf:* labels.
 * The ticket carries arbitrary non-workflow labels only.
 */
function makeNoWfLabelsFetch(): typeof globalThis.fetch {
  return async (_url, _init) => {
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: [{ name: "bug" }, { name: "priority:high" }] },
            delegate: null,
            assignee: null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ── AC1: checkWorkflowRules unit — reject transition verbs on unarmed tickets ──

describe("INF-35 AC1: checkWorkflowRules rejects transition verbs on unarmed tickets", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-35-ac1-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-client", clientSecret: "i-secret", accessToken: "i-token", refreshToken: "i-refresh" },
      ],
    }, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects 'accept' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("accept", "INF-35", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
    expect(result).toContain("workflow ticket");
  });

  it("rejects 'escape' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("escape", "INF-35", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("rejects 'submit' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("submit", "INF-35", "Bearer tok", "igor");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("rejects 'demote' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("demote", "INF-35", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("rejects 'needs-human' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("needs-human", "INF-35", "Bearer tok", "igor");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("rejects 'ac-fail' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("ac-fail", "INF-35", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("rejects 'validated' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("validated", "INF-35", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("rejects 'refuse-work' on a ticket with no wf:* label (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("refuse-work", "INF-35", "Bearer tok", "igor");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("allows 'handoff-work' on a ticket with no wf:* label (delegate-routing verb — AC3)", async () => {
    // handoff-work is a delegate-routing meta-command, not a def transition.
    // It works on any ticket to set the delegate.
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("handoff-work", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'set-state' on a ticket with no wf:* label (state-setting verb — AC3)", async () => {
    // set-state is a direct state-setting tool, not a workflow def transition.
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("set-state", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'note' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("note", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'begin-work' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("begin-work", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'observe-issue' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("observe-issue", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'comment' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("comment", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'parent' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("parent", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'migrate-state' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("migrate-state", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'rewind' on a ticket with no wf:* label (safe verb — AC3)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("rewind", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'complete' on a ticket with no wf:* label (INF-63 AC — ad-hoc close path)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("complete", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("allows 'cancel' on a ticket with no wf:* label (INF-63 AC — ad-hoc close path)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("cancel", "INF-35", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("error message names the reason and the legal next move (AC1)", async () => {
    globalThis.fetch = makeNoWfLabelsFetch();
    const result = await checkWorkflowRules("submit", "INF-35", "Bearer tok", "igor");
    expect(result).not.toBeNull();
    // Should name "no wf:* label" or "not a workflow ticket"
    expect(result).toMatch(/no `wf:\*` label|not on a workflow|not a workflow ticket/i);
    // Should point at a legal next move
    expect(result).toMatch(/begin-work|note|observe/i);
  });
});

// ── AC4: Proxy integration — full end-to-end test ──────────────────────────

describe("INF-35 AC4: proxy integration — transition verb on unarmed ticket returns error", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  // Ticket with NO wf:* labels — only non-workflow labels.
  const UNARMED_B1_RESPONSE = {
    data: {
      issue: {
        labels: { nodes: [{ name: "bug" }, { name: "priority:high" }] },
        delegate: null,
        assignee: null,
      },
    },
  };

  function writeAgents(d: string): string {
    const file = path.join(d, "agents.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        agents: [
          { name: "astrid", linearUserId: "astrid-uuid", openclawAgent: "astrid", accessToken: "tok", host: "local" },
          { name: "igor", linearUserId: "igor-uuid", openclawAgent: "igor", accessToken: "tok", host: "local" },
        ],
      }),
      "utf8",
    );
    return file;
  }

  function makeProxyFetchNoWfLabels(): {
    fetch: typeof globalThis.fetch;
    calls: FetchCall[];
  } {
    const calls: FetchCall[] = [];

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });

      const q = parsed.query ?? "";

      // B1 gate fetch — IssueContext labels
      if (q.includes("IssueContext")) {
        return new Response(JSON.stringify(UNARMED_B1_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // If a B2 fetch somehow fires (it shouldn't for a rejected transition)
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                identifier: "INF-35",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "bug-lbl", name: "bug" }, { id: "priority-lbl", name: "priority:high" }] },
                delegate: null,
                assignee: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Forwarded mutation — should never fire for a rejected verb
      if (q.includes("issueUpdate") || q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fallback
      return new Response(
        JSON.stringify({ data: { viewer: { id: "user-1", name: "Agent" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    return { fetch: mockFetch, calls };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-35-ac4-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
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

  it("proxy: 'accept' on unarmed ticket returns error, no mutation forwarded (AC4)", async () => {
    const { fetch: mock, calls } = makeProxyFetchNoWfLabels();
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    // Must still return HTTP 200 (the proxy always responds 200)
    expect(res.status).toBe(200);
    // Must contain an error — not a success
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0].message).toContain("no `wf:*` label");
    expect(res.body.errors[0].message).toContain("workflow ticket");

    // No issueUpdate/commentCreate should have been forwarded
    const forwardedMutations = calls.filter(
      (c) => c.query.includes("issueUpdate") || c.query.includes("commentCreate"),
    );
    expect(forwardedMutations.length).toBe(0);
  });

  it("proxy: 'escape' on unarmed ticket returns error (AC4)", async () => {
    const { fetch: mock, calls } = makeProxyFetchNoWfLabels();
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("no `wf:*` label");

    const forwardedMutations = calls.filter(
      (c) => c.query.includes("issueUpdate") || c.query.includes("commentCreate"),
    );
    expect(forwardedMutations.length).toBe(0);
  });

  it("proxy: 'submit' on unarmed ticket returns error (AC4)", async () => {
    const { fetch: mock, calls } = makeProxyFetchNoWfLabels();
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("no `wf:*` label");

    const forwardedMutations = calls.filter(
      (c) => c.query.includes("issueUpdate") || c.query.includes("commentCreate"),
    );
    expect(forwardedMutations.length).toBe(0);
  });

  it("proxy: 'note' on unarmed ticket passes through (safe verb — AC3/C4 collateral)", async () => {
    const { fetch: mock, calls } = makeProxyFetchNoWfLabels();
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "note")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    // 'note' is a safe verb — must pass through without error
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("proxy: 'begin-work' on unarmed ticket passes through (safe verb — AC3/C4 collateral)", async () => {
    const { fetch: mock, calls } = makeProxyFetchNoWfLabels();
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "begin-work")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("proxy: response envelope does NOT include a stale state field on rejection (AC2)", async () => {
    const { fetch: mock } = makeProxyFetchNoWfLabels();
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    // The error response must not include a stale state field
    // (the original bug reported state="To Do" when the ticket was actually "Thinking")
    expect(res.body.state).toBeUndefined();

    // _workflowTransition should also be absent since no transition was applied
    expect(res.body._workflowTransition).toBeUndefined();
  });
});

// ── AC2: Response envelope does not report stale state ────────────────────

describe("INF-35 AC2: response envelope must not report stale state on reject", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  function writeAgents(d: string): string {
    const file = path.join(d, "agents.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        agents: [
          { name: "astrid", linearUserId: "astrid-uuid", openclawAgent: "astrid", accessToken: "tok", host: "local" },
        ],
      }),
      "utf8",
    );
    return file;
  }

  function makeProxyFetchNoWfLabels(): typeof globalThis.fetch {
    const UNARMED_B1 = {
      data: {
        issue: {
          labels: { nodes: [{ name: "bug" }] },
          delegate: null,
          assignee: null,
        },
      },
    };

    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const q = parsed.query ?? "";

      if (q.includes("IssueContext")) {
        return new Response(JSON.stringify(UNARMED_B1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ data: { viewer: { id: "user-1" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-35-ac2-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
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

  it("response body has no 'state' field when transition is rejected on unarmed ticket (AC2)", async () => {
    globalThis.fetch = makeProxyFetchNoWfLabels();

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    // AC2: The response must not include a state field.
    // The original bug reported state:"To Do" which was stale.
    expect(res.body.state).toBeUndefined();
  });

  it("response body has no '_workflowTransition' on reject (AC2 collateral)", async () => {
    globalThis.fetch = makeProxyFetchNoWfLabels();

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "INF-35" },
      });

    expect(res.body._workflowTransition).toBeUndefined();
  });
});
