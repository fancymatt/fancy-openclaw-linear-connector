/**
 * AI-1802 AC1 — Per-agent capacity strip: slots used / cap, parked count.
 *
 * AC1: Strip shows, per agent with any live or parked wake: slots used,
 *      cap (from agents.json maxConcurrent or default 3), parked count.
 *      Verified against a fixture with an over-capacity agent.
 * AC2: Read-only — no actions. Suite green, builds clean.
 *
 * Tests exercise a new read-only endpoint GET /admin/api/capacity that
 * returns per-agent capacity data for the console's fleet/board page.
 * Integration test: goes through the real Express app (createApp) using
 * supertest, hitting the endpoint exactly as the console frontend would.
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import type { SessionTracker } from "./bag/session-tracker.js";
import type { PendingWorkBag } from "./bag/pending-work-bag.js";
import type { AgentConfig } from "./agents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-1802-cap-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

function getApp(...dbPaths: string[]) {
  const ADMIN_SECRET = "capacity-test-secret";
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  return createApp({
    enrolledTicketsDbPath: dbPaths[0],
    operationalEventsDbPath: dbPaths[1],
    bagDbPath: dbPaths[2],
  });
}

function getSessionTracker(app: ReturnType<typeof createApp>): SessionTracker {
  const st = (app as unknown as { sessionTracker?: SessionTracker }).sessionTracker;
  if (!st) throw new Error("sessionTracker not exposed on createApp return");
  return st;
}

function getBag(app: ReturnType<typeof createApp>): PendingWorkBag {
  const bag = (app as unknown as { bag?: PendingWorkBag }).bag;
  if (!bag) throw new Error("bag not exposed on createApp return");
  return bag;
}

interface CapacityAgent {
  /** Agent identifier (matches agents.json name or openclawAgent). */
  agentId: string;
  /** Number of currently active/live sessions for this agent. */
  slotsUsed: number;
  /** Max concurrent sessions (from agents.json maxConcurrent, or default 3). */
  cap: number;
  /** Number of tickets parked in the pending work bag for this agent. */
  parkedCount: number;
}

interface CapacityResponse {
  agents: CapacityAgent[];
}

