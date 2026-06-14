/**
 * AI-1546 / G-6 — Tests for the steward/human-only atomic set-state command.
 *
 * Covers:
 *   AC1 — setStateAtomic writes label + native + delegate atomically; consistency
 *          is asserted after the mutation.
 *   AC2 — POST /admin/api/set-state is gated by ADMIN_SECRET (admin router
 *          middleware); agent callers (no ADMIN_SECRET) are rejected 401.
 *   AC3 — set-state works from any source state, including terminal states
 *          (done, escape).  No legal-move validation.
 *   AC4 — failure in the atomic mutation leaves no partial state because
 *          issueUpdateAtomic is a single Linear issueUpdate call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import yaml from "js-yaml";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import { setStateAtomic } from "./workflow-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { createApp } from "./index.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "set-state-test-"));
}

const ADMIN_SECRET = "set-state-admin-secret";

function writeAgents(dir: string, extras: object[] = []): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      {
        name: "igor",
        linearUserId: "user-igor-linear-id",
        openclawAgent: "igor",
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "access-token-igor",
        refreshToken: "refresh-token-igor",
        host: "local",
      },
      ...extras,
    ],
  }), "utf8");
  return file;
}

function writeWorkflowDef(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  const def = {
    id: "dev-impl",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [{ command: "accept", to: "implementation" }] },
      { id: "implementation", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "submit", to: "done" }] },
      { id: "done", kind: "terminal", native_state: "done" },
      { id: "escape", kind: "terminal", native_state: "invalid" },
    ],
  };
  fs.writeFileSync(file, yaml.dump(def), "utf8");
  return file;
}

function writePolicyYaml(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  const policy = {
    bodies: [
      { id: "igor", container: "dev", fills_roles: ["dev"] },
      { id: "astrid", container: "steward", fills_roles: ["steward"] },
    ],
    containers: [
      { id: "dev", grants: ["linear:transition"] },
      { id: "steward", grants: ["linear:transition", "human:escalate"] },
    ],
  };
  fs.writeFileSync(file, yaml.dump(policy), "utf8");
  return file;
}

// ── Minimal Linear API mock ─────────────────────────────────────────────────
//
// Sequences through three phases:
//   1. fetchIssueWithLabels (initial fetch)          → returns current labels
//   2. TeamLabels lookup (findOrCreateLabel)         → returns the label id
//   3. TeamStates lookup (resolveNativeStateId)      → returns mock states
//   4. issueUpdate mutation (issueUpdateAtomic)      → returns success:true
//   5. fetchIssueWithLabels (consistency re-check)   → returns updated labels

interface MockOptions {
  fromLabels?: string[];
  updateSuccess?: boolean;
  consistencyLabels?: string[];
  throwOnUpdate?: boolean;
}

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-done-uuid", name: "Done", type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

function makeSetStateFetch(opts: MockOptions): typeof globalThis.fetch {
  const {
    fromLabels = ["wf:dev-impl", "state:implementation"],
    updateSuccess = true,
    consistencyLabels,
    throwOnUpdate = false,
  } = opts;

  // What labels to return on the consistency re-check.
  const afterLabels = consistencyLabels ?? fromLabels.map((l) => (l.startsWith("state:") ? `state:${fromLabels.find(x => !x.startsWith("state:") && !x.startsWith("wf:")) ?? "implementation"}` : l));
  let callIndex = 0;

  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : (init?.body instanceof Buffer ? init.body.toString() : "");

    // Resolve native state
    if (bodyText.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: MOCK_TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Label lookup (findOrCreateLabel — TeamLabels query)
    if (bodyText.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [{ id: "label-state-target-uuid", name: "state:implementation" }, { id: "label-state-done-uuid", name: "state:done" }, { id: "label-state-escape-uuid", name: "state:escape" }, { id: "label-state-intake-uuid", name: "state:intake" }] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // issueUpdate mutation
    if (bodyText.includes("ApplyAtomicTransition") || (bodyText.includes("issueUpdate") && bodyText.includes("labelIds"))) {
      if (throwOnUpdate) throw new Error("simulated Linear API failure");
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: updateSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // IssueWithLabels fetch — workflow-gate.ts private fetchIssueWithLabels
    // Called twice: once for the initial fetch, once for consistency re-check (AC1).
    if (bodyText.includes("IssueWithLabels")) {
      const isRecheck = callIndex++ > 0;
      const labels = isRecheck ? (consistencyLabels ?? fromLabels) : fromLabels;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-issue-uuid",
              team: { id: "team-uuid" },
              labels: { nodes: labels.map((name) => ({ id: `label-${name.replace(/[:/]/g, "-")}-uuid`, name })) },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

// ── Unit tests for setStateAtomic ──────────────────────────────────────────

describe("setStateAtomic (AI-1546)", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    dir = tempDir();
    writeWorkflowDef(dir);
    writePolicyYaml(dir);
    writeAgents(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
  });

  // AC1 — atomic write; consistency re-check passes
  it("AC1: returns ok:true and correct from/to when mutation succeeds and consistency check passes", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:done"],
    });
    const result = await setStateAtomic("AI-9999", "done", undefined, "Bearer test-token");
    expect(result.ok).toBe(true);
    expect(result.from).toBe("implementation");
    expect(result.to).toBe("done");
    expect(result.error).toBeUndefined();
  });

  // AC1 — consistency failure surfaces as ok:false
  it("AC1: returns ok:false when consistency re-check finds wrong state label", async () => {
    // Update succeeds but recheck returns the old label (simulating label desync)
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"], // old label still there
    });
    const result = await setStateAtomic("AI-9999", "done", undefined, "Bearer test-token");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/consistency check failed/);
  });

  // AC3 — works from terminal source state (escape → implementation re-open)
  it("AC3: succeeds from terminal 'escape' state (re-open path)", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:escape"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });
    const result = await setStateAtomic("AI-9999", "implementation", undefined, "Bearer test-token");
    expect(result.ok).toBe(true);
    expect(result.from).toBe("escape");
    expect(result.to).toBe("implementation");
  });

  // AC3 — works from terminal 'done' state
  it("AC3: succeeds from terminal 'done' state (rewind path)", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:done"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:intake"],
    });
    const result = await setStateAtomic("AI-9999", "intake", undefined, "Bearer test-token");
    expect(result.ok).toBe(true);
    expect(result.from).toBe("done");
    expect(result.to).toBe("intake");
  });

  // AC4 — mutation failure returns ok:false; no partial state (single mutation contract)
  it("AC4: returns ok:false when the atomic mutation fails (Linear returns success:false)", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: false,
    });
    const result = await setStateAtomic("AI-9999", "done", undefined, "Bearer test-token");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/atomic issueUpdate mutation failed/);
  });

  // AC4 — network error during mutation also returns ok:false cleanly
  it("AC4: returns ok:false when the atomic mutation throws a network error", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      throwOnUpdate: true,
    });
    const result = await setStateAtomic("AI-9999", "done", undefined, "Bearer test-token");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for an unknown target state (not in workflow def)", async () => {
    globalThis.fetch = makeSetStateFetch({ fromLabels: ["wf:dev-impl", "state:implementation"] });
    const result = await setStateAtomic("AI-9999", "nonexistent-state", undefined, "Bearer test-token");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown target state/);
  });

  it("returns ok:false when the issue cannot be fetched", async () => {
    globalThis.fetch = async () => { throw new Error("network failure"); };
    const result = await setStateAtomic("AI-9999", "implementation", undefined, "Bearer test-token");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not fetch issue/);
  });

  it("resolves delegate by agent body name and includes linearUserId in mutation", async () => {
    let mutationBody: string | undefined;
    // Create the base mock once so callIndex state is preserved across IssueWithLabels calls.
    const baseMock = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:done"],
    });
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("ApplyAtomicTransition") || (bodyText.includes("issueUpdate") && bodyText.includes("labelIds"))) {
        mutationBody = bodyText;
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseMock(_url, init);
    };
    const result = await setStateAtomic("AI-9999", "done", "igor", "Bearer test-token");
    expect(result.ok).toBe(true);
    expect(mutationBody).toBeDefined();
    expect(mutationBody).toContain("user-igor-linear-id");
  });

  it("clears delegate when null is passed", async () => {
    let mutationBody: string | undefined;
    const baseMock = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:done"],
    });
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("ApplyAtomicTransition") || (bodyText.includes("issueUpdate") && bodyText.includes("labelIds"))) {
        mutationBody = bodyText;
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseMock(_url, init);
    };
    const result = await setStateAtomic("AI-9999", "done", null, "Bearer test-token");
    expect(result.ok).toBe(true);
    expect(mutationBody).toBeDefined();
    // delegateId: null should appear in the mutation variables
    expect(mutationBody).toContain("delegateId");
  });

  it("returns ok:false for unknown delegate agent name", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:done"],
    });
    const result = await setStateAtomic("AI-9999", "done", "nonexistent-agent", "Bearer test-token");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/delegate agent.*not found/);
  });
});

// ── Integration tests — admin HTTP endpoint ─────────────────────────────────

describe("POST /admin/api/set-state (AI-1546 / AC2)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = tempDir();
    const workflowFile = writeWorkflowDef(dir);
    const policyFile = writePolicyYaml(dir);
    const agentsFile = writeAgents(dir);

    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });
  });

  afterEach(() => {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    globalThis.fetch = originalFetch;
    delete process.env.ADMIN_SECRET;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // AC2 — unauthenticated callers are rejected
  it("AC2: returns 401 when no ADMIN_SECRET is provided", async () => {
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .send({ ticketId: "AI-9999", targetState: "implementation" });
    expect(res.status).toBe(401);
  });

  it("AC2: returns 401 for wrong ADMIN_SECRET", async () => {
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .set("x-admin-secret", "wrong-secret")
      .send({ ticketId: "AI-9999", targetState: "implementation" });
    expect(res.status).toBe(401);
  });

  // AC2 — correct admin secret is accepted
  it("AC2: forwards request and returns 200 with ok:true when authenticated and mutation succeeds", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:done"],
    });
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-9999", targetState: "done" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.to).toBe("done");
  });

  it("returns 400 when ticketId or targetState is missing", async () => {
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-9999" }); // missing targetState
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 422 when the mutation fails", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: false,
    });
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-9999", targetState: "done" });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
  });

  // AC3 — re-open from terminal state via the HTTP endpoint
  it("AC3: accepts set-state from a terminal source state via HTTP endpoint", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:escape"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:intake"],
    });
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ ticketId: "AI-9999", targetState: "intake" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.from).toBe("escape");
  });

  it("accepts Basic auth for the set-state endpoint", async () => {
    globalThis.fetch = makeSetStateFetch({
      fromLabels: ["wf:dev-impl", "state:implementation"],
      updateSuccess: true,
      consistencyLabels: ["wf:dev-impl", "state:done"],
    });
    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .auth("admin", ADMIN_SECRET)
      .send({ ticketId: "AI-9999", targetState: "done" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
