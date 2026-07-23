import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { resetWorkflowCache, loadWorkflowRegistry } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { reloadAgents } from "../agents.js";
import { resetConfigHealth } from "../config-health.js";
import { createApp } from "../index.js";
import { recordAppliedState, _resetAppliedStateStore } from "../store/applied-state-store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
roles:
  - id: steward
    requires: [linear:transition]
bodies:
  - id: astrid
    container: dev
    fills_roles: [steward]
  - id: ai
    container: dev
    fills_roles: [steward]
`;

const SPRINT_SPAWNER_YAML = `
id: sprint-spawner
states:
  - id: launching
    owner_role: steward
    native_state: doing
    transitions:
      - command: complete
        to: managing
  - id: spawning-scope
    owner_role: steward
    native_state: thinking
    fanout:
      spec_source: findings
      child_workflow: wf:sprint
    transitions:
      - command: spawn
        to: managing
  - id: managing
    owner_role: steward
    native_state: doing
    barrier: true
    transitions:
      - command: complete
        to: releasing
  - id: releasing
    owner_role: steward
    native_state: doing
    transitions: []
`;

const SPRINT_YAML = `
id: sprint
states:
  - id: intake
    native_state: todo
    transitions: []
`;

describe("INF-424 Spawner Transition Race", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-424-repro-"));
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    fs.writeFileSync(process.env.AGENTS_FILE, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
      ],
    }), "utf8");

    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");

    const defsDir = path.join(dir, "workflows");
    fs.mkdirSync(defsDir);
    fs.writeFileSync(path.join(defsDir, "sprint-spawner.yaml"), SPRINT_SPAWNER_YAML, "utf8");
    fs.writeFileSync(path.join(defsDir, "sprint.yaml"), SPRINT_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = defsDir;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    _resetAppliedStateStore();
    
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

  /**
   * AC1: Race Mutex — Transition atomicity guard.
   * Prove that two concurrent transitions for the same ticket are serialized.
   */
  it("AC1: Race Mutex — serializes concurrent transitions for the same ticket", async () => {
    const issueId = "INF-196";
    const parentInternalId = "uuid-196";
    
    globalThis.fetch = jest.fn().mockImplementation(async (url, init: any) => {
      const q = init?.body ? JSON.parse(init.body).query : "";

      if (q.includes("query IssueContext") || q.includes("query VerifyTransitionWrite") || q.includes("query IssueLabels")) {
        // AI-1548: synchronous lock acquisition.
        // req1 starts, acquires lock, then reaches this mock and yields for 50ms.
        // req2 starts while req1 is still in handleProxyRequest (waiting here), 
        // finds the lock held, and returns 200 with an error.
        await new Promise(resolve => setTimeout(resolve, 100));
        return new Response(JSON.stringify({
          data: { issue: { id: parentInternalId, identifier: issueId, labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:launching" }] }, delegate: { id: "u-astrid" } } }
        }));
      }
      if (q.includes("query IssueWithLabels")) {
        return new Response(JSON.stringify({
          data: { issue: { id: parentInternalId, identifier: issueId, team: { id: "t1" }, labels: { nodes: [{ id: "wf-l", name: "wf:sprint-spawner" }, { id: "st-l", name: "state:launching" }] } } }
        }));
      }
      if (q.includes("query TeamStateLabels")) {
        return new Response(JSON.stringify({
          data: { issue: { team: { labels: { nodes: [{ id: "st-l", name: "state:launching" }, { id: "st-m", name: "state:managing" }] } } } }
        }));
      }
      if (q.includes("query TeamLabels")) {
        return new Response(JSON.stringify({
          data: { team: { labels: { nodes: [{ id: "st-m", name: "state:managing" }] } } }
        }));
      }
      if (q.includes("query TeamStates")) {
        return new Response(JSON.stringify({
          data: { team: { states: { nodes: [{ id: "s1", name: "Doing", type: "started" }] } } }
        }));
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "uuid" } } } }));
    }) as any;

    const req1 = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "complete")
      .set("X-Openclaw-Linear-Target", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
      .send({ 
        query: "mutation ApplyAtomicTransition($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "INF-196", input: {} }
      });

    // Wait 20ms to ensure req1 has started and acquired the lock
    await new Promise(resolve => setTimeout(resolve, 20));

    const req2 = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "complete")
      .set("X-Openclaw-Linear-Target", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
      .send({ 
        query: "mutation ApplyAtomicTransition($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "INF-196", input: {} }
      });

    const [res1, res2] = await Promise.all([req1, req2]);

    const errors1 = JSON.stringify(res1.body.errors ?? []);
    const errors2 = JSON.stringify(res2.body.errors ?? []);
    const hasConflict = errors1.includes("concurrent") || errors2.includes("concurrent") || 
                        errors1.includes("TICKET_LOCKED") || errors2.includes("TICKET_LOCKED") ||
                        errors1.includes("in-flight") || errors2.includes("in-flight") ||
                        errors1.includes("blocked") || errors2.includes("blocked");
    expect(hasConflict).toBe(true);
  });

  /**
   * AC2: Atomic Fanout — Fanout child creation bound to state transition.
   * Prove that fanout happens even if the label write verification is laggy.
   */
  it("AC2: Atomic Fanout — mints children even if verification is laggy", async () => {
    const issueId = "INF-196";
    const parentInternalId = "uuid-196";
    let childrenMinted = false;
    let parentStateAdvanced = false;
    let updateAttempts = 0;

    globalThis.fetch = jest.fn().mockImplementation(async (url, init: any) => {
      const q = init?.body ? JSON.parse(init.body).query : "";
      
      if (q.includes("query IssueContext") || q.includes("query IssueParent") || q.includes("query VerifyTransitionWrite") || q.includes("query IssueLabels")) {
        // Simulate lag: return old labels for the first 2 verification reads
        if (q.includes("VerifyTransitionWrite") && updateAttempts > 0 && updateAttempts < 3) {
          return new Response(JSON.stringify({
            data: { issue: { id: parentInternalId, identifier: issueId, labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:spawning-scope" }] }, delegate: { id: "u-astrid" }, state: { id: "s1" } } }
          }));
        }
        return new Response(JSON.stringify({
          data: { issue: { id: parentInternalId, identifier: issueId, labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:spawning-scope" }] }, delegate: { id: "u-astrid" }, state: { id: "s1" } } }
        }));
      }
      if (q.includes("query IssueTeamParent")) {
        return new Response(JSON.stringify({
          data: { issue: { id: parentInternalId, title: "Parent", description: "## findings\n- **Cycle 5**: brief", team: { id: "t1" }, labels: { nodes: [{ name: "wf:sprint-spawner" }] } } }
        }));
      }
      if (q.includes("query ParentChildren") || q.includes("query FanoutChildren")) {
        return new Response(JSON.stringify({
          data: { issue: { children: { nodes: [] } } }
        }));
      }
      if (q.includes("query IssueWithLabels") || q.includes("query ParentState")) {
        return new Response(JSON.stringify({
          data: { issue: { id: parentInternalId, identifier: issueId, team: { id: "t1" }, labels: { nodes: [{ id: "wf-l", name: "wf:sprint-spawner" }, { id: "st-s", name: "state:spawning-scope" }] } } }
        }));
      }
      if (q.includes("query TeamLabels")) {
        return new Response(JSON.stringify({
          data: { team: { labels: { nodes: [{ id: "wf-l", name: "wf:sprint-spawner" }, { id: "wf-s", name: "wf:sprint" }, { id: "st-i", name: "state:intake" }, { id: "st-m", name: "state:managing" }] } } }
        }));
      }
      if (q.includes("query TeamStateLabels")) {
        return new Response(JSON.stringify({
          data: { issue: { team: { labels: { nodes: [{ id: "st-s", name: "state:spawning-scope" }, { id: "st-m", name: "state:managing" }] } } } }
        }));
      }
      if (q.includes("query TeamStates")) {
        return new Response(JSON.stringify({
          data: { team: { states: { nodes: [{ id: "s1", name: "Doing", type: "started" }] } } }
        }));
      }
      if (q.includes("mutation CreateChild")) {
        childrenMinted = true;
        return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "child-uuid", identifier: "INF-408" } } } }));
      }
      if (q.includes("mutation ApplyAtomicTransition") || q.includes("issueUpdate")) {
        updateAttempts++;
        parentStateAdvanced = true;
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }) as any;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "spawn")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
      .set("X-Openclaw-Linear-Target", "astrid")
      .send({ 
        query: "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "INF-196", input: {} }
      });

    expect(res.status).toBe(200);
    expect(parentStateAdvanced).toBe(true);
    expect(childrenMinted).toBe(true);
  });

  /**
   * AC3: Recovery — Self-correction for desynced labels.
   */
  it("AC3: Recovery — reconciles desynced labels", async () => {
    const issueId = "INF-196";
    recordAppliedState(issueId, "managing");

    globalThis.fetch = jest.fn().mockImplementation(async (url, init: any) => {
      const q = init?.body ? JSON.parse(init.body).query : "";
      if (q.includes("query IssueContext")) {
        return new Response(JSON.stringify({
          data: { issue: { identifier: issueId, labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:launching" }] }, delegate: { id: "u-astrid" } } }
        }));
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }) as any;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "complete")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
      .set("X-Openclaw-Linear-Target", "astrid")
      .send({ query: "mutation ApplyAtomicTransition { issueUpdate(id: \"INF-196\", input: {}) { success } }" });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  /**
   * AC4: Bootstrap Wiring (AI-1808).
   */
  it("AC4: Bootstrap Wiring — production entry point boots the component", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    const crons = res.body.crons ?? [];
    const cronNames = crons.map((c: any) => c.name);
    expect(cronNames).toContain("dispatch-delivery-scheduler");
    
    const gates = res.body.dispatchIntegrity ?? {};
    expect(gates.deliveryTimeRecipientResolution?.active).toBe(true);
    expect(gates.phantomFetchabilityGate?.active).toBe(true);
    expect(gates.wakeSessionDedup?.active).toBe(true);
  });
});
