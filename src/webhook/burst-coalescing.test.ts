/**
 * Burst-coalescing integration test.
 *
 * Verifies that a burst of 100 events for the same agent collapses
 * to a small number of wake-up signals. Tests the bag + session tracker
 * logic directly without going through the full Express pipeline.
 */

import { PendingWorkBag } from "../bag/pending-work-bag.js";
import { SessionTracker } from "../bag/session-tracker.js";
import fs from "fs";
import os from "os";
import path from "path";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burst-test-"));
  return path.join(dir, "test.db");
}

describe("Burst coalescing", () => {
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;
  let dbPath: string;
  let signalsSent: number;

  beforeEach(() => {
    dbPath = tempDb();
    bag = new PendingWorkBag(dbPath, 60_000);
    sessionTracker = new SessionTracker(30_000);
    signalsSent = 0;
  });

  afterEach(() => {
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("100 rapid events for same agent collapse to 1 wake-up signal", () => {
    const TICKET_COUNT = 100;
    const agentName = "igor";

    // Simulate the webhook handler's bag logic for each event:
    // 1. Add to bag
    // 2. Check if session active → if yes, queue signal
    // 3. If no session → send wake-up + start session
    for (let i = 0; i < TICKET_COUNT; i++) {
      const ticketId = `AI-${490 + i}`;
      bag.add(agentName, ticketId, "Issue");

      if (sessionTracker.isActive(agentName)) {
        // Agent is busy — queue signal for session-end
        sessionTracker.queueSignal(agentName, [ticketId]);
      } else {
        // No active session — send wake-up signal
        const pending = bag.getPendingTickets(agentName);
        const pendingIds = pending.map((e) => e.ticketId);

        sessionTracker.startSession(agentName, `wake-up-${Date.now()}`);
        bag.recordSignal();
        signalsSent++;

        // In production, sendWakeUpSignal is called here.
        // On success, bag.clearAgent(agentName) is called.
        // For this test, we skip the actual delivery and just clear the bag
        // (simulating successful signal delivery).
        bag.clearAgent(agentName);
      }
    }

    // Assert: exactly 1 signal was sent
    expect(signalsSent).toBe(1);
    const stats = bag.getStats();
    expect(stats.signalsSent).toBe(1);
    expect(stats.eventsReceived).toBe(TICKET_COUNT);

    // The agent should have an active session
    expect(sessionTracker.isActive(agentName)).toBe(true);
  });

  test("second burst after session-end produces another signal", () => {
    // First burst
    for (let i = 0; i < 50; i++) {
      const ticketId = `AI-${490 + i}`;
      bag.add("igor", ticketId, "Issue");
      if (!sessionTracker.isActive("igor")) {
        sessionTracker.startSession("igor", `wake-up-${Date.now()}`);
        bag.recordSignal();
        signalsSent++;
        bag.clearAgent("igor");
      }
    }
    expect(signalsSent).toBe(1);

    // Session ends
    const pending = sessionTracker.endSession("igor");
    // No pending signals because we cleared the bag each time
    expect(pending).toBeNull();
    expect(sessionTracker.isActive("igor")).toBe(false);

    // Second burst
    for (let i = 0; i < 50; i++) {
      const ticketId = `AI-${540 + i}`;
      bag.add("igor", ticketId, "Issue");
      if (!sessionTracker.isActive("igor")) {
        sessionTracker.startSession("igor", `wake-up-${Date.now()}`);
        bag.recordSignal();
        signalsSent++;
        bag.clearAgent("igor");
      }
    }

    expect(signalsSent).toBe(2); // 1 from first burst, 1 from second
    expect(bag.getStats().signalsSent).toBe(2);
  });

  test("events arriving during active session get queued for re-signal", () => {
    // Start a session (simulating agent is busy)
    sessionTracker.startSession("igor", "session-1");

    // Events arrive
    for (let i = 0; i < 10; i++) {
      const ticketId = `AI-${490 + i}`;
      bag.add("igor", ticketId, "Issue");
      sessionTracker.queueSignal("igor", [ticketId]);
    }

    // No wake-up signal sent yet
    expect(bag.getStats().signalsSent).toBe(0);

    // Session ends
    const pendingTickets = sessionTracker.endSession("igor");
    expect(pendingTickets).not.toBeNull();
    expect(pendingTickets!.length).toBeGreaterThan(0);

    // Now send wake-up signal
    bag.recordSignal();
    expect(bag.getStats().signalsSent).toBe(1);
  });
});
