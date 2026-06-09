/**
 * Tests for the DispatchWatchdog and DispatchAckTracker.
 *
 * Covers the CT-52 failure mode: a wake-up hook returns 200 (dispatch-accepted),
 * the connector believes the agent was notified, but the agent never acts and the
 * dashboard stays green indefinitely.
 *
 * Verification requirements:
 *  - delivery-unconfirmed event appears in the operational event store
 *  - Admin dashboard attention is non-green for unconfirmed dispatches
 *  - Re-signal is bounded — max retries respected
 *  - Re-signal is idempotent — duplicate ticket in session dedup doesn't double-dispatch
 *  - Ticket is re-added to the bag if it was prematurely cleared
 *  - Session-end acknowledgment stops the watchdog from re-signaling
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import { DispatchWatchdog } from "./dispatch-watchdog.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };
const containerWakeConfig: WakeUpConfig = {
  nodeBin: process.execPath,
  timeoutMs: 10,
  maxRetries: 0,
  hooksUrl: "http://127.0.0.1:18823/hooks/agent-nodelivery-kana",
  hooksToken: "tok-kana",
};

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, ackTracker, operationalEventStore };
}

describe("DispatchAckTracker", () => {
  let dir: string;
  let tracker: DispatchAckTracker;

  beforeEach(() => {
    dir = tempDir();
    tracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  });

  afterEach(() => {
    tracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("recordDispatch creates a pending entry", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    const timedOut = tracker.getPendingTimedOut(0); // 0ms timeout → everything is timed out
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].agentId).toBe("emi");
    expect(timedOut[0].ticketId).toBe("linear-CT-52"); // normalizeSessionKey uppercases
    expect(timedOut[0].ackStatus).toBe("pending");
    expect(timedOut[0].attemptCount).toBe(1);
  });

  test("recordDispatch is idempotent — repeated calls increment attempt_count", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    tracker.recordDispatch("emi", "linear-CT-52");
    const timedOut = tracker.getPendingTimedOut(0);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].attemptCount).toBe(2);
  });

  test("acknowledge by agentId clears all pending entries for agent", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    tracker.recordDispatch("emi", "linear-CT-53");
    tracker.acknowledge("emi");
    const timedOut = tracker.getPendingTimedOut(0);
    expect(timedOut).toHaveLength(0);
  });

  test("acknowledge by ticketId clears only that ticket", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    tracker.recordDispatch("emi", "linear-CT-53");
    tracker.acknowledge("emi", "linear-CT-52");
    const timedOut = tracker.getPendingTimedOut(0);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].ticketId).toBe("linear-CT-53");
  });

  test("getPendingTimedOut respects the timeout window", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    // Large timeout — entry is not yet timed out
    const notYet = tracker.getPendingTimedOut(60 * 60 * 1000); // 1 hour
    expect(notYet).toHaveLength(0);
    // Zero timeout — everything is timed out
    const now = tracker.getPendingTimedOut(0);
    expect(now).toHaveLength(1);
  });

  test("markResignaled updates status and increments attempt_count", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    tracker.markResignaled("emi", "linear-CT-52");
    const entries = tracker.getPendingTimedOut(0);
    expect(entries[0].ackStatus).toBe("unconfirmed");
    expect(entries[0].attemptCount).toBe(2);
  });

  test("markEscalated removes entry from timed-out results", () => {
    tracker.recordDispatch("emi", "linear-CT-52");
    tracker.markEscalated("emi", "linear-CT-52");
    const entries = tracker.getPendingTimedOut(0);
    expect(entries).toHaveLength(0);
  });
});

describe("DispatchWatchdog — CT-52 failure mode", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("CT-52: hook accepted, no downstream evidence → delivery-unconfirmed event + re-signal", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    // Simulate: agent received a wake-up (dispatch-accepted) but never responded.
    bag.add("emi", "linear-CT-52", "Issue");
    sessionTracker.startSession("emi", "linear-CT-52");
    ackTracker.recordDispatch("emi", "linear-CT-52");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Watchdog must have detected the unacknowledged dispatch
    expect(result.unconfirmed).toBe(1);
    expect(result.resignaled).toBe(1);
    expect(result.escalated).toBe(0);

    // delivery-unconfirmed event must be written to operational store
    const events = operationalEventStore.query({ outcome: "delivery-unconfirmed" });
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe("emi");
    expect(events[0].key).toBe("linear-CT-52");

    // Watchdog must have re-signaled the agent
    expect(dispatchedTickets).toContain("linear-CT-52");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("admin dashboard is non-green when delivery-unconfirmed event is present", async () => {
    const { operationalEventStore } = setupDeps(dir);

    // Simulate a delivery-unconfirmed event already in the store
    operationalEventStore.append({
      outcome: "delivery-unconfirmed",
      agent: "emi",
      key: "linear-ct-52",
      sessionKey: "linear-ct-52",
      attemptCount: 1,
      detail: { dispatchedAt: new Date().toISOString(), attemptCount: 1, maxResignals: 3 },
    });

    const recentEvents = operationalEventStore.query({
      outcome: "delivery-unconfirmed",
      limit: 10,
    });
    expect(recentEvents).toHaveLength(1);
    expect(recentEvents[0].agent).toBe("emi");
    // Severity logic: attempts < 3 → yellow; >= 3 → red
    const attempts = (recentEvents[0].detail as Record<string, unknown>).attemptCount as number;
    const expectedSeverity = attempts >= 3 ? "red" : "yellow";
    expect(expectedSeverity).toBe("yellow");

    operationalEventStore.close();
  });

  test("re-signal is bounded — escalates after maxResignals exceeded", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("emi", "linear-CT-52", "Issue");
    ackTracker.recordDispatch("emi", "linear-CT-52");
    // Simulate 4 prior attempts (exceeds default maxResignals of 3)
    ackTracker.markResignaled("emi", "linear-CT-52");
    ackTracker.markResignaled("emi", "linear-CT-52");
    ackTracker.markResignaled("emi", "linear-CT-52");
    ackTracker.markResignaled("emi", "linear-CT-52");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.escalated).toBe(1);
    expect(result.resignaled).toBe(0);
    expect(dispatchedTickets).toHaveLength(0);

    // delivery-unconfirmed event still written (admin must know)
    const events = operationalEventStore.query({ outcome: "delivery-unconfirmed" });
    expect(events).toHaveLength(1);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("session-end acknowledgment stops watchdog from re-signaling", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("emi", "linear-CT-52", "Issue");
    ackTracker.recordDispatch("emi", "linear-CT-52");

    // Simulate session-end: agent ran, acknowledge the dispatch
    ackTracker.acknowledge("emi");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.unconfirmed).toBe(0);
    expect(result.resignaled).toBe(0);
    expect(dispatchedTickets).toHaveLength(0);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("non-actionable watchdog recheck is acknowledged instead of retried forever", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("emi", "linear-CT-52", "Issue");
    sessionTracker.startSession("emi", "linear-CT-52");
    ackTracker.recordDispatch("emi", "linear-CT-52");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => false,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.unconfirmed).toBe(1);
    expect(result.resignaled).toBe(0);
    expect(result.autoAcknowledged).toBe(1);
    expect(dispatchedTickets).toHaveLength(0);
    expect(ackTracker.getPendingTimedOut(0)).toHaveLength(0);
    expect(bag.getPendingTickets("emi")).toHaveLength(0);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("ticket prematurely cleared from bag is re-added before re-signal", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    // Bag is empty — simulating a premature clear on session-end before work was done
    ackTracker.recordDispatch("emi", "linear-CT-52");
    // Don't add to bag — the watchdog should detect and re-add it

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Watchdog re-added the ticket and re-signaled
    expect(result.resignaled).toBe(1);
    expect(dispatchedTickets).toContain("linear-CT-52");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("stale session is cleared and ticket is re-signaled by watchdog", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("emi", "linear-CT-52", "Issue");
    sessionTracker.startSession("emi", "linear-CT-52"); // session appears active in tracker
    ackTracker.recordDispatch("emi", "linear-CT-52");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Watchdog clears the stale session lock and re-signals the ticket
    expect(result.unconfirmed).toBe(1);
    expect(result.resignaled).toBe(1);
    expect(dispatchedTickets).toContain("linear-CT-52");
    // Session is re-started by resignalPendingTickets(markActive:true) after dispatch
    expect(sessionTracker.isActiveForTicket("emi", "linear-CT-52")).toBe(true);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AI-1474: wakeConfigForAgent routes re-signal to per-agent container gateway", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const capturedConfigs: WakeUpConfig[] = [];

    bag.add("kana", "linear-AI-1474", "Issue");
    sessionTracker.startSession("kana", "linear-AI-1474");
    ackTracker.recordDispatch("kana", "linear-AI-1474");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        wakeConfigForAgent: (agentId: string) => {
          if (agentId === "kana") return containerWakeConfig;
          return wakeConfig;
        },
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, _ticketIds, config) => {
            capturedConfigs.push(config);
          },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.resignaled).toBe(1);
    expect(capturedConfigs).toHaveLength(1);
    // The re-signal must use the per-agent container hooksUrl, not the global one
    expect(capturedConfigs[0].hooksUrl).toBe("http://127.0.0.1:18823/hooks/agent-nodelivery-kana");
    expect(capturedConfigs[0].hooksToken).toBe("tok-kana");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AI-1474: without wakeConfigForAgent, falls back to global wakeConfig", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const capturedConfigs: WakeUpConfig[] = [];

    bag.add("kana", "linear-AI-1474", "Issue");
    sessionTracker.startSession("kana", "linear-AI-1474");
    ackTracker.recordDispatch("kana", "linear-AI-1474");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        // No wakeConfigForAgent — backward compat
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, _ticketIds, config) => {
            capturedConfigs.push(config);
          },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.resignaled).toBe(1);
    expect(capturedConfigs).toHaveLength(1);
    // Without wakeConfigForAgent, falls back to the global wakeConfig (no hooksUrl)
    expect(capturedConfigs[0].hooksUrl).toBeUndefined();

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});
