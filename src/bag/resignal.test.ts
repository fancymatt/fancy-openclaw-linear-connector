import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { resignalPendingTickets } from "./resignal.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resignal-bag-test-"));
  return path.join(dir, "test.db");
}

describe("resignalPendingTickets", () => {
  let dbPath: string;
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;
  const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

  beforeEach(() => {
    dbPath = tempDb();
    bag = new PendingWorkBag(dbPath, 60_000);
    sessionTracker = new SessionTracker(30_000);
  });

  afterEach(() => {
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("prunes completed stale pending tickets before dispatch", async () => {
    bag.add("igor", "AI-501", "Issue");
    bag.add("igor", "AI-597", "Issue");
    sessionTracker.startSession("igor", "linear-AI-500");
    sessionTracker.queueSignal("igor", ["linear-AI-501", "linear-AI-597"]);
    sessionTracker.endSession("igor");

    const sentTickets: string[] = [];
    const results = await resignalPendingTickets("igor", ["AI-501", "AI-597"], bag, sessionTracker, wakeConfig, {
      markActive: true,
      isTicketActionable: (ticketId) => ticketId !== "linear-AI-501",
      sendWakeUp: async (_agentId, ticketIds) => {
        sentTickets.push(...ticketIds);
      },
    });

    expect(results.length).toBe(1);
    expect(results[0].dispatched).toBe(true);
    expect(results[0].ticketId).toBe("linear-AI-597");
    expect(sentTickets).toEqual(["linear-AI-597"]);
    const remaining = bag.getPendingTickets("igor");
    expect(remaining).toHaveLength(1); // dispatched ticket stays in bag until session-end
    expect(remaining[0].ticketId).toBe("linear-AI-597");
    expect(bag.getStats().signalsSent).toBe(1);
    expect(sessionTracker.getActiveSessionKey("igor")).toBe("linear-AI-597");
  });
});
