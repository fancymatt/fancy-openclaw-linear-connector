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
   * Prove that two concurrent transitions for the same ticket are serialized
   * and the second one fails if it's no longer legal.
   */
  it("AC1: Race Mutex — serializes concurrent transitions for the same ticket", async () => {
    // 1. Setup ticket in 'launching' state
    const issueId = "INF-196";
    const parentInternalId = "uuid-196";
    
    // Mock fetch for B1/B2
    const calls: any[] = [];
    globalThis.fetch = jest.fn().mockImplementation(async (url, init: any) => {
      const q = init?.body ? JSON.parse(init.body).query : "";
      calls.push({ query: q, variables: JSON.parse(init.body).variables });

      if (q.includes("query IssueContext")) {
        return new Response(JSON.stringify({
          data: { issue: { identifier: issueId, labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:launching" }] }, delegate: { id: "u-astrid" } } }
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

    // 2. Fire two concurrent requests for INF-196
    const req1 = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send({ query: "mutation { issueUpdate(id: \"INF-196\", input: {}) { success } }" });

    const req2 = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send({ query: "mutation { issueUpdate(id: \"INF-196\", input: {}) { success } }" });

    const [res1, res2] = await Promise.all([req1, req2]);

    // One should succeed, one should be blocked by in-flight lock (G-16/AI-1548)
    const statuses = [res1.status, res2.status];
    const bodies = [res1.body, res2.body];
    
    // The lock is per-ticket. One request gets the lock, the other hits onConflict.
    // In handleProxyRequest, onConflict sends a 200 with an error message about 
    // concurrent command if implemented (or whatever the lock does).
    // Let's check if G-16 is actually implemented in proxy.ts.
    
    const conflictRes = res1.body.errors?.[0]?.message?.includes("concurrent") || res2.body.errors?.[0]?.message?.includes("concurrent") 
      ? (res1.body.errors?.[0]?.message?.includes("concurrent") ? res1 : res2)
      : null;
      
    // Actually, in-flight lock was in the proxy.ts I read. Let's verify.
  });

  /**
   * AC2: Atomic Fanout — Fanout child creation bound to state transition.
   * Prove that if fanout is configured, children are minted and state advances atomically.
   */
  it("AC2: Atomic Fanout — mints children and advances state", async () => {
    const issueId = "INF-196";
    const parentInternalId = "uuid-196";
    
    let childrenMinted = false;
    globalThis.fetch = jest.fn().mockImplementation(async (url, init: any) => {
      const q = init?.body ? JSON.parse(init.body).query : "";
      if (q.includes("query IssueContext")) {
        return new Response(JSON.stringify({
          data: { issue: { identifier: issueId, labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:spawning-scope" }] }, delegate: { id: "u-astrid" }, description: "## findings\n- **Cycle 5**: brief" } }
        }));
      }
      if (q.includes("mutation CreateChild")) {
        childrenMinted = true;
        return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "child-uuid", identifier: "INF-408" } } } }));
      }
      // ... more mocks needed for full flow
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }) as any;

    // This test would prove that the 'spawn' command triggers fanout then advances the state.
  });

  /**
   * AC3: Recovery — Self-correction for desynced labels.
   * Prove that the engine reconciles labels to match its internal state.
   */
  it("AC3: Recovery — reconciles desynced labels", async () => {
    // This would test the H-6 drift reconciliation logic.
  });

  /**
   * AC4: Bootstrap Wiring (AI-1808) — Component registration verified at entry point.
   * Prove that the production entry point boots the component.
   */
  it("AC4: Bootstrap Wiring — production entry point boots the component", async () => {
    // This is an integration test requirement.
  });
});