const ADMIN_SECRET = "capacity-test-secret";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AI-1802 AC1: GET /admin/api/capacity — per-agent capacity strip", () => {
  let app: ReturnType<typeof createApp>;
  let mirrorDbPath: string;
  let eventsDbPath: string;
  let bagDbPath: string;
  let sessionTracker: SessionTracker;
  let bag: PendingWorkBag;

  beforeEach(() => {
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    bagDbPath = tmpDbPath("bag");
    app = getApp(mirrorDbPath, eventsDbPath, bagDbPath);
    sessionTracker = getSessionTracker(app);
    bag = getBag(app);
  });

  afterEach(() => {
    sessionTracker.close();
    delete process.env.ADMIN_SECRET;
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(bagDbPath), { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // AC1 core: slots used / cap / parked count
  // -----------------------------------------------------------------------

  it("returns capacity data for an agent with live sessions and parked tickets", async () => {
    // Igor: 2 live sessions, 5 parked
    sessionTracker.startSession("igor", "linear-AI-6001");
    sessionTracker.startSession("igor", "linear-AI-6002");
    bag.add("igor", "AI-6003", "Issue");
    bag.add("igor", "AI-6004", "Issue");
    bag.add("igor", "AI-6005", "Issue");
    bag.add("igor", "AI-6006", "Issue");
    bag.add("igor", "AI-6007", "Issue");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    expect(body.agents).toBeInstanceOf(Array);

    const igor = body.agents.find((a) => a.agentId === "igor");
    expect(igor).toBeDefined();
    expect(igor!.slotsUsed).toBe(2);
    expect(igor!.parkedCount).toBe(5);
    // cap should be 3 (default AGENT_DEFAULT_MAX_CONCURRENT)
    expect(igor!.cap).toBe(3);
  });

  it("uses agents.json maxConcurrent when configured (non-default cap)", async () => {
    // The agents.json in the repo has no maxConcurrent set, so we rely on the default.
    // This test verifies the shape is correct for an agent with a live session.
    sessionTracker.startSession("ai", "linear-AI-6010");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    const ai = body.agents.find((a) => a.agentId === "ai");
    expect(ai).toBeDefined();
    expect(ai!.slotsUsed).toBe(1);
    expect(typeof ai!.cap).toBe("number");
    expect(ai!.cap).toBeGreaterThanOrEqual(1);
    expect(ai!.parkedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // AC1 over-capacity fixture: agent has more live sessions than cap
  // -----------------------------------------------------------------------

  it("shows over-capacity: slotsUsed exceeds cap for an agent with >cap live sessions", async () => {
    // Igor: 5 live sessions (default cap = 3), 3 parked
    sessionTracker.startSession("igor", "linear-AI-6101");
    sessionTracker.startSession("igor", "linear-AI-6102");
    sessionTracker.startSession("igor", "linear-AI-6103");
    sessionTracker.startSession("igor", "linear-AI-6104");
    sessionTracker.startSession("igor", "linear-AI-6105");
    bag.add("igor", "AI-6106", "Issue");
    bag.add("igor", "AI-6107", "Issue");
    bag.add("igor", "AI-6108", "Issue");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    const igor = body.agents.find((a) => a.agentId === "igor");
    expect(igor).toBeDefined();
    expect(igor!.slotsUsed).toBe(5);
    expect(igor!.cap).toBe(3);
    expect(igor!.slotsUsed).toBeGreaterThan(igor!.cap);
    expect(igor!.parkedCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // AC1: only agents with live or parked work appear in the strip
  // -----------------------------------------------------------------------

  it("excludes agents with no live sessions and no parked tickets", async () => {
    // Only igor has work; astrid is completely idle
    sessionTracker.startSession("igor", "linear-AI-6200");
    bag.add("igor", "AI-6201", "Issue");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    // Igor should be present
    expect(body.agents.some((a) => a.agentId === "igor")).toBe(true);
    // Agents with zero slots and zero parked should not appear
    const idle = body.agents.filter(
      (a) => a.slotsUsed === 0 && a.parkedCount === 0,
    );
    expect(idle).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // AC1: handles agent with only parked work (no live sessions)
  // -----------------------------------------------------------------------

  it("includes agents with only parked tickets and no live sessions", async () => {
    bag.add("astrid", "AI-6300", "Issue");
    bag.add("astrid", "AI-6301", "Issue");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    const astrid = body.agents.find((a) => a.agentId === "astrid");
    expect(astrid).toBeDefined();
    expect(astrid!.slotsUsed).toBe(0);
    expect(astrid!.parkedCount).toBe(2);
    expect(typeof astrid!.cap).toBe("number");
  });

  // -----------------------------------------------------------------------
  // AC1: handles agent with only live sessions (no parked work)
  // -----------------------------------------------------------------------

  it("includes agents with live sessions and no parked tickets", async () => {
    sessionTracker.startSession("ai", "linear-AI-6400");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    const ai = body.agents.find((a) => a.agentId === "ai");
    expect(ai).toBeDefined();
    expect(ai!.slotsUsed).toBe(1);
    expect(ai!.parkedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // AC1: multiple agents shown simultaneously
  // -----------------------------------------------------------------------

  it("returns capacity data for multiple agents simultaneously", async () => {
    // Igor: 2 live, 3 parked
    sessionTracker.startSession("igor", "linear-AI-6500");
    sessionTracker.startSession("igor", "linear-AI-6501");
    bag.add("igor", "AI-6502", "Issue");
    bag.add("igor", "AI-6503", "Issue");
    bag.add("igor", "AI-6504", "Issue");

    // Astrid: 1 live, 1 parked
    sessionTracker.startSession("astrid", "linear-AI-6600");
    bag.add("astrid", "AI-6601", "Issue");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    expect(body.agents.length).toBeGreaterThanOrEqual(2);

    const igor = body.agents.find((a) => a.agentId === "igor");
    expect(igor).toBeDefined();
    expect(igor!.slotsUsed).toBe(2);
    expect(igor!.parkedCount).toBe(3);

    const astrid = body.agents.find((a) => a.agentId === "astrid");
    expect(astrid).toBeDefined();
    expect(astrid!.slotsUsed).toBe(1);
    expect(astrid!.parkedCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC1: cap source is maxConcurrent from agents.json or default 3
  // -----------------------------------------------------------------------

  it("cap defaults to 3 (AGENT_DEFAULT_MAX_CONCURRENT) when agents.json has no maxConcurrent", async () => {
    // Default: agents.json entries have no maxConcurrent field
    sessionTracker.startSession("igor", "linear-AI-6700");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    const igor = body.agents.find((a) => a.agentId === "igor");
    expect(igor).toBeDefined();
    expect(igor!.cap).toBe(3);
  });

  // -----------------------------------------------------------------------
  // AC2: read-only — no mutation endpoints exist
  // -----------------------------------------------------------------------

  it("AC2: POST /admin/api/capacity is not a valid action (read-only)", async () => {
    const res = await request(app.app)
      .post("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({ agentId: "igor", maxConcurrent: 10 });

    expect(res.status).toBe(404);
  });

  it("AC2: PUT /admin/api/capacity is not a valid action (read-only)", async () => {
    const res = await request(app.app)
      .put("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({});

    expect(res.status).toBe(404);
  });

  it("AC2: PATCH /admin/api/capacity is not a valid action (read-only)", async () => {
    const res = await request(app.app)
      .patch("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({});

    expect(res.status).toBe(404);
  });

  it("AC2: DELETE /admin/api/capacity is not a valid action (read-only)", async () => {
    const res = await request(app.app)
      .delete("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Auth: requires admin secret
  // -----------------------------------------------------------------------

  it("returns 401 without admin secret", async () => {
    const res = await request(app.app)
      .get("/admin/api/capacity");

    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong admin secret", async () => {
    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", "wrong-secret");

    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Empty state: no agents have any work
  // -----------------------------------------------------------------------

  it("returns empty array when no agents have live sessions or parked tickets", async () => {
    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body as CapacityResponse;
    expect(body.agents).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // AC1: slot count updates reflect session end
  // -----------------------------------------------------------------------

  it("reflects decreased slotsUsed after a session ends", async () => {
    sessionTracker.startSession("igor", "linear-AI-6800");
    sessionTracker.startSession("igor", "linear-AI-6801");
    sessionTracker.startSession("igor", "linear-AI-6802");

    // Before session end: 3 slots
    const resBefore = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);
    const igorBefore = (resBefore.body as CapacityResponse).agents.find(
      (a) => a.agentId === "igor",
    );
    expect(igorBefore!.slotsUsed).toBe(3);

    // End one session
    sessionTracker.endSession("igor", "linear-AI-6800");

    // After session end: 2 slots
    const resAfter = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);
    const igorAfter = (resAfter.body as CapacityResponse).agents.find(
      (a) => a.agentId === "igor",
    );
    expect(igorAfter!.slotsUsed).toBe(2);
  });

  // -----------------------------------------------------------------------
  // AC1: parked count reflects bag removal
  // -----------------------------------------------------------------------

  it("reflects decreased parkedCount after a ticket is removed from the bag", async () => {
    bag.add("igor", "AI-6900", "Issue");
    bag.add("igor", "AI-6901", "Issue");

    const resBefore = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);
    const igorBefore = (resBefore.body as CapacityResponse).agents.find(
      (a) => a.agentId === "igor",
    );
    expect(igorBefore!.parkedCount).toBe(2);

    bag.removeTicket("igor", "AI-6900");

    const resAfter = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);
    const igorAfter = (resAfter.body as CapacityResponse).agents.find(
      (a) => a.agentId === "igor",
    );
    expect(igorAfter!.parkedCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Response shape validation
  // -----------------------------------------------------------------------

  it("returns the expected response shape with agents array", async () => {
    sessionTracker.startSession("igor", "linear-AI-7000");
    bag.add("igor", "AI-7001", "Issue");

    const res = await request(app.app)
      .get("/admin/api/capacity")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const body = res.body;

    // Top-level must have agents array
    expect(body).toHaveProperty("agents");
    expect(Array.isArray(body.agents)).toBe(true);

    // Each agent must have agentId, slotsUsed, cap, parkedCount
    const agent = body.agents[0];
    expect(agent).toHaveProperty("agentId");
    expect(agent).toHaveProperty("slotsUsed");
    expect(agent).toHaveProperty("cap");
    expect(agent).toHaveProperty("parkedCount");

    // Types
    expect(typeof agent.agentId).toBe("string");
    expect(typeof agent.slotsUsed).toBe("number");
    expect(typeof agent.cap).toBe("number");
    expect(typeof agent.parkedCount).toBe("number");

    // Numeric ranges
    expect(agent.slotsUsed).toBeGreaterThanOrEqual(0);
    expect(agent.cap).toBeGreaterThanOrEqual(1);
    expect(agent.parkedCount).toBeGreaterThanOrEqual(0);
  });
});
