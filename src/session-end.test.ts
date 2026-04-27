/**
 * /session-end endpoint tests.
 *
 * Tests auth via x-session-end-secret header, body parsing, re-signal logic.
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

describe("POST /session-end", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;

  beforeEach(() => {
    process.env.SESSION_END_SECRET = "test-secret-123";
    dbPath = tempDb();
    ({ app, bag, sessionTracker } = createApp({ bagDbPath: dbPath }));
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
    const { app: noAuthApp, bag: b, sessionTracker: st } = createApp({ bagDbPath: db2 });

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
