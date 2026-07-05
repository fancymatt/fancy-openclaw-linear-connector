/**
 * AI-1799 AC4 — Read API: /api/board serving the mirror joined with wake status.
 *
 * AC4: Read API returns enrolled tickets with current state, delegate,
 *      time-in-state, and latest wake_id status; terminal tickets included
 *      with terminal flag; verified by integration test.
 *
 * Integration test: goes through the real Express app (createApp) using
 * supertest, hitting the /api/board endpoint exactly as the board frontend
 * would.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-1799-board-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

function getMirror(app: ReturnType<typeof createApp>): EnrolledTicketsStore {
  const mirror = (app as unknown as { enrolledTicketsStore?: EnrolledTicketsStore }).enrolledTicketsStore;
  if (!mirror) throw new Error("enrolledTicketsStore not exposed on createApp return");
  return mirror;
}

const ADMIN_SECRET = "board-test-secret";

describe("AI-1799 AC4: GET /api/board — enrolled-tickets read API", () => {
  let app: ReturnType<typeof createApp>;
  let mirrorDbPath: string;
  let eventsDbPath: string;
  let mirror: EnrolledTicketsStore;

  beforeEach(() => {
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
  });

  it("returns an enrolled ticket with state, delegate, workflow, and terminal flag", async () => {
    mirror.enroll({ ticketId: "AI-5001", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.tickets).toBeDefined();
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-5001");
    expect(ticket).toBeDefined();
    expect(ticket.workflow).toBe("dev-impl");
    expect(ticket.state).toBe("write-tests");
    expect(ticket.delegate).toBe("tdd");
    expect(ticket.terminal).toBe(0);
  });

  it("returns time-in-state (entered_state_at relative to now)", async () => {
    mirror.enroll({ ticketId: "AI-5002", workflow: "dev-impl", state: "implementation", delegate: "igor" });

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-5002");
    expect(ticket).toBeDefined();
    expect(ticket.entered_state_at).toBeDefined();
    // time_in_state_ms should be a non-negative number
    expect(typeof ticket.time_in_state_ms).toBe("number");
    expect(ticket.time_in_state_ms).toBeGreaterThanOrEqual(0);
  });

  it("includes terminal tickets with the terminal flag set", async () => {
    mirror.enroll({ ticketId: "AI-5003", workflow: "dev-impl", state: "done", delegate: "ai" });
    mirror.markTerminal("AI-5003", "complete");

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-5003");
    expect(ticket).toBeDefined();
    expect(ticket.terminal).toBe(1);
  });

  it("returns latest wake_id status for each enrolled ticket", async () => {
    mirror.enroll({ ticketId: "AI-5004", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    // Write an operational event with a wake_id for this ticket
    const opsStore = (app as unknown as { operationalEventStore: { append: (input: unknown) => void } }).operationalEventStore;
    opsStore.append({
      outcome: "routed",
      type: "Issue",
      agent: "tdd",
      key: "linear-AI-5004",
      wakeId: "wake-board-001",
      plane: "connector",
    });

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-5004");
    expect(ticket).toBeDefined();
    expect(ticket.latest_wake_id).toBeDefined();
    // The latest wake_id should match the event we wrote
    expect(ticket.latest_wake_id).toBe("wake-board-001");
  });

  it("returns an empty tickets array when nothing is enrolled (not an error)", async () => {
    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.tickets).toEqual([]);
  });

  it("returns multiple enrolled tickets", async () => {
    mirror.enroll({ ticketId: "AI-5005", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });
    mirror.enroll({ ticketId: "AI-5006", workflow: "dev-impl", state: "implementation", delegate: "igor" });
    mirror.enroll({ ticketId: "AI-5007", workflow: "vocab-image", state: "briefing", delegate: "caspar" });

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(3);
    const ids = res.body.tickets.map((t: { ticket_id: string }) => t.ticket_id);
    expect(ids).toEqual(expect.arrayContaining(["AI-5005", "AI-5006", "AI-5007"]));
  });

  it("reflects a state transition in the read API output", async () => {
    mirror.enroll({ ticketId: "AI-5008", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });
    mirror.recordTransition({ ticketId: "AI-5008", toState: "implementation", delegate: "igor", eventKind: "tests-ready" });

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-5008");
    expect(ticket.state).toBe("implementation");
    expect(ticket.delegate).toBe("igor");
  });
});
