import { PendingWorkBag } from "./pending-work-bag.js";
import fs from "fs";
import os from "os";
import path from "path";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bag-test-"));
  return path.join(dir, "test.db");
}

describe("PendingWorkBag", () => {
  let bag: PendingWorkBag;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    bag = new PendingWorkBag(dbPath, 60_000);
  });

  afterEach(() => {
    bag.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("add and retrieve tickets", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("charles", "AI-492", "Issue");

    const tickets = bag.getPendingTickets("charles");
    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.ticketId)).toContain("AI-491");
    expect(tickets.map((t) => t.ticketId)).toContain("AI-492");
  });

  test("dedup: adding same ticket twice does not create duplicate", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("charles", "AI-491", "Comment");

    const tickets = bag.getPendingTickets("charles");
    expect(tickets).toHaveLength(1);
    // Should update event type to latest
    expect(tickets[0].eventType).toBe("Comment");
  });

  test("per-agent isolation", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("igor", "AI-491", "Issue");

    expect(bag.getPendingTickets("charles")).toHaveLength(1);
    expect(bag.getPendingTickets("igor")).toHaveLength(1);
  });

  test("clearAgent removes all tickets for agent", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("charles", "AI-492", "Issue");
    bag.add("igor", "AI-491", "Issue");

    const removed = bag.clearAgent("charles");
    expect(removed).toBe(2);
    expect(bag.getPendingTickets("charles")).toHaveLength(0);
    expect(bag.getPendingTickets("igor")).toHaveLength(1);
  });

  test("removeTicket removes specific ticket", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("charles", "AI-492", "Issue");

    expect(bag.removeTicket("charles", "AI-491")).toBe(true);
    expect(bag.getPendingTickets("charles")).toHaveLength(1);
    expect(bag.getPendingTickets("charles")[0].ticketId).toBe("AI-492");
  });

  test("agentsWithPendingWork returns distinct agent IDs", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("igor", "AI-491", "Issue");
    bag.add("igor", "AI-492", "Issue");

    const agents = bag.agentsWithPendingWork();
    expect(agents.sort()).toEqual(["charles", "igor"]);
  });

  test("metrics track events and signals", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("charles", "AI-491", "Comment"); // coalesced but still counted
    bag.recordSignal();

    const stats = bag.getStats();
    expect(stats.eventsReceived).toBe(2);
    expect(stats.signalsSent).toBe(1);
    expect(stats.bagSize).toBe(1); // deduped
  });

  test("getAgentStats returns per-agent counts", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("charles", "AI-492", "Issue");
    bag.add("igor", "AI-491", "Issue");

    const stats = bag.getAgentStats();
    const charles = stats.find((s) => s.agentId === "charles");
    const igor = stats.find((s) => s.agentId === "igor");
    expect(charles?.pendingCount).toBe(2);
    expect(igor?.pendingCount).toBe(1);
  });

  test("TTL prunes expired entries", async () => {
    // SQLite datetime('now') has second-level precision.
    // Both the INSERT's updated_at and the JS cutoff truncate to whole seconds.
    // We need to wait >2s so that cutoff's second is strictly after updated_at's second.
    const shortBag = new PendingWorkBag(dbPath, 1000);
    shortBag.add("charles", "AI-491", "Issue");

    await new Promise((r) => setTimeout(r, 2100));

    const tickets = shortBag.getPendingTickets("charles");
    expect(tickets).toHaveLength(0);
    shortBag.close();
  });

  test("add returns true for new entry, false for coalesced update", () => {
    const result1 = bag.add("charles", "AI-491", "Issue");
    expect(result1).toBe(true);
    const result2 = bag.add("charles", "AI-491", "Comment");
    expect(result2).toBe(false); // coalesced
  });

  test("empty bag returns empty array", () => {
    expect(bag.getPendingTickets("charles")).toHaveLength(0);
    expect(bag.agentsWithPendingWork()).toHaveLength(0);
  });

  test("signal-on-empty: agentsWithPendingWork returns empty after clearing", () => {
    bag.add("charles", "AI-491", "Issue");
    bag.add("igor", "AI-492", "Issue");

    bag.clearAgent("charles");
    expect(bag.agentsWithPendingWork()).toEqual(["igor"]);

    bag.clearAgent("igor");
    expect(bag.agentsWithPendingWork()).toHaveLength(0);
  });
});
