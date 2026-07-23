/**
 * INF-337 AC3: app-user delegation must not silently degrade into an async Ai
 * revert/no-op. If a caller reaches the proxy with the known-bad stripped shape,
 * the proxy must reject synchronously with an explicit reason instead of
 * forwarding a mutation that cannot set the requested app-user delegate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: main
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition]
roles:
  - id: steward
    requires: [linear:transition]
  - id: deployment
    requires: [linear:transition]
bodies:
  - id: ai
    container: main
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "ai", linearUserId: "user-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local", app: true },
        { name: "hanzo", linearUserId: "user-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local", app: true },
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

describe("INF-337 AC3: proxy rejects stripped app-user handoff-work shapes", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let forwardedIssueUpdates: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-337-proxy-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    forwardedIssueUpdates = [];

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const parsed = JSON.parse(bodyText) as { query?: string; variables?: { input?: Record<string, unknown> } };
        const query = parsed.query ?? "";

        if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "issue-adhoc",
                  identifier: "INF-337",
                  labels: { nodes: [{ name: "bug" }] },
                  delegate: { id: "user-ai" },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (query.includes("issueUpdate")) {
          forwardedIssueUpdates.push(parsed.variables?.input ?? {});
        }

        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "issue-adhoc", identifier: "INF-337" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init as never);
    }) as typeof globalThis.fetch;
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
  });

  it("AC3: app-user handoff-work with assigneeId:null but no delegateId is rejected before forwarding", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("x-openclaw-agent", "ai")
      .set("x-openclaw-linear-intent", "handoff-work")
      .set("x-openclaw-linear-target", "INF-337")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation HandoffWork($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-adhoc",
          // This is the AI-FALLBACK class: the target is Hanzo, but the CLI/proxy
          // boundary mutation has stripped delegateId while leaving only the clear.
          input: { stateId: "state-todo", assigneeId: null },
        },
        operationName: "HandoffWork",
      });

    expect(forwardedIssueUpdates).toHaveLength(0);
    expect(res.status).toBe(200);
    expect(res.body.errors?.[0]?.message).toMatch(/handoff-work|app.user|delegateId|stripped/i);
  });
});
