/**
 * AI-1800 AC4 → AI-2142: Dispatches endpoint now returns a flat filterable
 * list from the ack tracker, replacing the old wake_id-grouped cycles view.
 *
 * Tests the response structure matches the new flat dispatch format.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1800-dispatch-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

const ADMIN_SECRET = "ai1800-dispatch-test";

describe("AI-2142: GET /api/dispatches — flat dispatch list (replaces cycles view)", () => {
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

  it("GET /api/dispatches returns a flat dispatches array", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.dispatches).toBeDefined();
    expect(Array.isArray(res.body.dispatches)).toBe(true);
  });

  it("response does not use old cycles-grouped format", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // Must NOT contain old cycles-grouped structure
    expect(res.body.cycles).toBeUndefined();
    // The response must NOT contain a flat 'tasks' array at the top level
    expect(res.body.tasks).toBeUndefined();
  });

  it("each dispatch entry has expected fields", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });
    app.ackTracker!.recordDispatch("test-agent", "linear-AI-9999");

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    if (res.body.dispatches.length > 0) {
      const d = res.body.dispatches[0];
      expect(d.agentId).toBeDefined();
      expect(d.ticketId).toBeDefined();
      expect(d.dispatchedAt).toBeDefined();
      expect(d.lastSignalAt).toBeDefined();
      expect(d.ackStatus).toBeDefined();
      expect(d.attemptCount).toBeDefined();
    }
  });
});
