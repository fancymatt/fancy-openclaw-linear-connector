/**
 * G-13a — Break-glass identity gate + audit event (AI-1551).
 *
 * The `X-Openclaw-Break-Glass` header lets a caller bypass the fail-closed
 * config-health / workflow-registry checks. Before this feature the header was
 * accepted from *anyone*. The AC requires:
 *
 *   AC1: break-glass from a non-steward body → rejected (identity gate)
 *   AC2: break-glass from a steward/human body → allowed
 *   AC3: every successful break-glass use emits a "break-glass-used" audit event
 *
 * AC4 (T-row in conformance/adversarial matrix) lives in
 * conformance-matrix.test.ts.
 *
 * These tests are written RED-first (no implementation exists yet).
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { OPERATIONAL_EVENT_OUTCOMES } from "./store/operational-event-store.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

// Policy: astrid is the recovery steward (workflow:break-glass), charles is a dev (no break-glass).
const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: []
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: escape
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
    native_state: todo
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

// Ticket response for a wf:dev-impl ticket in the implementation state.
const DEV_IMPL_IMPLEMENTATION_RESPONSE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "user-charles" },
    },
  },
};

const MOCK_MUTATION_SUCCESS = { data: { issueUpdate: { success: true } } };

// ── Helpers ────────────────────────────────────────────────────────────────

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "user-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
        { name: "astrid",  linearUserId: "user-astrid",  openclawAgent: "astrid",  accessToken: "tok-astrid",  host: "local" },
        { name: "hanzo",   linearUserId: "user-hanzo",   openclawAgent: "hanzo",   accessToken: "tok-hanzo",   host: "local" },
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

// ── Test suite ─────────────────────────────────────────────────────────────

describe("G-13a: break-glass identity gate (AI-1551)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-identity-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    writeWorkflowFile(dir);
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
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  // Build a fetch mock: first call returns label context; subsequent calls
  // return the upstream mutation success.
  function makeFetch(labelResponse: object, mutationResponse = MOCK_MUTATION_SUCCESS): typeof globalThis.fetch {
    return async (url: any, init?: RequestInit) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
      if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels") || parsed.query?.includes("delegate")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mutationResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
  }

  // ── AC1: non-steward body → rejected ──────────────────────────────────────

  it("AC1: rejects X-Openclaw-Break-Glass from a non-steward body (charles/dev container)", async () => {
    // Break the workflow config so break-glass would normally be needed.
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    // The rejection must mention the identity gate reason, not just the config issue.
    expect(res.body.errors[0].message).toMatch(/break.glass|identity|steward/i);
  });

  it("AC1: rejects X-Openclaw-Break-Glass from an unknown/unregistered caller", async () => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-unknown")
      .set("X-Openclaw-Agent", "unknown-agent")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/break.glass|identity|steward/i);
  });

  // ── AC2: steward body → allowed ────────────────────────────────────────────

  it("AC2: allows X-Openclaw-Break-Glass from a steward body (astrid)", async () => {
    // Break the workflow config so the request would normally fail-closed.
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // Steward with break-glass must bypass the fail-closed check.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  // ── AC3: audit event emitted on every break-glass use ────────────────────

  it("AC3: 'break-glass-used' is a registered operational event outcome", () => {
    // This fails today because the outcome does not exist in OPERATIONAL_EVENT_OUTCOMES.
    expect(OPERATIONAL_EVENT_OUTCOMES).toContain("break-glass-used");
  });

  it("AC3: emits a break-glass-used audit event when a steward uses break-glass", async () => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // The proxy must record a break-glass-used event with the caller's identity.
    const events = appState.operationalEventStore.query({ outcome: "break-glass-used" as any });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].agent).toBe("astrid");
  });

  it("AC3: does not emit a break-glass-used event when break-glass is rejected (non-steward)", async () => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // Rejected use must NOT generate a break-glass-used event (prevents log flooding).
    const events = appState.operationalEventStore.query({ outcome: "break-glass-used" as any });
    expect(events.length).toBe(0);
  });
});
