/**
 * Regression tests for the engagement-status overlay (AI-1560).
 *
 * Tests are FAILING against the current implementation by design — they specify
 * the target behavior for Igor to implement. Each describe block maps to one AC.
 *
 * AC1: pull-pickup flips Thinking (on read) and Doing (on first activity)
 * AC2: dev-impl handoff — native resets to To Do between owners; never sticks at Doing
 * AC3: session-end reliably wired for containerized agents resets native to To Do
 * AC4: regression/integration test for pull-pickup + handoff sequence
 * AC5: per-ticket engagement event observability
 */

import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { resetNativeStateCache } from "./workflow-gate.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

function tempDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-1560-${label}-`));
  return path.join(dir, "test.db");
}

const SEMANTIC_TO_UUID: Record<string, string> = {
  "To Do":    "state-todo-uuid",
  Thinking:   "state-thinking-uuid",
  Doing:      "state-doing-uuid",
  Done:       "state-done-uuid",
  Invalid:    "state-invalid-uuid",
};

/**
 * Build a minimal Linear API mock that tracks engagement state writes.
 * Always responds to EngagementIssue with the given fixture; responds to
 * TeamStates with all four semantics; records each issueUpdate call.
 */
function makeLinearFetchMock(fixture: {
  issueId: string;
  teamId: string;
  stateName: string;
  stateId: string;
  labels: string[];
}): {
  fetch: typeof globalThis.fetch;
  updates: Array<{ issueId: string; stateId: string }>;
} {
  const updates: Array<{ issueId: string; stateId: string }> = [];

  const mock: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const q = body.query ?? "";
    const vars = body.variables ?? {};

    if (q.includes("EngagementIssue")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: fixture.issueId,
              team: { id: fixture.teamId },
              state: { id: fixture.stateId, name: fixture.stateName, type: fixture.stateName === "Done" ? "completed" : fixture.stateName === "Invalid" ? "canceled" : "started" },
              labels: { nodes: fixture.labels.map((name) => ({ name })) },
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
                nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({
                  id,
                  name,
                  type:
                    name === "Done" ? "completed" : name === "Invalid" ? "canceled" : "started",
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("issueUpdate")) {
      updates.push({
        issueId: String(vars.id),
        stateId: String(vars.stateId),
      });
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

  return { fetch: mock, updates };
}

const WF_LABELS = ["wf:dev-impl", "state:write-tests"];

// ── AC1: Pull-pickup engagement path ────────────────────────────────────────
//
// When an agent claims a ticket via `linear queue --next` (self-pull), it never
// goes through the connector's webhook dispatch path, so `onDispatched` and the
// Thinking/Doing callbacks never fire. A new `/pull-ack` endpoint must accept a
// `{ agentId, ticketId }` notification from the agent and trigger the same
// engagement-status cycle that connector-dispatched work gets.
//
// These tests FAIL because /pull-ack does not exist yet.

describe("AC1: pull-pickup engagement path (AI-1560)", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;
  let originalFetch: typeof globalThis.fetch;

  const TICKET_ID = "AI-1560";
  const SESSION_KEY = "linear-AI-1560";
  const AGENT_ID = "tdd";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
    process.env.SESSION_END_SECRET = "test-secret";
    process.env.LINEAR_OAUTH_TOKEN = "test-token";
    dbPath = tempDb("ac1");
    ({ app, bag, sessionTracker } = createApp({ bagDbPath: dbPath }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SESSION_END_SECRET;
    delete process.env.LINEAR_OAUTH_TOKEN;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("POST /pull-ack returns 200 when agentId and ticketId are valid", async () => {
    // FAILS: endpoint does not exist → expect 404
    const res = await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID, ticketId: TICKET_ID }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /pull-ack flips ticket to Thinking in Linear", async () => {
    // FAILS: endpoint does not exist; engagement flip never fires
    const { fetch, updates } = makeLinearFetchMock({
      issueId: "issue-1560-uuid",
      teamId: "team-uuid",
      stateName: "To Do",
      stateId: SEMANTIC_TO_UUID["To Do"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID, ticketId: TICKET_ID }));

    // Allow fire-and-forget engagement write to settle
    await new Promise((r) => setTimeout(r, 30));

    const thinkingUpdate = updates.find((u) => u.stateId === SEMANTIC_TO_UUID["Thinking"]);
    expect(thinkingUpdate).toBeDefined();
  });

  it("POST /pull-ack with agent activity (onAgentActivity path) flips ticket to Doing", async () => {
    // FAILS: endpoint does not exist; no dispatch record created; Doing never fires
    //
    // After /pull-ack, the agent must be registered as having a dispatch in flight
    // so that when the agent authors activity (webhook acknowledgment path) the
    // Doing flip correctly fires — same as connector-dispatched work.
    const { fetch, updates } = makeLinearFetchMock({
      issueId: "issue-1560-uuid",
      teamId: "team-uuid",
      stateName: "Thinking",
      stateId: SEMANTIC_TO_UUID["Thinking"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    // First: register the pull-pickup
    await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID, ticketId: TICKET_ID }));

    // Then: simulate agent-authored activity on that ticket (webhook fires with
    // the agent as actor). The Doing flip should arrive via onAgentActivity.
    // Here we drive it directly via the session tracker path the webhook would use.
    // For a proper integration test this would be a full webhook POST — but since
    // the /pull-ack endpoint doesn't exist, this test fails before reaching here.
    await request(app)
      .post("/pull-ack-activity")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID, ticketId: TICKET_ID }));

    await new Promise((r) => setTimeout(r, 30));

    const doingUpdate = updates.find((u) => u.stateId === SEMANTIC_TO_UUID["Doing"]);
    expect(doingUpdate).toBeDefined();
  });

  it("POST /pull-ack returns 400 when ticketId is missing", async () => {
    // FAILS: endpoint does not exist → 404 instead of 400
    const res = await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID }));
    expect(res.status).toBe(400);
  });
});

// ── AC2 + AC3: Session-end engagement reset ──────────────────────────────────
//
// When an agent's session ends (via /session-end), the connector must reset the
// native ticket status to To Do — but ONLY if no successor holds the ticket.
// These tests pin the engagement-flip behavior at /session-end, including the
// guard that prevents stomping a successor's session.
//
// AC3 specifically verifies that the /session-end handler fires engagement resets
// even when SESSION_END_SECRET is set (containerized auth path).
//
// These tests FAIL because the engagement flip is fire-and-forget and currently
// no mechanism exists to observe or assert that it was attempted in integration
// tests (the operational event store does not record engagement events — AC5 gap).

describe("AC2+AC3: session-end engagement reset (AI-1560)", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;
  let operationalEventStore: ReturnType<typeof createApp>["operationalEventStore"];
  let originalFetch: typeof globalThis.fetch;

  const AGENT_A = "astrid";
  const AGENT_B = "tdd";
  const TICKET_KEY = "linear-AI-1560";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
    process.env.SESSION_END_SECRET = "test-secret";
    process.env.LINEAR_OAUTH_TOKEN = "test-token";
    dbPath = tempDb("ac2ac3");
    ({ app, bag, sessionTracker, operationalEventStore } = createApp({ bagDbPath: dbPath }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SESSION_END_SECRET;
    delete process.env.LINEAR_OAUTH_TOKEN;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("session-end fires engagement todo flip for each active ticket of the ending agent", async () => {
    // FAILS: engagement events are not recorded in the operational event store (AC5),
    // so we cannot assert the flip was attempted after the session ends.
    //
    // Target behavior: after /session-end, a "engagement-todo" event must appear
    // in the operational event store for the ticket key.
    const { fetch } = makeLinearFetchMock({
      issueId: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    sessionTracker.startSession(AGENT_A, TICKET_KEY);

    await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_A }));

    await new Promise((r) => setTimeout(r, 50));

    // Assert: operational event store must have an engagement-todo record for this ticket.
    // FAILS: no such outcome exists in the current implementation.
    const events = operationalEventStore?.query({ key: TICKET_KEY, outcome: "engagement-todo" as never });
    expect(events?.length).toBeGreaterThanOrEqual(1);
  });

  it("session-end does NOT fire engagement todo when a successor already holds the ticket", async () => {
    // This tests the guard: if agent B has already started a session for the same
    // ticket before agent A's session ends, agent A's session-end must NOT reset
    // the ticket to To Do (that would erase B's Thinking/Doing state).
    const { fetch, updates } = makeLinearFetchMock({
      issueId: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    // A holds the ticket; B also holds it (successor picked up dispatch)
    sessionTracker.startSession(AGENT_A, TICKET_KEY);
    sessionTracker.startSession(AGENT_B, TICKET_KEY);

    await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_A }));

    await new Promise((r) => setTimeout(r, 50));

    // No To Do write should have fired — B still holds the ticket
    const todoUpdate = updates.find((u) => u.stateId === SEMANTIC_TO_UUID["To Do"]);
    expect(todoUpdate).toBeUndefined();
  });

  it("session-end engagement reset works when SESSION_END_SECRET is set (containerized auth)", async () => {
    // AC3: The /session-end endpoint must be callable from a containerized agent
    // that has the secret configured. This verifies the engagement reset fires
    // through the authenticated path — not just the unauthenticated fallback.
    //
    // FAILS: engagement events not recorded; cannot assert flip was attempted.
    const { fetch } = makeLinearFetchMock({
      issueId: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    sessionTracker.startSession(AGENT_A, TICKET_KEY);

    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_A }));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const events = operationalEventStore?.query({ key: TICKET_KEY, outcome: "engagement-todo" as never });
    expect(events?.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AC4: Pull-pickup + handoff lifecycle regression ──────────────────────────
//
// Full sequence: agent A pulls work (no connector dispatch) → Thinking fires →
// agent A authors activity → Doing fires → A's session ends → To Do fires →
// agent B dispatched → Thinking fires again → B authors activity → Doing fires.
//
// This test FAILS at the first step because /pull-ack does not exist.

describe("AC4: pull-pickup + handoff lifecycle regression (AI-1560)", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;
  let originalFetch: typeof globalThis.fetch;

  const TICKET_ID = "AI-1560";
  const TICKET_KEY = "linear-AI-1560";
  const AGENT_A = "astrid";
  const AGENT_B = "tdd";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
    process.env.SESSION_END_SECRET = "test-secret";
    process.env.LINEAR_OAUTH_TOKEN = "test-token";
    dbPath = tempDb("ac4");
    ({ app, bag, sessionTracker } = createApp({ bagDbPath: dbPath }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SESSION_END_SECRET;
    delete process.env.LINEAR_OAUTH_TOKEN;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("pull-pickup: Thinking → Doing → session-end → To Do — engagement sequence fires in order", async () => {
    // FAILS: /pull-ack does not exist; Thinking never fires for pull pickups.
    const engagementSequence: Array<{ semantic: string }> = [];

    // Track Linear state writes in order
    const mock: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const q = body.query ?? "";
      const vars = body.variables ?? {};

      if (q.includes("EngagementIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-uuid",
                team: { id: "team-uuid" },
                state: { id: SEMANTIC_TO_UUID["To Do"], name: "To Do", type: "started" },
                labels: { nodes: WF_LABELS.map((name) => ({ name })) },
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
                  nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({
                    id,
                    name,
                    type:
                      name === "Done" ? "completed" : name === "Invalid" ? "canceled" : "started",
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueUpdate")) {
        const stateId = String(vars.stateId);
        const semanticEntry = Object.entries(SEMANTIC_TO_UUID).find(([, id]) => id === stateId);
        if (semanticEntry) {
          engagementSequence.push({ semantic: semanticEntry[0] });
        }
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    globalThis.fetch = mock;

    // Step 1: Agent A pulls work — FAILS here (no /pull-ack endpoint)
    const pullAckRes = await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_A, ticketId: TICKET_ID }));
    expect(pullAckRes.status).toBe(200);
    sessionTracker.startSession(AGENT_A, TICKET_KEY);

    await new Promise((r) => setTimeout(r, 30));
    // After pull-ack: Thinking must have fired
    expect(engagementSequence.some((e) => e.semantic === "Thinking")).toBe(true);

    // Step 2: Agent A authors activity → Doing fires (via onAgentActivity webhook path)
    // (In the real flow this arrives via a Linear webhook carrying the agent's actor ID.)
    // Here we simulate it via the pull-ack-activity endpoint that the implementation should expose.
    const activityRes = await request(app)
      .post("/pull-ack-activity")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_A, ticketId: TICKET_ID }));
    expect(activityRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 30));
    expect(engagementSequence.some((e) => e.semantic === "Doing")).toBe(true);

    // Step 3: Agent A's session ends → To Do fires (no successor)
    await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_A }));

    await new Promise((r) => setTimeout(r, 50));
    expect(engagementSequence.some((e) => e.semantic === "To Do")).toBe(true);

    // Step 4: Agent B dispatched by connector → Thinking fires
    // (Simulated by calling pull-ack for B, or in practice by the connector's onDispatched callback)
    const bPullRes = await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_B, ticketId: TICKET_ID }));
    expect(bPullRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 30));

    // Assert the full sequence in order: Thinking, Doing, To Do, Thinking
    const semantics = engagementSequence.map((e) => e.semantic);
    expect(semantics).toEqual(
      expect.arrayContaining(["Thinking", "Doing", "To Do"]),
    );
    // The sequence must not end at Doing (no stuck-at-Doing regression)
    const lastSemanticBeforeReset = semantics.lastIndexOf("To Do");
    const firstBThinking = semantics.indexOf("Thinking", lastSemanticBeforeReset);
    expect(firstBThinking).toBeGreaterThan(lastSemanticBeforeReset);
  });
});

// ── AC5: Engagement event observability ─────────────────────────────────────
//
// There must be a way to inspect the last engagement event per ticket so that
// regressions can be detected without reading raw session logs. This maps to
// either (a) engagement events written to OperationalEventStore with a typed
// outcome, or (b) a dedicated endpoint. Both are tested.
//
// These tests FAIL because:
//   (a) OperationalEventStore does not record engagement events (no outcome type)
//   (b) No /admin/engagement/:ticketId endpoint exists

describe("AC5: engagement event observability (AI-1560)", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let operationalEventStore: ReturnType<typeof createApp>["operationalEventStore"];
  let dbPath: string;
  let originalFetch: typeof globalThis.fetch;

  const TICKET_KEY = "linear-AI-1560";
  const AGENT_ID = "tdd";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
    process.env.SESSION_END_SECRET = "test-secret";
    process.env.LINEAR_OAUTH_TOKEN = "test-token";
    process.env.ADMIN_SECRET = "admin-secret";
    dbPath = tempDb("ac5");
    ({ app, bag, sessionTracker, operationalEventStore } = createApp({ bagDbPath: dbPath }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SESSION_END_SECRET;
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.ADMIN_SECRET;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("engagement-thinking flip is recorded in operational event store after pull-ack", async () => {
    // FAILS: no /pull-ack endpoint; no engagement-thinking outcome in store.
    const { fetch } = makeLinearFetchMock({
      issueId: "issue-uuid",
      teamId: "team-uuid",
      stateName: "To Do",
      stateId: SEMANTIC_TO_UUID["To Do"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await request(app)
      .post("/pull-ack")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID, ticketId: "AI-1560" }));

    await new Promise((r) => setTimeout(r, 50));

    // FAILS: "engagement-thinking" outcome does not exist
    const events = operationalEventStore?.query({ key: TICKET_KEY, outcome: "engagement-thinking" as never });
    expect(events?.length).toBeGreaterThanOrEqual(1);
    const evt = events?.[0];
    expect(evt?.agent).toBe(AGENT_ID);
  });

  it("engagement-todo flip is recorded in operational event store after session-end", async () => {
    // FAILS: "engagement-todo" outcome does not exist in operational event store.
    const { fetch } = makeLinearFetchMock({
      issueId: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    sessionTracker.startSession(AGENT_ID, TICKET_KEY);

    await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID }));

    await new Promise((r) => setTimeout(r, 50));

    // FAILS: "engagement-todo" outcome does not exist
    const events = operationalEventStore?.query({ key: TICKET_KEY, outcome: "engagement-todo" as never });
    expect(events?.length).toBeGreaterThanOrEqual(1);
    expect(events?.[0]?.agent).toBe(AGENT_ID);
  });

  it("GET /admin/api/engagement/:ticketId returns last engagement event for the ticket", async () => {
    // FAILS: no /admin/api/engagement/:ticketId endpoint exists.
    const { fetch } = makeLinearFetchMock({
      issueId: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    sessionTracker.startSession(AGENT_ID, TICKET_KEY);

    // Trigger an engagement event via session-end
    await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: AGENT_ID }));

    await new Promise((r) => setTimeout(r, 50));

    // Query the observability endpoint
    const res = await request(app)
      .get("/admin/api/engagement/AI-1560")
      .set("x-admin-secret", "admin-secret");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ticketId: "AI-1560",
      lastEvent: expect.objectContaining({
        semantic: "todo",
        agentId: AGENT_ID,
      }),
    });
  });

  it("GET /admin/api/engagement/:ticketId returns 404 for a ticket with no engagement history", async () => {
    // FAILS: endpoint does not exist → expect 404 (but for the right reason)
    const res = await request(app)
      .get("/admin/api/engagement/AI-9999")
      .set("x-admin-secret", "admin-secret");

    // 404 from the missing endpoint is the wrong 404 — we want a 404 that means
    // "ticket found but no engagement history." Once the endpoint exists, this test
    // passes when there's genuinely no history; for now it fails for the right reason.
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ticketId: "AI-9999" });
  });
});
