/**
 * Tests for the NoActivityDetector.
 *
 * Covers the failure mode described in AI-1040: a gateway dispatch returns 200
 * with a runId, but the agent never actually starts working. The detector should:
 *   - Emit a no-activity-warn event at the warn threshold
 *   - Treat the session as failed at the fail threshold
 *   - Re-dispatch with capped retries
 *   - Post a Linear comment on failure
 *   - Not re-warn for sessions already warned
 *   - Skip sessions that are no longer active
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import { NoActivityDetector } from "./no-activity-detector.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "no-activity-test-"));
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, ackTracker, operationalEventStore };
}

describe("NoActivityDetector", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("emits no-activity-warn event at warn threshold", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    // Dispatch a ticket and start a session
    bag.add("emi", "linear-AI-1040", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig },
      { warnMs: 0, failMs: 60_000, pollMs: 60_000 }, // warnMs=0 → everything is past warn
    );

    const result = await detector.runCycle();

    expect(result.warned).toBe(1);
    expect(result.failed).toBe(0);

    const events = operationalEventStore.query({ outcome: "no-activity-warn" });
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe("emi");
    expect(events[0].key).toBe("linear-AI-1040");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("treats session as failed at fail threshold and re-dispatches", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];
    const comments: Array<{ agentId: string; ticketId: string; message: string }> = [];

    bag.add("emi", "linear-AI-1040", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
        postLinearComment: async (agentId, ticketId, message) => {
          comments.push({ agentId, ticketId, message });
          return true;
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 }, // failMs=0 → everything is past fail
    );

    const result = await detector.runCycle();

    expect(result.failed).toBe(1);

    // Session should be ended (then re-started by resignalPendingTickets with markActive:true)
    // The no-activity handler ends the dead session, then re-dispatches which starts a new one.
    // So the session IS active again after the cycle.

    // no-activity-failed event logged
    const events = operationalEventStore.query({ outcome: "no-activity-failed" });
    expect(events).toHaveLength(1);

    // Ticket was re-dispatched
    expect(dispatchedTickets).toContain("linear-AI-1040");

    // Linear comment was posted
    expect(comments).toHaveLength(1);
    expect(comments[0].ticketId).toBe("linear-AI-1040");
    expect(comments[0].message).toContain("Dispatch failure detected");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("does not re-warn for already-warned sessions", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    bag.add("emi", "linear-AI-1040", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig },
      { warnMs: 0, failMs: 60_000, pollMs: 60_000 },
    );

    // First cycle: should warn
    const result1 = await detector.runCycle();
    expect(result1.warned).toBe(1);

    // Second cycle: should not warn again
    const result2 = await detector.runCycle();
    expect(result2.warned).toBe(0);

    const events = operationalEventStore.query({ outcome: "no-activity-warn" });
    expect(events).toHaveLength(1); // Still just 1, not 2

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("skips sessions that are no longer active", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    bag.add("emi", "linear-AI-1040", "Issue");
    // Don't start a session — it's already ended or never started
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    const result = await detector.runCycle();

    expect(result.warned).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.alreadyEnded).toBe(1);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("escalates after max retries exhausted", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];
    const comments: Array<{ agentId: string; ticketId: string; message: string }> = [];

    bag.add("emi", "linear-AI-1040", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");
    // Simulate 3 prior re-signal attempts (exceeds default maxResignals of 3)
    ackTracker.markResignaled("emi", "linear-AI-1040");
    ackTracker.markResignaled("emi", "linear-AI-1040");
    ackTracker.markResignaled("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
        postLinearComment: async (agentId, ticketId, message) => {
          comments.push({ agentId, ticketId, message });
          return true;
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    const result = await detector.runCycle();

    expect(result.failed).toBe(1);
    // Should NOT have re-dispatched (escalated instead)
    expect(dispatchedTickets).toHaveLength(0);

    // Should have escalation comment
    const escalationComment = comments.find((c) => c.message.includes("escalation"));
    expect(escalationComment).toBeDefined();

    // Ack tracker should show escalated
    const timedOut = ackTracker.getPendingTimedOut(0);
    expect(timedOut).toHaveLength(0); // Escalated entries are no longer "pending"

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("prunes non-actionable tickets instead of re-dispatching", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("emi", "linear-AI-1040", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => false, // Ticket is no longer actionable
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    const result = await detector.runCycle();

    expect(result.failed).toBe(1);
    // Should NOT have re-dispatched — ticket was pruned
    expect(dispatchedTickets).toHaveLength(0);

    // Ack tracker should show acknowledged (pruned = acknowledged)
    const timedOut = ackTracker.getPendingTimedOut(0);
    expect(timedOut).toHaveLength(0);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AI-1306: acknowledges ackTracker when resignal prunes ticket (agent no longer owns it)", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("emi", "linear-AI-1040", "Issue", "delegate");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          // Simulate ownership check failing — agent no longer delegate
          isTicketActionable: () => false,
          sendWakeUp: async (_agentId, ticketIds) => { dispatchedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    const result = await detector.runCycle();

    expect(result.failed).toBe(1);
    expect(dispatchedTickets).toHaveLength(0);

    // ackTracker must be acknowledged — not left as pending — so the detector
    // doesn't keep re-adding and re-pruning this ticket on every cycle.
    const timedOut = ackTracker.getPendingTimedOut(0);
    expect(timedOut).toHaveLength(0);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("clearWarned resets the warned state for a session", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    bag.add("emi", "linear-AI-1040", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1040");
    ackTracker.recordDispatch("emi", "linear-AI-1040");

    const detector = new NoActivityDetector(
      { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig },
      { warnMs: 0, failMs: 60_000, pollMs: 60_000 },
    );

    // First cycle: warn
    const result1 = await detector.runCycle();
    expect(result1.warned).toBe(1);

    // Clear warned state (simulating session-end callback)
    detector.clearWarned("emi", "linear-AI-1040");

    // Second cycle: should warn again
    const result2 = await detector.runCycle();
    expect(result2.warned).toBe(1);

    const events = operationalEventStore.query({ outcome: "no-activity-warn" });
    expect(events).toHaveLength(2);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});
