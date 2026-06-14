/**
 * Tests for idempotency and concurrent-command race handling (AI-1548).
 * Gaps G-8 (webhook dedup + overlay/transition ordering) and G-16 (concurrent
 * proxy commands on the same ticket).
 *
 * AC1 (G-8): replay each transition event twice → single effect.
 * AC2 (G-8): interleave overlay + transition writes → authoritative write wins.
 * AC3 (G-16): two legal-from-current transitions fired concurrently → exactly
 *   one applies; loser rejected with the post-first legal set named.
 *
 * AC1 and AC2 verify the existing EventStore dedup and terminal-label guard at
 * integration level. AC3 is a failing spec: G-16 has NO locking mechanism yet;
 * both concurrent commands currently pass the gate, violating "first-wins."
 */

import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createWebhookRouter } from "./webhook/index.js";
import { createApp } from "./index.js";
import { EventStore } from "./store/event-store.js";
import { applyEngagementStatus } from "./engagement-status.js";
import { resetNativeStateCache } from "./workflow-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// ── Shared constants ───────────────────────────────────────────────────────

const SECRET = "test-idempotency-secret";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-1548-${label}-`));
}

// ── Minimal workflow def for proxy tests ──────────────────────────────────

const MINIMAL_WORKFLOW_YAML = `
id: dev-impl
version: 8
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
        to: write-tests
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
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

const MINIMAL_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: test-author
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
    linearUserId: astrid-linear-user-id
  - id: tdd
    container: test-author
    fills_roles: [test-author]
    linearUserId: tdd-linear-user-id
`;

function writeTempFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function writeAgentsFile(dir: string): string {
  const p = path.join(dir, "agents.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-user-id", openclawAgent: "astrid", accessToken: "astrid-tok", host: "local" },
        { name: "tdd", linearUserId: "tdd-linear-user-id", openclawAgent: "tdd", accessToken: "tdd-tok", host: "local" },
      ],
    }),
    "utf8",
  );
  return p;
}

// ── Webhook test helpers ───────────────────────────────────────────────────

function makeIssueUpdatePayload(identifier: string, stateName: string, stateType = "started") {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-06-14T10:00:00.000Z",
    actor: { id: "astrid-id", name: "Astrid" },
    data: {
      id: `issue-${identifier.replace(/[^a-z0-9]/gi, "-")}`,
      identifier,
      title: "Test ticket",
      state: { id: "state-1", name: stateName, type: stateType },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "team-ai", key: "AI" },
      labelIds: [],
      url: `https://linear.app/fancymatt/issue/${identifier}`,
      delegate: { id: "tdd-linear-user-id", name: "TestDrivenDevelopmentAgent" },
      createdAt: "2026-06-14T09:00:00.000Z",
      updatedAt: "2026-06-14T10:00:00.000Z",
    },
  });
}

function createWebhookApp(eventStore?: EventStore) {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).rawBody = req.body;
      }
      next();
    },
  );
  app.use("/", createWebhookRouter(eventStore));
  return app;
}

// ── AC1: Webhook event dedup ───────────────────────────────────────────────

