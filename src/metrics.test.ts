/**
 * /metrics endpoint tests.
 *
 * Tests that metrics return data with shared-secret auth.
 */

import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { createApp } from "./index.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  return path.join(dir, "test.db");
}

describe("GET /metrics", () => {
  let app: ReturnType<typeof createApp>["app"];
  let bag: ReturnType<typeof createApp>["bag"];
  let sessionTracker: ReturnType<typeof createApp>["sessionTracker"];
  let dbPath: string;

  beforeEach(() => {
    process.env.METRICS_SECRET = "metrics-test-secret";
    dbPath = tempDb();
    ({ app, bag, sessionTracker } = createApp({ bagDbPath: dbPath }));
  });

  afterEach(() => {
    delete process.env.METRICS_SECRET;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("returns bag stats and active sessions with valid secret", async () => {
    bag.add("igor", "AI-100", "Issue");
    sessionTracker.startSession("igor", "session-1");

    const res = await request(app)
      .get("/metrics")
      .set("x-metrics-secret", "metrics-test-secret");
    expect(res.status).toBe(200);
    expect(res.body.bag).toBeDefined();
    expect(res.body.bag.eventsReceived).toBe(1);
    expect(res.body.bag.bagSize).toBe(1);
    expect(res.body.agentStats).toBeDefined();
    expect(res.body.activeSessions).toContain("igor");
  });

  test("returns empty stats when nothing queued", async () => {
    const res = await request(app)
      .get("/metrics")
      .set("x-metrics-secret", "metrics-test-secret");
    expect(res.status).toBe(200);
    expect(res.body.bag.bagSize).toBe(0);
    expect(res.body.activeSessions).toEqual([]);
  });

  test("returns 401 when secret missing", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(401);
  });

  test("returns 401 when secret wrong", async () => {
    const res = await request(app)
      .get("/metrics")
      .set("x-metrics-secret", "wrong-secret");
    expect(res.status).toBe(401);
  });

  test("skips auth when METRICS_SECRET not set", async () => {
    delete process.env.METRICS_SECRET;
    delete process.env.SESSION_END_SECRET;
    const db2 = tempDb();
    const { app: noAuthApp, bag: b, sessionTracker: st } = createApp({ bagDbPath: db2 });

    const res = await request(noAuthApp).get("/metrics");
    expect(res.status).toBe(200);

    b.close();
    st.close();
    fs.rmSync(path.dirname(db2), { recursive: true, force: true });
  });
});
