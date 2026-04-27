/**
 * Session-end re-signal integration test.
 *
 * Tests the full cycle: session starts → events arrive (queued) →
 * session-end callback → re-signal fired → agent picks up pending tickets.
 */

import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { createApp } from "./index.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resignal-test-"));
  return path.join(dir, "test.db");
}

describe("Session-end re-signal cycle", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;

  beforeEach(() => {
    process.env.SESSION_END_SECRET = "test-secret-re";
    dbPath = tempDb();
    ({ app, bag, sessionTracker } = createApp({ bagDbPath: dbPath }));
  });

  afterEach(() => {
    delete process.env.SESSION_END_SECRET;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("full cycle: start → queue → session-end → re-signal", async () => {
    // 1. Simulate agent having an active session
    sessionTracker.startSession("igor", "session-1");

    // 2. Events arrive while session is active (signals get queued)
    bag.add("igor", "AI-500", "Issue");
    bag.add("igor", "AI-501", "Comment");
    sessionTracker.queueSignal("igor", ["AI-500", "AI-501"]);

    // Verify agent is active and bag has entries
    expect(sessionTracker.isActive("igor")).toBe(true);
    expect(bag.getPendingTickets("igor")).toHaveLength(2);

    // 3. Session ends — triggers re-signal
    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret-re")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pendingTickets).toBe(2);

    // Agent should no longer be in the old session (endSession was called)
    expect(sessionTracker.getActiveSessionKey("igor")).toBeNull();

    // Bag should be cleared (clearAgent called before re-signal)
    expect(bag.getPendingTickets("igor")).toHaveLength(0);

    // Signal count should be incremented
    const stats = bag.getStats();
    expect(stats.signalsSent).toBe(1);
  });

  test("session-end with no queued signals returns 0", async () => {
    sessionTracker.startSession("igor", "session-1");

    const res = await request(app)
      .post("/session-end")
      .set("x-session-end-secret", "test-secret-re")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "igor" }));

    expect(res.status).toBe(200);
    expect(res.body.pendingTickets).toBe(0);
  });
});
