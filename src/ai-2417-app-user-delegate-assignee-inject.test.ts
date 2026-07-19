/**
 * AI-2417 — App-user delegate writes must carry assigneeId:null so the delegate
 * persists (regression of AI-1395).
 *
 * Root cause (observed on GEN-178, an ad-hoc / non-governed ticket):
 *   The Linear API silently drops a delegateId write to an app/bot user unless
 *   assigneeId is carried in the SAME mutation (AI-1395; valid persistent shape is
 *   { delegateId: app_user, assigneeId: null }). Two converging paths reproduce it:
 *     1. `refuse-work` OMITS assigneeId (the AI-1395 CLI guard leaves it unset for
 *        app-user targets) → Linear reverts the delegate to the caller.
 *     2. `stripNullDelegateAssigneeFields` (AI-1857) removes an explicit
 *        assigneeId:null from generic delegate-routing verbs, re-creating (1).
 *
 * Fix: after the AI-1857 strip and BEFORE the AI-1977 delegate-pre-resolve, when
 * the CLI set a non-null delegateId and did not pin a specific assignee, inject
 * assigneeId:null into the forwarded mutation. Only fires for the generic direct
 * delegate-write path; governed dev-impl verbs omit the CLI delegateId (the proxy
 * owns their delegate) and are untouched. A delegate CLEAR (delegateId:null) is
 * excluded, so the AI-1857 self-clear guard is unaffected.
 *
 * These tests MUST be RED before the proxy.ts injection lands.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: main
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: test-author
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]

bodies:
  - id: ai
    container: main
    fills_roles: [steward]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
        // tdd is an app-user functionary (the sole test-author).
        { name: "tdd", linearUserId: "u-tdd", openclawAgent: "tdd", accessToken: "tok-tdd", host: "local", app: true },
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

describe("AI-2417: generic delegate-routing verbs inject assigneeId:null for app-user delegate persistence", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  /** Captured issueUpdate mutations forwarded to the Linear API. */
  let forwardedBodies: Array<{ variables?: { input?: Record<string, unknown> } }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2417-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    // Ensure WORKFLOW_DEFS_DIR points to an empty dir so config health
    // stays healthy (no policy YAML mixed in with workflow defs).
    process.env.WORKFLOW_DEFS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2417-defs-"));
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
        const query = parsed.query ?? "";

        if (query.includes("issueUpdate") && !query.includes("IssueContext")) {
          forwardedBodies.push(parsed as { variables?: { input?: Record<string, unknown> } });
        }

        // Context reads: ad-hoc ticket (no wf:* label), currently delegated to the
        // caller (ai) with no assignee — exactly the GEN-178 shape.
        if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  identifier: "GEN-178",
                  // INF-35: include wf:* label so refuse-work on a governed
                  // ticket reaches the delegate injection logic.
                  labels: { nodes: [{ name: "wf:dev-impl" }, { name: "bug" }] },
                  delegate: { id: "u-ai" },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // INF-27/INF-35: proxy now fetches issue labels via fetchIssueWithLabels
        // (IssueWithLabels query) before processing mutations, to check if the
        // ticket is workflow-armed.
        if (query.includes("IssueWithLabels")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "issue-uuid",
                  identifier: "GEN-178",
                  team: { id: "team-uuid" },
                  // INF-35: wf:* label so ticket is workflow-governed.
                  labels: { nodes: [{ id: "lbl-wf-dev-impl", name: "wf:dev-impl" }, { id: "lbl-bug", name: "bug" }] },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid", identifier: "GEN-178" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init as never);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    delete process.env.WORKFLOW_DEFS_DIR;
  });

  it("generic handoff-work: an omitted assigneeId is filled with null when a non-null delegate is set", async () => {
    // Generic handoff to an app-user may leave assigneeId unset (AI-1395 CLI
    // guard). The forwarded mutation must carry assigneeId:null so Linear
    // persists the delegate. `refuse-work` used to cover this path, but INF-35
    // made it workflow-only; ad-hoc delegate routing should use handoff-work.
    const mutation = {
      query: `mutation HandoffWork($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: {
        id: "issue-uuid",
        input: { stateId: "state-todo", delegateId: "u-tdd" },
      },
      operationName: "HandoffWork",
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("x-openclaw-agent", "ai")
      .set("x-openclaw-linear-intent", "handoff-work")
      .set("x-openclaw-linear-target", "GEN-178")
      .set("Content-Type", "application/json")
      .send(mutation);

    const fwd = forwardedBodies.find((b) => b.variables?.input?.delegateId === "u-tdd");
    expect(fwd).toBeDefined();
    expect(fwd?.variables?.input).toHaveProperty("assigneeId", null);
    expect(fwd?.variables?.input?.delegateId).toBe("u-tdd");
  });

  it("generic handoff-work: assigneeId:null survives to Linear alongside the delegate (not stripped away)", async () => {
    // The CLI sends assigneeId:null; AI-1857 strip removes it; the AI-2417 inject
    // must restore it so the app-user delegate persists.
    const mutation = {
      query: `mutation HandoffWork($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: {
        id: "issue-uuid",
        input: { stateId: "state-todo", delegateId: "u-tdd", assigneeId: null },
      },
      operationName: "HandoffWork",
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("x-openclaw-agent", "ai")
      .set("x-openclaw-linear-intent", "handoff-work")
      .set("x-openclaw-linear-target", "GEN-178")
      .set("Content-Type", "application/json")
      .send(mutation);

    const fwd = forwardedBodies.find((b) => b.variables?.input?.delegateId === "u-tdd");
    expect(fwd).toBeDefined();
    expect(fwd?.variables?.input).toHaveProperty("assigneeId", null);
  });

  it("delegate CLEAR (delegateId:null) does NOT get an injected assigneeId — AI-1857 self-clear guard preserved", async () => {
    // A null delegate write is a self-clear, not a set. The injection must not fire,
    // and stripNullDelegateAssigneeFields must still remove the null delegate.
    const mutation = {
      query: `mutation Undelegate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: {
        id: "issue-uuid",
        input: { delegateId: null },
      },
      operationName: "Undelegate",
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("x-openclaw-agent", "ai")
      .set("x-openclaw-linear-intent", "note")
      .set("x-openclaw-linear-target", "GEN-178")
      .set("Content-Type", "application/json")
      .send(mutation);

    const fwd = forwardedBodies.find((b) => b.variables?.input !== undefined);
    if (fwd?.variables?.input) {
      expect(fwd.variables.input).not.toHaveProperty("assigneeId");
    }
  });
});
