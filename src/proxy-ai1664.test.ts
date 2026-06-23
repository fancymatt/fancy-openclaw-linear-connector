/**
 * AI-1664: Proxy integration — handleProxyRequest should notify the no-activity
 * detector when a proxy call carries a ticket identifier.
 *
 * AC coverage:
 *   AC1: Proxy request with a resolvable ticket identifier satisfies the detector's timer.
 *   AC3: Proxy request with no issue ID does not satisfy the timer.
 *   AC3: Proxy request with a UUID `id` and X-Openclaw-Linear-Target header satisfies the timer
 *        (covers mutation-type calls where the body carries a UUID, not the Linear identifier).
 *   AC2: The existing proxy enforcement paths (phase 2, phase 3) are not affected.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: emi
    container: dev
    fills_roles: []
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "emi",
          linearUserId: "u-emi",
          openclawAgent: "emi",
          accessToken: "tok-emi",
          host: "local",
        },
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

const MOCK_RESPONSE = { data: { issue: { id: "e6ef9813-4baa-4cbf-bbe6-f5d9164d4916", identifier: "AI-1664" } } };

describe("proxy /proxy/graphql — no-activity evidence (AI-1664)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai1664-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.WORKFLOW_DEF_PATH = ""; // no workflow def needed for these tests
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
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.ackTracker.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1: proxy call with identifier variable satisfies the no-activity timer for the dispatched agent", async () => {
    // Set up dispatch: emi was dispatched to work on AI-1664
    appState.sessionTracker.startSession("emi", "linear-AI-1664");
    appState.ackTracker.recordDispatch("emi", "linear-AI-1664");

    // Emi makes a proxy call — getIssue query with the Linear identifier in variables
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-emi")
      .set("X-Openclaw-Agent", "emi")
      .send({
        query: "query GetIssue($identifier: String!) { issue(identifier: $identifier) { id identifier } }",
        variables: { identifier: "AI-1664" },
        operationName: "GetIssue",
      });

    // The no-activity timer for emi/AI-1664 should now be satisfied.
    // Verify by running a cycle with failMs=0 (would fail immediately without evidence).
    const result = await appState.noActivityDetector.runCycle();
    expect(result.failed).toBe(0);

    // Confirm the ackTracker no longer has it as pending
    const pending = appState.ackTracker.getPendingTimedOut(0);
    const stillPending = pending.filter(
      (e) => e.agentId === "emi" && e.ticketId === "linear-AI-1664",
    );
    expect(stillPending).toHaveLength(0);
  });

  test("AC3: proxy call without any issue ID does NOT satisfy the no-activity timer", async () => {
    // Set up dispatch
    appState.sessionTracker.startSession("emi", "linear-AI-1664");
    appState.ackTracker.recordDispatch("emi", "linear-AI-1664");

    // List/introspection query — no ticket identifier in body
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-emi")
      .set("X-Openclaw-Agent", "emi")
      .send({
        query: "{ viewer { id name } }",
        operationName: "ViewerQuery",
      });

    // The timer should still be pending — this is a non-ticket proxy call
    const pending = appState.ackTracker.getPendingTimedOut(0);
    const stillPending = pending.filter(
      (e) => e.agentId === "emi" && e.ticketId === "linear-AI-1664",
    );
    expect(stillPending).toHaveLength(1);
  });

  test("AC3: proxy call with a UUID id and X-Openclaw-Linear-Target header satisfies the timer (mutation path)", async () => {
    // Covers mutation-type calls: the body carries a UUID (`id` variable),
    // but the X-Openclaw-Linear-Target header provides the Linear identifier.
    appState.sessionTracker.startSession("emi", "linear-AI-1664");
    appState.ackTracker.recordDispatch("emi", "linear-AI-1664");

    // issueUpdate mutation — UUID in body, identifier in Target header
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-emi")
      .set("X-Openclaw-Agent", "emi")
      .set("X-Openclaw-Linear-Target", "AI-1664")
      .send({
        query: "query GetIssue($id: String!) { issue(id: $id) { id } }",
        variables: { id: "e6ef9813-4baa-4cbf-bbe6-f5d9164d4916" },
        operationName: "GetIssue",
      });

    // Timer should be satisfied via the Target header
    const pending = appState.ackTracker.getPendingTimedOut(0);
    const stillPending = pending.filter(
      (e) => e.agentId === "emi" && e.ticketId === "linear-AI-1664",
    );
    expect(stillPending).toHaveLength(0);
  });

  test("AC3: proxy call with ONLY a UUID id (no Target header) does NOT satisfy the timer", async () => {
    // When neither the body identifier nor the Target header provides a Linear identifier,
    // the call cannot be matched to a dispatch and must not affect the timer.
    appState.sessionTracker.startSession("emi", "linear-AI-1664");
    appState.ackTracker.recordDispatch("emi", "linear-AI-1664");

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-emi")
      .set("X-Openclaw-Agent", "emi")
      .send({
        query: "query GetIssue($id: String!) { issue(id: $id) { id } }",
        variables: { id: "e6ef9813-4baa-4cbf-bbe6-f5d9164d4916" },
        operationName: "GetIssue",
      });

    const pending = appState.ackTracker.getPendingTimedOut(0);
    const stillPending = pending.filter(
      (e) => e.agentId === "emi" && e.ticketId === "linear-AI-1664",
    );
    expect(stillPending).toHaveLength(1);
  });

  test("AC2: existing proxy pass-through still works after this change (regression guard)", async () => {
    // A plain query proxy call should still forward to Linear and return the response.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-emi")
      .set("X-Openclaw-Agent", "emi")
      .send({
        query: "{ viewer { id } }",
        operationName: "ViewerQuery",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_RESPONSE);
  });
});
