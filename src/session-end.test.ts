/**
 * /session-end endpoint tests.
 *
 * Tests auth via x-session-end-secret header, body parsing, re-signal logic,
 * and AI-1533 hold-retry behavior.
 */

import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { createApp } from "./index.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-test-"));
  return path.join(dir, "test.db");
}

/** Fast no-op sendWakeUp for tests — avoids hitting the live hooks URL. */
const noopSendWakeUp = async (_agentId: string, _ticketIds: string[]): Promise<void> => {};

describe("POST /session-end", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;

  beforeEach(() => {
    process.env.SESSION_END_SECRET = "test-secret-123";
    dbPath = tempDb();
    ({ app, bag, sessionTracker } = createApp({ bagDbPath: dbPath, sendWakeUp: noopSendWakeUp }));
  });

  afterEach(() => {
    delete process.env.SESSION_END_SECRET;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("returns 400 when agentId missing", async () => {
    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret-123")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentId/i);
  });

  test("returns pendingTickets: 0 when no pending", async () => {
    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret-123")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pendingTickets).toBe(0);
  });

  test("returns pendingTickets > 0 when signals queued", async () => {
    sessionTracker.startSession("igor", "session-1");
    sessionTracker.queueSignal("igor", ["AI-100", "AI-101"]);

    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret-123")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pendingTickets).toBe(2);
  });

  test("returns 401 when auth header missing", async () => {
    const res = await request(app)
      .post("/session-end")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));
    expect(res.status).toBe(401);
  });

  test("returns 401 when auth wrong", async () => {
    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "wrong-secret")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));
    expect(res.status).toBe(401);
  });

  test("skips auth when SESSION_END_SECRET not set", async () => {
    delete process.env.SESSION_END_SECRET;
    const db2 = tempDb();
    const { app: noAuthApp, bag: b, sessionTracker: st } = createApp({ bagDbPath: db2, sendWakeUp: noopSendWakeUp });

    const res = await request(noAuthApp)
      .post("/session-end")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));
    expect(res.status).toBe(200);

    b.close();
    st.close();
    fs.rmSync(path.dirname(db2), { recursive: true, force: true });
  });
});

// ── AI-1533: Hold-retry integration tests ──────────────────────────────────

describe("POST /session-end — hold-retry (AI-1533)", () => {
  let dispatched: Array<{ agentId: string; ticketIds: string[] }>;
  let appCtx: ReturnType<typeof createApp>;
  let dbPath: string;

  beforeEach(() => {
    process.env.SESSION_END_SECRET = "test-secret-123";
    dispatched = [];
    dbPath = tempDb();
    appCtx = createApp({
      bagDbPath: dbPath,
      operationalEventsDbPath: path.join(path.dirname(dbPath), "operational-events.db"),
      sendWakeUp: async (agentId, ticketIds) => {
        dispatched.push({ agentId, ticketIds });
      },
    });
  });

  afterEach(() => {
    delete process.env.SESSION_END_SECRET;
    appCtx.bag.close();
    appCtx.sessionTracker.close();
    appCtx.operationalEventStore.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function sessionEnd(agentId: string) {
    return request(appCtx.app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret-123")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId }));
  }

  test("held-run-then-retry: re-dispatches when session ends with no transition", async () => {
    appCtx.sessionTracker.startSession("igor", "linear-AI-1531");
    appCtx.ackTracker.recordDispatch("igor", "linear-AI-1531");

    const res = await sessionEnd("igor");
    expect(res.status).toBe(200);
    expect(res.body.pendingTickets).toBe(1);
    expect(dispatched.some((d) => d.agentId === "igor" && d.ticketIds.includes("linear-AI-1531"))).toBe(true);
    expect(appCtx.holdRetryTracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(1);

    const events = appCtx.operationalEventStore.query({ outcome: "hold-retry-dispatch" });
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe("igor");
    expect(events[0].key).toBe("linear-AI-1531");
  });

  test("healthy-run-no-retry: does NOT re-dispatch when a transition was seen", async () => {
    appCtx.sessionTracker.startSession("igor", "linear-AI-1531");
    appCtx.ackTracker.recordDispatch("igor", "linear-AI-1531");
    // Simulate agent-authored Linear activity (webhook callback)
    appCtx.holdRetryTracker.recordTransition("igor", "linear-AI-1531");

    const res = await sessionEnd("igor");
    expect(res.status).toBe(200);
    // No hold-retry dispatch — only the regular "0 pending" response
    expect(res.body.pendingTickets).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(appCtx.holdRetryTracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(0);

    const events = appCtx.operationalEventStore.query({ outcome: "hold-retry-dispatch" });
    expect(events).toHaveLength(0);
  });

  test("max-attempts-then-fail: stops retrying after maxAttempts exhausted", async () => {
    // Exhaust maxAttempts (default 2)
    appCtx.holdRetryTracker.incrementHoldAttempt("igor", "linear-AI-1531");
    appCtx.holdRetryTracker.incrementHoldAttempt("igor", "linear-AI-1531");

    appCtx.sessionTracker.startSession("igor", "linear-AI-1531");
    appCtx.ackTracker.recordDispatch("igor", "linear-AI-1531");

    const res = await sessionEnd("igor");
    expect(res.status).toBe(200);
    expect(res.body.pendingTickets).toBe(0);
    expect(dispatched).toHaveLength(0); // No re-dispatch after max attempts

    const events = appCtx.operationalEventStore.query({ outcome: "hold-retry-dispatch" });
    expect(events).toHaveLength(0);
  });

  test("transition-clears-retry-state: healthy run resets attempt count for next dispatch", async () => {
    // Simulate a prior hold that used up 1 attempt
    appCtx.holdRetryTracker.incrementHoldAttempt("igor", "linear-AI-1531");
    expect(appCtx.holdRetryTracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(1);

    // Healthy run: transition seen
    appCtx.sessionTracker.startSession("igor", "linear-AI-1531");
    appCtx.ackTracker.recordDispatch("igor", "linear-AI-1531");
    appCtx.holdRetryTracker.recordTransition("igor", "linear-AI-1531");

    await sessionEnd("igor");

    // Attempt count should be reset
    expect(appCtx.holdRetryTracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(0);

    // Next dispatch can retry from scratch
    dispatched = [];
    appCtx.sessionTracker.startSession("igor", "linear-AI-1531");
    appCtx.ackTracker.recordDispatch("igor", "linear-AI-1531");

    const res2 = await sessionEnd("igor");
    expect(res2.body.pendingTickets).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(appCtx.holdRetryTracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(1);
  });

  test("normalization-mismatch: healthy run clears state even when session key is unnormalized", async () => {
    // sessionTracker may store an unnormalized key (e.g. "AI-1531") while
    // recordTransition is called with the normalized form ("linear-AI-1531").
    // Without normalizeSessionKey in the state-update loop, hasTransition returns
    // false → a healthy run looks like a hold and triggers a spurious retry.
    appCtx.sessionTracker.startSession("igor", "AI-1531");
    appCtx.ackTracker.recordDispatch("igor", "linear-AI-1531");
    // Transition recorded with normalized key (the form onAgentActivity uses).
    appCtx.holdRetryTracker.recordTransition("igor", "linear-AI-1531");

    const res = await sessionEnd("igor");
    expect(res.status).toBe(200);
    // Healthy run — no re-dispatch.
    expect(res.body.pendingTickets).toBe(0);
    expect(dispatched).toHaveLength(0);
    // Attempt count must be 0 (cleared, not preserved).
    expect(appCtx.holdRetryTracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(0);
  });
});
