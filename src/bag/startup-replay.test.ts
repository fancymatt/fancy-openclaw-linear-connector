import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { replayPendingBag } from "./startup-replay.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-replay-test-"));
  return path.join(dir, "test.db");
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

describe("replayPendingBag", () => {
  let dbPath: string;
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;

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

  test("no-op when bag is empty", async () => {
    const sentTickets: string[] = [];
    const result = await replayPendingBag(bag, sessionTracker, wakeConfig, undefined, {
      isTicketActionable: () => true,
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
      interAgentDelayMs: 0,
    });

    expect(sentTickets).toHaveLength(0);
    expect(result).toEqual({ agents: 0, replayed: 0, pruned: 0, skipped: 0 });
  });

  test("regression: queued pending row -> process restart -> startup emits wake-up", async () => {
    // Pre-restart: bag receives a pending delegation
    bag.add("igor", "AI-780", "Issue");
    bag.close();

    // Simulate process restart: new instances on the same persisted DB
    const bag2 = new PendingWorkBag(dbPath, 60_000);
    const sessionTracker2 = new SessionTracker(30_000);

    const sentTickets: string[] = [];
    const result = await replayPendingBag(bag2, sessionTracker2, wakeConfig, undefined, {
      isTicketActionable: () => true,
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
      interAgentDelayMs: 0,
    });

    expect(sentTickets).toEqual(["linear-AI-780"]);
    expect(result.replayed).toBe(1);
    expect(result.pruned).toBe(0);
    // Ticket stays in bag until session-end confirms processing
    expect(bag2.getPendingTickets("igor")).toHaveLength(1);

    bag2.close();
    sessionTracker2.close();
  });

  test("skips agents with an already-active session", async () => {
    bag.add("igor", "AI-781", "Issue");
    sessionTracker.startSession("igor", "linear-AI-781");

    const sentTickets: string[] = [];
    const result = await replayPendingBag(bag, sessionTracker, wakeConfig, undefined, {
      isTicketActionable: () => true,
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
      interAgentDelayMs: 0,
    });

    expect(sentTickets).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.replayed).toBe(0);
  });

  test("prunes non-actionable tickets and emits startup-pruned event", async () => {
    bag.add("felix", "AI-100", "Issue");
    bag.add("felix", "AI-101", "Issue");

    const sentTickets: string[] = [];
    const result = await replayPendingBag(bag, sessionTracker, wakeConfig, undefined, {
      isTicketActionable: (ticketId) => ticketId !== "linear-AI-100",
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
      interAgentDelayMs: 0,
    });

    expect(sentTickets).toEqual(["linear-AI-101"]);
    expect(result.replayed).toBe(1);
    expect(result.pruned).toBe(1);
  });

  test("replays multiple agents with pending work", async () => {
    bag.add("igor", "AI-200", "Issue");
    bag.add("felix", "AI-201", "Issue");

    const sentByAgent: Record<string, string[]> = {};
    const result = await replayPendingBag(bag, sessionTracker, wakeConfig, undefined, {
      isTicketActionable: () => true,
      sendWakeUp: async (agentId, ticketIds) => {
        sentByAgent[agentId] = [...(sentByAgent[agentId] ?? []), ...ticketIds];
      },
      interAgentDelayMs: 0,
    });

    expect(sentByAgent["igor"]).toEqual(["linear-AI-200"]);
    expect(sentByAgent["felix"]).toEqual(["linear-AI-201"]);
    expect(result.replayed).toBe(2);
    expect(result.agents).toBe(2);
  });
});
