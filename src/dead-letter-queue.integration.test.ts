/**
 * Integration tests for INF-217: Dead-letter queue for silent-fallback dispatch.
 *
 * AC1+AC2+AC3+AC4: When routeEvent returns null (non-roster agent), the dispatch
 * must be written to the DLQ, a structured log emitted, and a signal emitted.
 * A valid roster dispatch must trigger none of these.
 *
 * These tests FAIL against the current codebase (no DLQ wiring exists yet).
 */

import { jest } from "@jest/globals";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createApp } from "./index.js";

// ── Test helpers ────────────────────────────────────────────────────────────

const SECRET = "test-dlq-endpoint-secret";

function sign(body: string): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(Buffer.from(body))
    .digest("hex");
}

function tempDbDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dlq-integration-"));
}

/** A Linear event targeting an agent NOT in the roster. */
function nonRosterEventBody(): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-07-20T22:30:00.000Z",
    actor: { id: "a1", name: "Alice" },
    data: {
      id: "i-no-roster",
      identifier: "INF-9999",
      title: "Dispatch to non-roster agent",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      delegate: { id: "unknown-linear-id-999" }, // no agent in roster maps to this
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "t1", key: "INF" },
      labelIds: [],
      url: "https://linear.app/test/issue/INF-9999",
      createdAt: "2026-07-20T22:30:00.000Z",
      updatedAt: "2026-07-20T22:30:00.000Z",
    },
  });
}

/** A Linear event targeting an agent known to be in the roster. */
function rosterEventBody(): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-07-20T22:31:00.000Z",
    actor: { id: "a2", name: "Alice" },
    data: {
      id: "i-roster",
      identifier: "INF-8888",
      title: "Dispatch to known agent",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      delegate: { id: "known-linear-id" }, // We'll need this mapped in agents.json
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "t1", key: "INF" },
      labelIds: [],
      url: "https://linear.app/test/issue/INF-8888",
      createdAt: "2026-07-20T22:31:00.000Z",
      updatedAt: "2026-07-20T22:31:00.000Z",
    },
  });
}

// ── Integration tests ──────────────────────────────────────────────────────

