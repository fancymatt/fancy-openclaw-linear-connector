/**
 * AI-2142 — GET /admin/api/dispatches filterable dispatch history.
 *
 * Tests the flat dispatch list from the ack tracker with optional
 * agent/outcome/limit query params.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createApp } from "./index.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai2142-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

const ADMIN_SECRET = "ai2142-test-secret";

describe("AI-2142: GET /admin/api/dispatches — filterable dispatch history", () => {
  let app: ReturnType<typeof createApp>;
  let bagDbPath: string;
  let mirrorDbPath: string;
  let eventsDbPath: string;

  beforeEach(() => {
    resetWorkflowCache();
    bagDbPath = tmpDbPath("bag");
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.WORKFLOW_DEFS_DIR = path.resolve(__dirname, "__fixtures__");
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    resetWorkflowCache();
    fs.rmSync(path.dirname(bagDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
  });

  /**
   * Seed the ack tracker with a known set of dispatches for filtering tests.
   * normalizeSessionKey strips "linear-" and uppercases, so "linear-AI-1001"
   * is stored as "linear-AI-1001" (it re-adds the prefix).
   */
  function seedDispatches(ackTracker: import("./bag/dispatch-ack-tracker.js").DispatchAckTracker) {
    ackTracker.recordDispatch("igor", "linear-AI-1001");
    ackTracker.recordDispatch("igor", "linear-AI-1002");
    ackTracker.recordDispatch("grover", "linear-AI-1003");
    ackTracker.acknowledge("igor", "linear-AI-1001");
    ackTracker.markEscalated("grover", "linear-AI-1003");
  }

  it("AC1: GET /api/dispatches returns recent dispatches (no filter)", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    seedDispatches(app.ackTracker!);

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches).toBeDefined();
    expect(Array.isArray(res.body.dispatches)).toBe(true);
    expect(res.body.dispatches.length).toBe(3);
    for (const d of res.body.dispatches) {
      expect(d.agentId).toBeDefined();
      expect(d.ticketId).toBeDefined();
      expect(d.dispatchedAt).toBeDefined();
      expect(d.lastSignalAt).toBeDefined();
      expect(d.ackStatus).toBeDefined();
      expect(d.attemptCount).toBeDefined();
    }
  });

  it("AC2: ?agent=igor filters to that agent's dispatches", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    seedDispatches(app.ackTracker!);

    const res = await request(app.app)
      .get("/admin/api/dispatches?agent=igor")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches.length).toBe(2);
    for (const d of res.body.dispatches) {
      expect(d.agentId).toBe("igor");
    }
  });

  it("AC3: ?outcome=acknowledged filters by ack status", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    seedDispatches(app.ackTracker!);

    const res = await request(app.app)
      .get("/admin/api/dispatches?outcome=acknowledged")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches.length).toBe(1);
    expect(res.body.dispatches[0].ticketId).toBe("linear-AI-1001");
    expect(res.body.dispatches[0].ackStatus).toBe("acknowledged");
  });

  it("AC4: Combined ?agent=grover&outcome=escalated works", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    seedDispatches(app.ackTracker!);

    const res = await request(app.app)
      .get("/admin/api/dispatches?agent=grover&outcome=escalated")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches.length).toBe(1);
    expect(res.body.dispatches[0].agentId).toBe("grover");
    expect(res.body.dispatches[0].ackStatus).toBe("escalated");
    expect(res.body.dispatches[0].ticketId).toBe("linear-AI-1003");
  });

  it("AC5: ?limit=5 works", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    // Seed 10 dispatches
    for (let i = 0; i < 10; i++) {
      app.ackTracker!.recordDispatch("igor", `linear-AI-20${i}`);
    }

    const res = await request(app.app)
      .get("/admin/api/dispatches?limit=5")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches.length).toBe(5);
  });

  it("AC6: Returns empty array (not error) for agent with no dispatches", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    seedDispatches(app.ackTracker!);

    const res = await request(app.app)
      .get("/admin/api/dispatches?agent=nonexistent-agent")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches).toEqual([]);
  });

  it("ignores invalid outcome filter param gracefully", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    seedDispatches(app.ackTracker!);

    const res = await request(app.app)
      .get("/admin/api/dispatches?outcome=invalid-status")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // Invalid outcome is ignored → returns all dispatches
    expect(res.body.dispatches.length).toBe(3);
  });

  it("requires authentication", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches");

    expect(res.status).toBe(401);
  });
});