describe("AC1 (G-8): replay each transition event twice → single effect", () => {
  let dir: string;
  let eventStore: EventStore;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    dir = tempDir("ac1");
    eventStore = new EventStore(path.join(dir, "events.db"));
  });

  afterEach(() => {
    process.env = originalEnv;
    eventStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("second delivery of the same x-linear-delivery ID is acknowledged as duplicate without re-dispatch", async () => {
    const app = createWebhookApp(eventStore);
    const body = makeIssueUpdatePayload("AI-1000", "Write Tests");
    const deliveryId = "delivery-ac1-transition-1";

    const res1 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", deliveryId)
      .send(body);

    const res2 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", deliveryId)
      .send(body);

    expect(res1.status).toBe(200);
    expect(res1.body.ok).toBe(true);
    expect(res1.body.duplicate).toBeUndefined(); // first delivery is live

    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);
    expect(res2.body.duplicate).toBe(true); // second delivery is deduped
  });

  it("duplicate flag appears for any event type — not just comments — when delivery ID repeats", async () => {
    const app = createWebhookApp(eventStore);
    const body = makeIssueUpdatePayload("AI-1001", "Write Tests");
    const deliveryId = "delivery-ac1-transition-2";

    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", deliveryId)
      .send(body);

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", deliveryId)
      .send(body);

    expect(res.body.duplicate).toBe(true);
  });

  it("dedup is enforced across distinct payload bodies when delivery ID is the same (e.g. Linear retry with a refreshed updatedAt)", async () => {
    const app = createWebhookApp(eventStore);
    const deliveryId = "delivery-ac1-retry";

    // First delivery — original payload
    const body1 = makeIssueUpdatePayload("AI-1002", "Write Tests");
    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body1))
      .set("x-linear-delivery", deliveryId)
      .send(body1);

    // Second delivery — same logical event, slightly different payload (different updatedAt)
    // Linear retries preserve the delivery ID; only the payload timestamp differs.
    const body2 = JSON.stringify({
      ...JSON.parse(body1) as object,
      data: {
        ...(JSON.parse(body1) as { data: object }).data,
        updatedAt: "2026-06-14T10:00:05.000Z", // 5 seconds later
      },
    });

    const res2 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body2))
      .set("x-linear-delivery", deliveryId)
      .send(body2);

    // The delivery ID is the canonical dedup key — the same ID must suppress the replay
    // regardless of payload differences. If this fails, a Linear retry would re-dispatch.
    expect(res2.body.duplicate).toBe(true);
  });

  it("event is NOT deduped when a new delivery ID is used (independent events pass through)", async () => {
    const app = createWebhookApp(eventStore);
    const body = makeIssueUpdatePayload("AI-1003", "Write Tests");

    const res1 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "delivery-ac1-a")
      .send(body);

    const res2 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "delivery-ac1-b")
      .send(body);

    // Different delivery IDs — both are genuine events and must both go through
    expect(res1.body.duplicate).toBeUndefined();
    expect(res2.body.duplicate).toBeUndefined();
  });
});

// ── AC2: Overlay vs authoritative transition write ─────────────────────────

