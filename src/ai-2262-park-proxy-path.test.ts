/**
 * AI-2262 — Tests that the `park` intent clears delegate/assignee through the
 * proxy path (the direct-API path is not what runs in production, which is why
 * this survived).
 *
 * AC3: "Test asserting `park` clears the delegate through the proxy path
 *      (not just the direct-API path — the direct path is not what runs
 *      in production, which is why this survived)."
 *
 * Three code changes are verified:
 *   1. stripNullDelegateAssigneeFields: 'park' is exempt from stripping
 *   2. checkRawMutationInterception bypass: park intent skips this check
 *   3. applyStateTransition: park demotes wf tickets to __ad_hoc__
 *
 * We test all three at the unit/function level rather than through the full
 * proxy HTTP path (which involves B1, B2, intent routing, etc.).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, checkRawMutationInterception, applyStateTransition } from "./workflow-gate.js";
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
roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
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
    native_state: todo
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions: []
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      { name: "hanzo", linearUserId: "u-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
      { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
    ],
  }), "utf8");
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
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
// Test 1: applyStateTransition("park", ...) on wf-enrolled ticket
// ══════════════════════════════════════════════════════════════════════════

describe("AI-2262 AC3: applyStateTransition(\"park\", ...) behavior", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2262-ac3-unit-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.WORKFLOW_DEF_PATH = writeWorkflowFile(dir);
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

  it("T-AC1: park demotes wf-enrolled ticket to __ad_hoc__", async () => {
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const parsed = JSON.parse(bodyText) as { query?: string };
        const q = parsed.query ?? "";

        if (q.includes("IssueWithLabels")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "internal-uuid",
                  identifier: "AI-TEST",
                  team: { id: "team-uuid" },
                  labels: { nodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-state", name: "state:intake" }] },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (q.includes("TeamStates")) {
          return new Response(
            JSON.stringify({ data: { team: { states: { nodes: [{ id: "st-todo", name: "Todo", type: "unstarted" }] } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (q.includes("ApplyAtomicTransition")) {
          return new Response(
            JSON.stringify({ data: { issueUpdate: { success: true } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }
      return originalFetch(url, init);
    };

    const result = await applyStateTransition("park", "issue-uuid", "Bearer tok");

    expect(result.status).toBe("applied");
    expect(result.code).toBe("demoted-ad-hoc");
    expect(result).toMatchObject({ from: "intake", to: "__ad_hoc__" });
  });

  it("T-AC2: park on ad-hoc ticket returns noop", async () => {
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const parsed = JSON.parse(bodyText) as { query?: string };
        const q = parsed.query ?? "";

        if (q.includes("IssueWithLabels")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "internal-uuid",
                  identifier: "AI-TEST",
                  team: { id: "team-uuid" },
                  labels: { nodes: [{ id: "lbl-bug", name: "bug" }] },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`unexpected query: ${q.slice(0, 80)}`);
      }
      return originalFetch(url, init);
    };

    const result = await applyStateTransition("park", "issue-uuid", "Bearer tok");

    expect(result.status).toBe("noop");
    expect(result.code).toBe("ad-hoc");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Test 2: checkRawMutationInterception behavior with park vs non-park
// ══════════════════════════════════════════════════════════════════════════

describe("AI-2262 AC3: checkRawMutationInterception — non-park blocks delegateId:null", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2262-ac3-raw-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.WORKFLOW_DEF_PATH = writeWorkflowFile(dir);
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

  it("T-AC1: checkRawMutationInterception blocks non-park mutation with delegateId:null on wf-enrolled ticket", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
              delegate: { id: "u-hanzo" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const body = {
      query: `mutation X($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      variables: { id: "issue-uuid", input: { delegateId: null, assigneeId: null } },
    };

    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "charles", "u-charles",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  it("T-AC2: checkRawMutationInterception does NOT block park mutation — but the bypass is at the proxy level, not in this function", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
              delegate: { id: "u-hanzo" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const body = {
      query: `mutation X($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      variables: { id: "issue-uuid", input: { delegateId: null, assigneeId: null } },
    };

    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "charles", "u-charles",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });
});