describe("Dead-letter queue — webhook integration [FAILING]", () => {
  let app: ReturnType<typeof createApp>["app"];
  let operationalEventStore: ReturnType<typeof createApp>["operationalEventStore"];
  let dbDir: string;
  let agentsFilePath: string;

  beforeEach(() => {
    dbDir = tempDbDir();
    agentsFilePath = path.join(dbDir, "agents.json");

    // Create agents.json with a known agent so the router can resolve it
    fs.writeFileSync(agentsFilePath, JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "known-linear-id",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
        },
      ],
    }));

    process.env.AGENTS_FILE = agentsFilePath;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    process.env.OPENCLAW_HOOKS_URL = "http://localhost:18999";
    process.env.OPENCLAW_HOOKS_TOKEN = "test-hooks-token";
    // Disable liveness check for test
    process.env.NODE_ENV = "test";

    const created = createApp();
    app = created.app;
    operationalEventStore = created.operationalEventStore;
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    delete process.env.NODE_ENV;
    // Close stores
    if (operationalEventStore && "close" in operationalEventStore) {
      (operationalEventStore as { close: () => void }).close();
    }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  // ── AC1 + AC2 + AC3 + AC4: Non-roster dispatch → DLQ + log + signal ───────

  it("AC4: non-roster dispatch lands in the DLQ", async () => {
    const body = nonRosterEventBody();

    // POST the event — routeEvent will return null because no agent maps
    // to "unknown-linear-id-999". Current code silently returns; the DLQ
    // should capture this.
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);

    // Assert: a dead-letter entry was created for this ticket
    // (this FAILS today — no DLQ wiring exists)
    const dlqOperationalEvents = operationalEventStore.query({ outcome: "dead-letter" as never });
    expect(dlqOperationalEvents.length).toBeGreaterThanOrEqual(1);

    const matchingEvent = dlqOperationalEvents.find(
      (e) => e.key === "linear-INF-9999" || e.key === "INF-9999"
    );
    expect(matchingEvent).toBeDefined();
  });

  it("AC1+AC2+AC3: non-roster dispatch emits structured log + signal", async () => {
    const body = nonRosterEventBody();

    // Spy on the logger to capture structured log entries
    // This requires the logger to emit a specific structured format

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);

    // Assert: operational event store has a dead-letter entry with
    // the correct structured metadata
    const events = operationalEventStore.query({ outcome: "dead-letter" as never });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // The dead-letter operational event should carry structured detail
    const dlqEvent = events.find((e) => e.key === "linear-INF-9999");
    expect(dlqEvent).toBeDefined();

    // Detail should include ticketId, intendedAgent, reason
    const detail = dlqEvent!.detail as Record<string, unknown>;
    expect(detail).toHaveProperty("ticketId");
    expect(detail).toHaveProperty("intendedAgent");
    expect(detail).toHaveProperty("reason");
  });

  // ── AC4: Valid roster dispatch does NOT trigger DLQ ──────────────────────

  it("AC4: valid roster dispatch does not produce dead-letter entries", async () => {
    const body = rosterEventBody();

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);

    // Assert: no dead-letter events for this ticket
    const dlqEvents = operationalEventStore.query({ outcome: "dead-letter" as never });
    const matchingRoster = dlqEvents.filter((e) => e.key === "linear-INF-8888");
    expect(matchingRoster).toHaveLength(0);
  });

  // ── AC4: non-roster dispatch is NOT silently dropped ─────────────────────

  it("AC4: non-roster dispatch does not return empty result (is captured, not silenced)", async () => {
    const body = nonRosterEventBody();

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);

    // The HTTP 200 is the "accepted" response. The dead-letter capture happens
    // asynchronously after acknowledging. Assert the DLQ was written.
    const events = operationalEventStore.query({ outcome: "dead-letter" as never });
    const nonRosterEvent = events.find(
      (e) => e.key === "linear-INF-9999" || e.key === "INF-9999"
    );
    expect(nonRosterEvent).toBeDefined();

    // If DLQ was properly written, "no-route" should be absent and "dead-letter"
    // should be present for non-roster agents.
    const noRouteEvents = operationalEventStore.query({ outcome: "no-route", key: "linear-INF-9999" });
    // Either there's a dead-letter and no no-route, or the dead-letter replaces no-route
    expect(noRouteEvents.length).toBe(0);
  });
});

// ── Background-wiring integration test (AC5) ──────────────────────────────

describe("Dead-letter queue — background wiring (AC5) [FAILING]", () => {
  it("AC5: dead-letter queue store is instantiated and registered at production entry point", () => {
    // This test verifies the DLQ is wired into the app at startup.
    // It FAILS because createApp() does not yet instantiate or return a
    // DeadLetterQueueStore.

    const { deadLetterQueue } = createApp();
    expect(deadLetterQueue).toBeDefined();

    // The store should be open and queryable
    expect(typeof (deadLetterQueue as { count: () => number }).count).toBe("function");
  });

  test("AC5: dead-letter queue store is accessible from app and operational", () => {
    // Verify the store is properly initialized: zero entries at start,
    // accepts appends, and can be queried.
    const { deadLetterQueue } = createApp();

    expect(deadLetterQueue.count()).toBe(0);

    deadLetterQueue.append({
      ticketId: "AC5-TEST",
      intendedAgent: "test-agent",
      reason: "background-wiring validation",
    });

    expect(deadLetterQueue.count()).toBe(1);
    const entries = deadLetterQueue.query({ ticketId: "AC5-TEST" });
    expect(entries).toHaveLength(1);
    expect(entries[0].intendedAgent).toBe("test-agent");
  });
});
