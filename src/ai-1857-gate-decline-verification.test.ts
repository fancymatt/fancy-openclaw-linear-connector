/**
 * AI-1857 — Tests for gate-decline CLI output verification (Defect 3).
 *
 * AC of record (captured at intake 2026-07-06):
 *   "Gate-decline CLI output never asserts 'no partial state' unless
 *    verified against post-transition ticket state."
 *
 * Current defect: When the proxy rejects a workflow gate transition, the
 * CLI's response parsing reports "Label and delegate are unchanged — no
 * partial state was written" — but a Thinking→Doing engagement-status
 * transition may have fired at the same time, making the "no partial state"
 * claim false.
 *
 * This defect is CLI-side (the CLI interprets the proxy rejection), but
 * the fix may involve:
 *   (a) The proxy returning a structured post-transition state snapshot in
 *       the rejection response, or
 *   (b) The CLI verifying ticket state before claiming "no partial state".
 *
 * These tests verify the PROXY side: the rejection response must include
 * enough information for the CLI (or a downstream verifier) to confirm
 * no partial state was written.
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
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
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
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
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

const TICKET_IN_CODE_REVIEW = {
  data: {
    issue: {
      id: "issue-uuid",
      identifier: "AI-GATE",
      labels: {
        nodes: [
          { id: "lbl-wf", name: "wf:dev-impl" },
          { id: "lbl-state", name: "state:code-review" },
        ],
      },
      delegate: { id: "u-charles" },
      assignee: { id: "u-charles" },
      state: { id: "s-code-review", name: "In Review" },
    },
  },
};

// ══════════════════════════════════════════════════════════════════════════
// AC4: Gate-decline response includes post-transition verification data
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1857 AC4: gate-decline response enables post-transition verification", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-gate-decline-"));
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
    globalThis.fetch = async (url) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(JSON.stringify(TICKET_IN_CODE_REVIEW), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, { method: "GET" });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  it("gate rejection response includes a _gateVerification field with the ticket's post-transition state snapshot", async () => {
    // Hanzo tries to deploy from code-review (wrong state, not deployment).
    // The gate correctly declines. The response MUST include enough data
    // for the CLI to verify "no partial state was written" — i.e., the
    // current label + delegate state at the time of rejection.
    const deployMutation = {
      query: `mutation Deploy($id: String!) {
        issueUpdate(id: $id, input: { stateId: "s-done" }) {
          success
          issue { id }
        }
      }`,
      variables: { id: "issue-uuid" },
      operationName: "Deploy",
    };

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("x-openclaw-agent", "charles")
      .set("x-openclaw-linear-intent", "deploy")
      .set("x-openclaw-linear-target", "AI-GATE")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("Content-Type", "application/json")
      .send(deployMutation);

    // The request should be rejected (deploy not legal from code-review)
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    // AC4: the rejection response should include a structured field
    // that allows the CLI to verify no partial state was written.
    // Currently fails: the response only has an errors[] array.
    expect(body).toHaveProperty("_gateVerification");
    const verification = body._gateVerification as Record<string, unknown>;
    expect(verification).toHaveProperty("labels");
    expect(verification).toHaveProperty("delegateId");
    expect(verification).toHaveProperty("stateLabel");
  });
});