describe("AC2 (G-8): interleave overlay + transition writes → authoritative write wins", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Simulate: workflow-gate has just written state:done (native = "done").
   * Shortly after, the departing agent's last activity event fires and calls
   * applyEngagementStatus("doing"). The terminal label must block the overlay.
   * (AI-1540 — production incident; ~770ms lag between terminal write and overlay)
   */
  it("'doing' overlay fired after terminal transition to done is blocked — native Done write is authoritative", async () => {
    const updates: Array<{ id: string; stateId: string }> = [];

    globalThis.fetch = async (_url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const q = parsed.query ?? "";
      const vars = parsed.variables ?? {};

      if (q.includes("EngagementIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-done",
                team: { id: "team-1" },
                state: { id: "state-done-uuid", name: "Done" },
                // Terminal label is present — the workflow-gate transition already ran.
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "To Do", type: "unstarted" },
                    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueUpdate")) {
        updates.push({ id: String(vars.id), stateId: String(vars.stateId) });
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await applyEngagementStatus("AI-9001", "doing", "tok");

    // The overlay must NOT write — the state:done label means the transition write is authoritative.
    expect(updates).toHaveLength(0);
  });

  it("'doing' overlay fired after terminal transition to escape is blocked — native Invalid write is authoritative", async () => {
    const updates: Array<{ id: string; stateId: string }> = [];

    globalThis.fetch = async (_url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const q = parsed.query ?? "";
      const vars = parsed.variables ?? {};

      if (q.includes("EngagementIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-escape",
                team: { id: "team-1" },
                state: { id: "state-invalid-uuid", name: "Invalid" },
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:escape" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "To Do", type: "unstarted" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueUpdate")) {
        updates.push({ id: String(vars.id), stateId: String(vars.stateId) });
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await applyEngagementStatus("AI-9002", "doing", "tok");

    // The escape terminal label must block the overlay — same as done.
    expect(updates).toHaveLength(0);
  });

  it("non-terminal workflow tickets still receive the overlay — terminal guard has no regression", async () => {
    const updates: Array<{ id: string; stateId: string }> = [];

    globalThis.fetch = async (_url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const q = parsed.query ?? "";
      const vars = parsed.variables ?? {};

      if (q.includes("EngagementIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-active",
                team: { id: "team-1" },
                state: { id: "state-todo-uuid", name: "To Do" },
                // Non-terminal state — overlay should apply.
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:write-tests" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "To Do", type: "unstarted" },
                    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueUpdate")) {
        updates.push({ id: String(vars.id), stateId: String(vars.stateId) });
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await applyEngagementStatus("AI-9003", "thinking", "tok");

    // Non-terminal: the "thinking" overlay must fire (native To Do → Thinking).
    expect(updates).toHaveLength(1);
    expect(updates[0].stateId).toBe("state-thinking-uuid");
  });
});

// ── AC3: Concurrent proxy commands (G-16) — FAILING SPEC ──────────────────
//
// G-16: two commands on the same ticket in the same time window must be
// first-wins. The second must be rejected with the FRESH legal set, computed
// against the now-current state after the first command applied.
//
// Currently there is NO per-ticket locking mechanism. Both concurrent commands
// pass checkWorkflowRules independently (both see state:intake before either
// applies), are forwarded to Linear, and both return success. These tests
// describe the DESIRED behavior and are RED until the locking mechanism exists.

describe("AC3 (G-16): concurrent commands on the same ticket — first-wins, second rejected with fresh legal set", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  // Stateful mock: simulates two agents both reading state:intake before
  // either's transition applies. The context fetch always returns state:intake
  // so the gate sees both commands as legal — proving there is no lock.
  // The issueUpdate (B2 state swap) tracks which calls were made.
  function makeIntakeMock() {
    const mutations: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const q = parsed.query ?? "";
      const vars = parsed.variables ?? {};

      // IssueContext (used by checkWorkflowRules — always returns state:intake)
      if (q.includes("IssueContext")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
                // No delegate set — both agents can proceed (fail-open on empty delegate)
                delegate: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // IssueWithLabels (used by applyStateTransition B2)
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid-9100",
                team: { id: "team-ai" },
                labels: { nodes: [
                  { id: "lbl-wf", name: "wf:dev-impl" },
                  { id: "lbl-state", name: "state:intake" },
                ] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // IssueLabels (used by fetchWorkflowLabels / source-state snapshot)
      if (q.includes("IssueLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // TeamLabels (used by findOrCreateLabel in applyStateTransition)
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: { nodes: [
                  { id: "lbl-wf", name: "wf:dev-impl" },
                  { id: "lbl-intake", name: "state:intake" },
                  { id: "lbl-write-tests", name: "state:write-tests" },
                ] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // TeamStates (used by resolveNativeStateId in applyStateTransition)
      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "To Do", type: "unstarted" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // IssueDescription (capture_ac at accept time)
      if (q.includes("IssueDescription")) {
        return new Response(
          JSON.stringify({ data: { issue: { description: "## Acceptance\n* AC1: test" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Any mutation (issueUpdate, issueLabelCreate, etc.) — track and succeed
      if (q.trimStart().startsWith("mutation")) {
        mutations.push({ query: q, variables: vars });
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true }, issueLabelCreate: { success: true, issueLabel: { id: "lbl-new" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    return { fetch, mutations };
  }

  beforeEach(() => {
    dir = tempDir("ac3");
    writeTempFile(dir, "dev-impl.yaml", MINIMAL_WORKFLOW_YAML);
    writeTempFile(dir, "capability-policy.yaml", MINIMAL_POLICY_YAML);
    writeAgentsFile(dir);

    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.AGENTS_FILE = path.join(dir, "agents.json");

    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "ops.db"),
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

  // The mutation body sent by both concurrent callers: issueUpdate on the same ticket.
  const concurrentMutation = JSON.stringify({
    query: `
      mutation AcceptTicket($id: String!, $delegateId: String) {
        issueUpdate(id: $id, input: { delegateId: $delegateId }) {
          success
          issue { id state { id name } }
        }
      }
    `,
    variables: { id: "AI-9100", delegateId: "tdd-linear-user-id" },
  });

  it("two concurrent accept commands — exactly one is accepted, the second is rejected with the post-accept legal set", async () => {
    const { fetch: mockFetch } = makeIntakeMock();
    globalThis.fetch = mockFetch;

    // Both agents fire 'accept' concurrently on the same intake ticket.
    // No X-Openclaw-Linear-Target — 'accept' is auto-assign (singleton test-author).
    // Desired: exactly one succeeds (no errors), the other is rejected
    // and its error message names the legal moves from write-tests.
    const [res1, res2] = await Promise.all([
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer astrid-tok")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Intent", "accept")
        .set("Content-Type", "application/json")
        .send(concurrentMutation),
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer astrid-tok")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Intent", "accept")
        .set("Content-Type", "application/json")
        .send(concurrentMutation),
    ]);

    const bodies = [res1.body, res2.body] as Array<{ errors?: Array<{ message: string }> }>;
    const rejections = bodies.filter((b) => b.errors && b.errors.length > 0);
    const successes = bodies.filter((b) => !b.errors || b.errors.length === 0);

    // G-16 requirement: first wins, second is rejected.
    // This assertion FAILS until a per-ticket locking mechanism is implemented.
    expect(rejections).toHaveLength(1);
    expect(successes).toHaveLength(1);

    // The rejection must name the legal set from the post-accept state (write-tests).
    // write-tests → [ tests-ready, escape (break-glass) ]
    const rejectionMsg = rejections[0].errors![0].message;
    expect(rejectionMsg).toMatch(/tests-ready/);
  });

  it("concurrent accept + accept from two distinct agent identities — same first-wins contract applies", async () => {
    const { fetch: mockFetch } = makeIntakeMock();
    globalThis.fetch = mockFetch;

    // One from astrid (steward / owner), one from tdd — different agents, same ticket, same command.
    const [res1, res2] = await Promise.all([
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer astrid-tok")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Intent", "accept")
        .set("Content-Type", "application/json")
        .send(concurrentMutation),
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tdd-tok")
        .set("X-Openclaw-Agent", "tdd")
        .set("X-Openclaw-Linear-Intent", "accept")
        .set("Content-Type", "application/json")
        .send(concurrentMutation),
    ]);

    const bodies = [res1.body, res2.body] as Array<{ errors?: Array<{ message: string }> }>;
    const rejections = bodies.filter((b) => b.errors && b.errors.length > 0);

    // Second concurrent command must be rejected regardless of which agent it came from.
    // This assertion FAILS until a per-ticket locking mechanism is implemented.
    expect(rejections).toHaveLength(1);
    expect(rejections[0].errors![0].message).toMatch(/tests-ready/);
  });

  it("rejection message names the legal moves computed against the post-first-command state, not the original intake state", async () => {
    // After 'accept' (intake → write-tests), the loser is in write-tests context.
    // Legal from write-tests: [ tests-ready, escape ]
    // The rejection must NOT say 'accept' or 'demote' (which were legal from intake).
    const { fetch: mockFetch } = makeIntakeMock();
    globalThis.fetch = mockFetch;

    const [res1, res2] = await Promise.all([
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer astrid-tok")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Intent", "accept")
        .set("Content-Type", "application/json")
        .send(concurrentMutation),
      request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer astrid-tok")
        .set("X-Openclaw-Agent", "astrid")
        .set("X-Openclaw-Linear-Intent", "accept")
        .set("Content-Type", "application/json")
        .send(concurrentMutation),
    ]);

    const bodies = [res1.body, res2.body] as Array<{ errors?: Array<{ message: string }> }>;
    const rejections = bodies.filter((b) => b.errors && b.errors.length > 0);

    // G-16: rejection must name the FRESH legal set from write-tests.
    // This assertion FAILS until a per-ticket locking mechanism is implemented.
    expect(rejections).toHaveLength(1);

    const msg = rejections[0].errors![0].message;
    // Post-first legal set: tests-ready (and escape break-glass)
    expect(msg).toMatch(/tests-ready/);
    // Must NOT surface intake-era legal moves
    expect(msg).not.toMatch(/\baccept\b/);
    expect(msg).not.toMatch(/\bdemote\b/);
  });
});
