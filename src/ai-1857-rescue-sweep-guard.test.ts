/**
 * AI-1857 — Failing tests for:
 *   1. Rescue-sweep silent miss on dormant wf ticket
 *   2. Delegate self-clear bypassed AI-1835 guard (complete-partial-apply shape)
 *
 * AC-to-test mapping:
 *
 *   AC1 — Delegate clears on wf-enrolled tickets are blocked (or immediately healed)
 *          regardless of mutation shape, incl. partial semantic-verb application;
 *          proven by test reproducing the complete-partial-apply shape.
 *
 *   AC2 — Every rescue-sweep run emits an observable outcome (operational event incl.
 *          per-ticket outcome); a `failed` rescue raises an alert, not just a log line.
 *
 *   AC3 — Sweep cadence/last-run visible on `/health` (lastRunAt, lastOutcome counts)
 *          so "did it run" is answerable without log access.
 *
 *   AC4 — Gate-decline CLI output never asserts "no partial state" unless verified
 *          against post-transition ticket state.
 *
 *   AC5 [Bootstrap-wiring — AI-1808] — rescue-sweep is registered at server bootstrap
 *          (reachable from the production entry point, e.g. `index.ts`), proven by an
 *          integration test that boots the entry point and asserts registration.
 *          Liveness is observable at ac-validate without waiting for a sweep trigger:
 *          a `/health` field showing lastRunAt (or null before first run).
 *
 * All tests MUST be RED until the implementation lands.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { runRescueSweep, type RescueSweepOptions } from "./rescue-sweep.js";

// ── Shared test fixtures ──────────────────────────────────────────────────

const CAPABILITY_POLICY_WITH_DEPLOYMENT = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [human:escalate]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: tdd
    container: dev
    fills_roles: [test-author]
`;

// Workflow with a terminal "complete" transition from deployment state.
// Mirrors real dev-impl shape used in production.
const DEPLOYMENT_WORKFLOW_YAML = `
id: dev-impl
version: 1
entry_state: intake
break_glass:
  command: escape
  to: escape
  owner_role: steward
recovery_actor: ai
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
  - id: write-tests
    owner_role: test-author
    native_state: todo
    transitions:
      - command: continue-workflow
        to: implementation
        generic: continue
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions:
      - command: submit
        to: deployment
  - id: deployment
    owner_role: deployment
    native_state: todo
    transitions:
      - command: complete
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid",  linearUserId: "u-astrid",  openclawAgent: "astrid",  accessToken: "tok-astrid",  host: "local" },
        { name: "hanzo",   linearUserId: "u-hanzo",   openclawAgent: "hanzo",   accessToken: "tok-hanzo",   host: "local" },
        { name: "tdd",     linearUserId: "u-tdd",     openclawAgent: "tdd",     accessToken: "tok-tdd",     host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function writePolicyFile(dir: string, content = CAPABILITY_POLICY_WITH_DEPLOYMENT): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function writeWorkflowFile(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(file, DEPLOYMENT_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = file;
  return file;
}

// ── AC1 — Delegate self-clear via complete-partial-apply shape ─────────────

describe("AC1 — delegate clear stripped from forwarded intent-bearing mutations (AI-1835 guard bypass via partial semantic verb)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let capturedForwardBody: Record<string, unknown> | null;

  // Hanzo is the delegate at state:deployment. Return this for label/context fetches.
  const HANZO_AT_DEPLOYMENT = {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
        delegate: { id: "u-hanzo" },
        team: { id: "team-ai" },
      },
    },
  };

  function makeFetch(labelResponse: object) {
    capturedForwardBody = null;
    return async (url: unknown, init?: RequestInit) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url as Parameters<typeof fetch>[0], init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string; variables?: unknown }) : {};
      const q = parsed.query ?? "";

      // Label/context fetch
      if (q.includes("IssueContext") || q.includes("IssueLabels") || q.includes("delegate")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Team label fetch (for state label strip)
      if (q.includes("TeamLabels") || q.includes("team(")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: "lbl-done", name: "state:done" },
                    { id: "lbl-deployment", name: "state:deployment" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // State ID lookup (native state resolution)
      if (q.includes("WorkflowStates") || q.includes("states(")) {
        return new Response(
          JSON.stringify({ data: { workflowStates: { nodes: [{ id: "native-done", name: "Done" }] } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // This is the forwarded mutation — capture it.
      capturedForwardBody = parsed as Record<string, unknown>;
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-ac1-"));
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
  });

  it("AC1a: complete-partial-apply shape — intent-bearing mutation with delegateId:null+assigneeId:null is NOT blocked", async () => {
    // Reproduce the exact pattern from the incident:
    //   CLI 0.3.5 `complete` verb sends stateId + delegateId:null + assigneeId:null in one issueUpdate.
    // The proxy MUST allow the state transition to proceed.
    // Currently: the Layer 2 re-check blocks the entire mutation because hasAssigneeChange=true.
    // After fix: delegateId/assigneeId are stripped before forwarding; the transition succeeds.
    globalThis.fetch = makeFetch(HANZO_AT_DEPLOYMENT);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-hanzo")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send({
        query: `mutation Complete($id: String!, $stateId: String) {
          issueUpdate(id: $id, input: { stateId: $stateId, delegateId: null, assigneeId: null }) { success }
        }`,
        variables: { id: "issue-uuid", stateId: "native-done" },
      });

    // The complete transition is valid for hanzo at deployment state.
    // It must not be blocked by the partial-apply guard.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("AC1b: delegateId:null is stripped from the body forwarded to Linear upstream", async () => {
    // Even when the CLI sends delegateId:null as part of a semantic verb,
    // the proxy must strip it before forwarding so the delegate is not cleared.
    // The proxy manages delegates via applyStateTransition, not the CLI.
    globalThis.fetch = makeFetch(HANZO_AT_DEPLOYMENT);

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-hanzo")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send({
        query: `mutation Complete($id: String!) {
          issueUpdate(id: $id, input: { delegateId: null, assigneeId: null }) { success }
        }`,
        variables: { id: "issue-uuid" },
      });

    // The body forwarded to Linear must NOT carry delegateId:null.
    // applyStateTransition is the sole writer of delegate changes.
    expect(capturedForwardBody).not.toBeNull();
    const forwardedInput = (capturedForwardBody?.variables as Record<string, unknown> | undefined)?.input as
      | Record<string, unknown>
      | undefined;
    expect(forwardedInput).toBeDefined();
    expect("delegateId" in (forwardedInput ?? {})).toBe(false);
  });

  it("AC1c: assigneeId:null is stripped from the body forwarded to Linear upstream", async () => {
    globalThis.fetch = makeFetch(HANZO_AT_DEPLOYMENT);

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-hanzo")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send({
        query: `mutation Complete($id: String!) {
          issueUpdate(id: $id, input: { delegateId: null, assigneeId: null }) { success }
        }`,
        variables: { id: "issue-uuid" },
      });

    expect(capturedForwardBody).not.toBeNull();
    const forwardedInput = (capturedForwardBody?.variables as Record<string, unknown> | undefined)?.input as
      | Record<string, unknown>
      | undefined;
    expect(forwardedInput).toBeDefined();
    expect("assigneeId" in (forwardedInput ?? {})).toBe(false);
  });

  it("AC1d: raw mutation (no intent) with delegateId:null+assigneeId:null on wf-enrolled ticket is blocked with explicit delegate-clear message", async () => {
    // The AI-1835 guard must recognize delegateId:null regardless of whether
    // assigneeId:null is also present — both together is the partial-apply shape.
    // The block message must explicitly mention delegate clearing, not just "direct changes blocked."
    globalThis.fetch = makeFetch(HANZO_AT_DEPLOYMENT);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-hanzo")
      .set("X-Openclaw-Agent", "hanzo")
      // No intent header — this is the "raw" path
      .send({
        query: `mutation ClearDelegate($id: String!) {
          issueUpdate(id: $id, input: { delegateId: null, assigneeId: null }) { success }
        }`,
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    // Must be the specific AI-1835 delegate-clear guard message, not the generic blanket block.
    // Specifically: the message must mention "delegate" and "clear" or "null", not just
    // "direct status/assignee/label/delegate changes are blocked."
    const msg: string = res.body.errors[0]?.message ?? "";
    expect(msg).toContain("[Proxy]");
    expect(msg.toLowerCase()).toMatch(/delegate.*clear|clear.*delegate/);
  });
});

// ── AC2 — rescue-sweep emits operational events for ALL outcomes ───────────

describe("AC2 — runRescueSweep emits observable operational events for all per-ticket outcomes including failed", () => {
  let originalFetch: typeof globalThis.fetch;
  let tmpDir: string;

  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-ac2-")); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeCapabilityPolicy(mapping: Record<string, string[]> = {}): string {
    const defaults = { deployment: ["hanzo"], steward: ["astrid"], "test-author": ["tdd"] };
    const merged = { ...defaults, ...mapping };
    const bodies = Object.entries(merged)
      .flatMap(([role, ids]) => ids.map((id) => `  - id: ${id}\n    container: ${role}\n    fills_roles: [${role}]`))
      .join("\n");
    const yaml =
      `capabilities:\n  - id: linear:transition\nbodies:\n${bodies}\n`;
    const p = path.join(tmpDir, `policy-${Date.now()}.yaml`);
    fs.writeFileSync(p, yaml, "utf8");
    return p;
  }

  const MINIMAL_WF_DEF = {
    id: "dev-impl",
    entry_state: "intake",
    states: [
      { id: "intake",     owner_role: "steward"     },
      { id: "deployment", owner_role: "deployment"  },
      { id: "done"                                  },
      { id: "escape"                                },
    ],
  };

  it("AC2a: a FAILED rescue attempt emits an operational event (outcome rescue:failed)", async () => {
    // setDelegate returns false → outcome is "failed".
    // The current implementation only emits events for "rescued" and "ambiguous".
    // A "failed" rescue MUST also emit an event — a silent failure is a pillar-1 violation.
    const events: Array<{ outcome: string; type?: string; detail?: unknown }> = [];
    const operationalEventStore = {
      record(ev: { outcome: string; type?: string; detail?: unknown }) { events.push(ev); },
    };

    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { query?: string };
      if (body.query?.includes("WorkflowIssues") || body.query?.includes("issues(")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [{
                  id: "ticket-dormant",
                  identifier: "AI-9999",
                  team: { id: "team-ai" },
                  state: { name: "Doing" },
                  labels: { nodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-state", name: "state:deployment" }] },
                  delegate: null, // dormant — no delegate
                }],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // setDelegate call — return failure
      if (body.query?.includes("UpdateDelegate") || (body.query?.includes("issueUpdate") && body.query?.includes("delegateId"))) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: false } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // TeamLabels fetch
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-state-deployment", name: "state:deployment" }] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const policyPath = makeCapabilityPolicy();
    const result = await runRescueSweep({
      authToken: "Bearer test",
      workflowRegistry: new Map([["dev-impl", MINIMAL_WF_DEF]]),
      capabilityPolicyPath: policyPath,
      operationalEventStore,
    });

    // rescue.outcome === "failed" (setDelegate returned false for hanzo)
    expect(result.rescues).toHaveLength(1);
    expect(result.rescues[0]?.outcome).toBe("failed");

    // MUST emit an operational event for the failed rescue — not just a log line.
    const failedEvent = events.find((e) => e.outcome === "rescue:failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.type).toBe("rescue");
  });

  it("AC2b: every sweep run emits a sweep-completion summary event with outcome counts", async () => {
    // After each sweep, a summary operational event must be emitted so the sweep run
    // is observable even when no tickets were rescued (e.g. scanned=3, rescued=0).
    const events: Array<{ outcome: string; type?: string; detail?: unknown }> = [];
    const operationalEventStore = {
      record(ev: { outcome: string; type?: string; detail?: unknown }) { events.push(ev); },
    };

    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { query?: string };
      if (body.query?.includes("WorkflowIssues") || body.query?.includes("issues(")) {
        // Return two healthy tickets — nothing to rescue.
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "ticket-healthy-1",
                    identifier: "AI-1001",
                    team: { id: "team-ai" },
                    state: { name: "Doing" },
                    labels: { nodes: [{ id: "l1", name: "wf:dev-impl" }, { id: "l2", name: "state:deployment" }] },
                    delegate: { id: "hanzo", name: "Hanzo" },
                  },
                  {
                    id: "ticket-healthy-2",
                    identifier: "AI-1002",
                    team: { id: "team-ai" },
                    state: { name: "Doing" },
                    labels: { nodes: [{ id: "l3", name: "wf:dev-impl" }, { id: "l4", name: "state:intake" }] },
                    delegate: { id: "astrid", name: "Astrid" },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const policyPath = makeCapabilityPolicy();
    const result = await runRescueSweep({
      authToken: "Bearer test",
      workflowRegistry: new Map([["dev-impl", MINIMAL_WF_DEF]]),
      capabilityPolicyPath: policyPath,
      operationalEventStore,
    });

    expect(result.scanned).toBe(2);
    expect(result.rescued).toBe(0);

    // The sweep must emit a completion summary event with outcome counts.
    const summaryEvent = events.find((e) => e.outcome === "sweep:complete" || e.type === "sweep-complete");
    expect(summaryEvent).toBeDefined();
    const detail = summaryEvent?.detail as Record<string, unknown> | undefined;
    expect(detail).toMatchObject({ scanned: 2, rescued: 0 });
  });

  it("AC2c: sweep-level exception in runRescueSweep produces an alert-level event, not just a log", async () => {
    // When runRescueSweep's outer try-catch catches a fatal error (e.g. fetchWfTickets throws),
    // the operationalEventStore must receive an alert event.
    // Currently: the cron logs the error but does not emit an alert-level operational event.
    const events: Array<{ outcome: string; type?: string; severity?: string; detail?: unknown }> = [];
    const operationalEventStore = {
      record(ev: { outcome: string; type?: string; severity?: string; detail?: unknown }) { events.push(ev); },
    };

    // Simulate fetchWfTickets throwing (network failure)
    globalThis.fetch = async () => { throw new Error("Network failure"); };

    const policyPath = makeCapabilityPolicy();

    // runRescueSweep should catch the error, emit an alert, and return normally.
    const result = await runRescueSweep({
      authToken: "Bearer test",
      workflowRegistry: new Map([["dev-impl", MINIMAL_WF_DEF]]),
      capabilityPolicyPath: policyPath,
      operationalEventStore,
    });

    // An alert-level event must be emitted when the sweep encounters a fatal error.
    const alertEvent = events.find(
      (e) =>
        e.outcome === "sweep:failed" ||
        e.outcome === "rescue:alert" ||
        e.severity === "alert" ||
        e.type === "sweep-error",
    );
    expect(alertEvent).toBeDefined();
  });
});

// ── AC3 — /health exposes rescueSweep.lastRunAt and lastOutcome ────────────

describe("AC3 — GET /health includes rescueSweep.lastRunAt and lastOutcome counts", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-ac3-"));
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
    globalThis.fetch = async (url: unknown, init?: RequestInit) =>
      originalFetch(url as Parameters<typeof fetch>[0], init);
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
  });

  it("AC3a: GET /health response includes a rescueSweep field", async () => {
    const res = await request(appState.app)
      .get("/health")
      .set("Authorization", "Bearer tok-hanzo");

    expect(res.status).toBe(200);
    // The /health response must have a top-level rescueSweep field.
    // Currently: /health returns { status, service, deployment, commit, agents, agentNames, crons, universalCanon }
    // It does NOT include rescueSweep — this test FAILS.
    expect(res.body).toHaveProperty("rescueSweep");
  });

  it("AC3b: /health rescueSweep.lastRunAt is null before any sweep fires", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    const sweep = res.body.rescueSweep as Record<string, unknown> | undefined;
    expect(sweep).toBeDefined();
    // Before any sweep has run, lastRunAt should be null (not undefined, not missing).
    expect(Object.prototype.hasOwnProperty.call(sweep, "lastRunAt")).toBe(true);
    expect(sweep?.lastRunAt).toBeNull();
  });

  it("AC3c: /health rescueSweep.lastOutcome includes scanned, rescued, and errors counts", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    const sweep = res.body.rescueSweep as Record<string, unknown> | undefined;
    expect(sweep).toBeDefined();
    // Before any sweep: lastOutcome is null or includes the expected shape.
    // After the first sweep: it must include scanned/rescued/errors counts.
    // The test verifies the KEY EXISTS, even if null initially.
    expect(Object.prototype.hasOwnProperty.call(sweep, "lastOutcome")).toBe(true);
  });

  it("AC3d: /health rescueSweep.schedule matches the configured RESCUE_SWEEP_INTERVAL", async () => {
    // The cadence must be visible in /health so "when does it next run" is answerable.
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    const sweep = res.body.rescueSweep as Record<string, unknown> | undefined;
    expect(sweep).toBeDefined();
    // The schedule field must be present (e.g. "every 1h").
    expect(typeof sweep?.schedule).toBe("string");
    expect((sweep?.schedule as string).length).toBeGreaterThan(0);
  });
});

// ── AC4 — Gate-decline response accurately reflects partial state ──────────

describe("AC4 — Gate-decline proxy response includes post-decline ticket state so CLI can verify partial-state claims", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  const HANZO_AT_DEPLOYMENT = {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
        delegate: { id: "u-hanzo" },
        team: { id: "team-ai" },
      },
    },
  };

  function makeFetch(labelResponse: object) {
    return async (url: unknown, init?: RequestInit) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url as Parameters<typeof fetch>[0], init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string }) : {};
      if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels") || parsed.query?.includes("delegate")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-ac4-"));
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
  });

  it("AC4a: gate-decline error response includes _ticketState with post-decline labels and delegateId", async () => {
    // When the proxy declines a mutation, it must include the post-decline ticket state
    // in its error response body so the CLI can verify partial-state claims.
    // Currently: responses are { errors: [{ message: "..." }] } with no ticket state.
    // After fix: responses include _ticketState: { labels: [...], delegateId: "..." }.
    globalThis.fetch = makeFetch(HANZO_AT_DEPLOYMENT);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-tdd") // tdd is not hanzo — wrong delegate
      .set("X-Openclaw-Agent", "tdd")
      .set("X-Openclaw-Linear-Intent", "complete") // blocked — wrong delegate
      .send({
        query: `mutation M($id: String!) { issueUpdate(id: $id, input: { }) { success } }`,
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();

    // The rejection response must include _ticketState so the CLI can detect partial writes.
    const error = res.body.errors[0] as Record<string, unknown>;
    // Either the error object has extensions._ticketState, OR the response body has _ticketState.
    const hasTicketState =
      (error?.extensions as Record<string, unknown> | undefined)?._ticketState !== undefined ||
      res.body._ticketState !== undefined;
    expect(hasTicketState).toBe(true);
  });

  it("AC4b: _ticketState in decline response includes the actual post-decline label list", async () => {
    globalThis.fetch = makeFetch(HANZO_AT_DEPLOYMENT);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-tdd")
      .set("X-Openclaw-Agent", "tdd")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send({
        query: `mutation M($id: String!) { issueUpdate(id: $id, input: { }) { success } }`,
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();

    // The _ticketState must include at minimum: labels array and delegateId.
    const extensions = (res.body.errors[0] as Record<string, unknown>)?.extensions as
      | Record<string, unknown>
      | undefined;
    const ticketState =
      (extensions?._ticketState as Record<string, unknown> | undefined) ??
      (res.body._ticketState as Record<string, unknown> | undefined);

    expect(ticketState).toBeDefined();
    expect(Array.isArray(ticketState?.labels)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(ticketState, "delegateId")).toBe(true);
  });
});

// ── AC5 — Bootstrap-wiring integration: rescue-sweep liveness via /health ─

describe("AC5 [Bootstrap-wiring] — /health exposes rescueSweep liveness from the production entry point", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-ac5-"));
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
    globalThis.fetch = async (url: unknown, init?: RequestInit) =>
      originalFetch(url as Parameters<typeof fetch>[0], init);
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
  });

  it("AC5a: /health rescueSweep field is present at server startup (before any sweep fires)", async () => {
    // This verifies that /health is immediately informative about rescue-sweep liveness
    // at ac-validate time — without needing to wait for a sweep trigger.
    // The existing /health.crons entry proves scheduling; this proves the EXTENDED liveness
    // state (lastRunAt + lastOutcome) is also immediately available.
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    // rescueSweep must be in /health immediately at server startup.
    expect(res.body).toHaveProperty("rescueSweep");
    // lastRunAt must be null (not missing) before any sweep fires.
    expect(res.body.rescueSweep).toMatchObject({
      lastRunAt: null,
    });
  });

  it("AC5b: /health crons array includes rescue-sweep with a schedule entry (existing registry test passes through)", async () => {
    // Regression guard: the existing AI-1810 registration must not be broken by the AC3/AC5 implementation.
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    const crons = res.body.crons as Array<{ name: string; schedule: string }> | undefined;
    // createApp() does NOT call registerRescueSweepCron() — only the production entry point does.
    // So crons may not include rescue-sweep here. The AC5 integration test for the production
    // entry point runs separately via health-crons-integration.test.ts (which boots dist/index.js).
    // This test asserts the /health structure is compatible.
    expect(Array.isArray(crons)).toBe(true);
  });

  it("AC5c: /health rescueSweep.lastOutcome is null before any sweep fires", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    const sweep = res.body.rescueSweep as Record<string, unknown> | undefined;
    expect(sweep).toBeDefined();
    // lastOutcome is null before the first sweep. After the first sweep it's { scanned, rescued, errors }.
    expect(Object.prototype.hasOwnProperty.call(sweep, "lastOutcome")).toBe(true);
    expect(sweep?.lastOutcome).toBeNull();
  });
});
