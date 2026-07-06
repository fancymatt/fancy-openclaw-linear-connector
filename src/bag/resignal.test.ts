import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { resignalPendingTickets } from "./resignal.js";
import { MENTION_TICKET_TEMPLATE, type WakeUpConfig } from "./wake-up.js";

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

    expect(results).toEqual([
      { ticketId: "linear-AI-501", dispatched: false, pruned: true },
      { ticketId: "linear-AI-597", dispatched: true, runId: undefined, canonVersion: null },
    ]);
    expect(sentTickets).toEqual(["linear-AI-597"]);
    const remaining = bag.getPendingTickets("igor");
    expect(remaining).toHaveLength(1); // dispatched ticket stays in bag until session-end
    expect(remaining[0].ticketId).toBe("linear-AI-597");
    expect(bag.getStats().signalsSent).toBe(1);
    expect(sessionTracker.getActiveSessionKey("igor")).toBe("linear-AI-597");
  });

  test("ILL-331 regression: delegate-routed ticket is pruned when delegate was cleared", async () => {
    // Simulate: ticket was delegate-routed but delegate has since been cleared (complete/handoff/needs-human).
    bag.add("igor", "AI-600", "Issue", "delegate");

    const results = await resignalPendingTickets("igor", ["AI-600"], bag, sessionTracker, wakeConfig, {
      // isTicketActionable returns false — delegate no longer matches (cleared by complete/handoff)
      isTicketActionable: () => false,
      sendWakeUp: async () => {},
    });

    expect(results).toEqual([
      { ticketId: "linear-AI-600", dispatched: false, pruned: true },
    ]);
    expect(bag.getPendingTickets("igor")).toHaveLength(0);
  });

  test("mention-routed ticket is NOT pruned when delegate is null", async () => {
    // Ticket was routed via @mention — agent need not be delegate.
    bag.add("igor", "AI-601", "Comment", "mention");

    const sentTickets: string[] = [];
    const sentConfigs: WakeUpConfig[] = [];
    const results = await resignalPendingTickets("igor", ["AI-601"], bag, sessionTracker, wakeConfig, {
      sendWakeUp: async (_agentId, ticketIds, cfg) => {
        sentTickets.push(...ticketIds);
        sentConfigs.push(cfg);
      },
    });

    expect(results[0].dispatched).toBe(true);
    expect(sentTickets).toEqual(["linear-AI-601"]);
    // Must use mention template so agent knows to observe, not own
    expect(sentConfigs[0].signalTemplate).toBe(MENTION_TICKET_TEMPLATE);
  });

  test("body-mention-routed ticket is NOT pruned when delegate is null", async () => {
    bag.add("igor", "AI-602", "Issue", "body-mention");

    const sentTickets: string[] = [];
    const results = await resignalPendingTickets("igor", ["AI-602"], bag, sessionTracker, wakeConfig, {
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
    });

    expect(results[0].dispatched).toBe(true);
    expect(sentTickets).toEqual(["linear-AI-602"]);
  });

  test("delegate-routed ticket uses default (non-mention) wake template", async () => {
    bag.add("igor", "AI-603", "Issue", "delegate");

    const sentConfigs: WakeUpConfig[] = [];
    await resignalPendingTickets("igor", ["AI-603"], bag, sessionTracker, wakeConfig, {
      isTicketActionable: () => true,
      sendWakeUp: async (_agentId, _ticketIds, cfg) => { sentConfigs.push(cfg); },
    });

    expect(sentConfigs[0].signalTemplate).toBeUndefined(); // default template, not mention
  });

  test("legacy ticket with no stored reason falls back to delegate check", async () => {
    // Pre-migration row — no routing_reason stored. Default = "delegate" so it
    // follows the ILL-331 protection path.
    bag.add("igor", "AI-604", "Issue"); // no routingReason

    const sentTickets: string[] = [];
    // isTicketActionable override simulates delegate check returning false
    const results = await resignalPendingTickets("igor", ["AI-604"], bag, sessionTracker, wakeConfig, {
      isTicketActionable: (_ticketId, _agentId) => false, // delegate cleared
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
    });

    expect(results[0].pruned).toBe(true);
    expect(sentTickets).toHaveLength(0);
  });

  test("AI-1340: failOpenBehavior=defer defers ticket without removing from bag", async () => {
    // The default checkLinearIssueRouting path: no token for unknown agent → fail-open.
    // With failOpenBehavior=defer the ticket should NOT be dispatched and NOT be removed.
    bag.add("unknown-agent-x", "AI-501", "Issue", "delegate");

    const sentTickets: string[] = [];
    const results = await resignalPendingTickets("unknown-agent-x", ["AI-501"], bag, sessionTracker, wakeConfig, {
      failOpenBehavior: "defer",
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
    });

    expect(sentTickets).toHaveLength(0);
    expect(results).toEqual([{ ticketId: "linear-AI-501", dispatched: false, deferred: true }]);
    // Ticket must remain in bag for retry on next connector start
    expect(bag.getPendingTickets("unknown-agent-x")).toHaveLength(1);
  });

  test("AI-1340: failOpenBehavior=dispatch (original default) dispatches on fail-open", async () => {
    // Same scenario but failOpenBehavior="dispatch" preserves original behavior
    bag.add("unknown-agent-y", "AI-502", "Issue", "delegate");

    const sentTickets: string[] = [];
    const results = await resignalPendingTickets("unknown-agent-y", ["AI-502"], bag, sessionTracker, wakeConfig, {
      failOpenBehavior: "dispatch",
      sendWakeUp: async (_agentId, ticketIds) => { sentTickets.push(...ticketIds); },
    });

    expect(sentTickets).toEqual(["linear-AI-502"]);
    expect(results[0].dispatched).toBe(true);
  });
});
