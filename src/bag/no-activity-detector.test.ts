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

  test("defers dispatch when agent is alive but at capacity", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];
    const comments: Array<{ agentId: string; ticketId: string; message: string }> = [];

    // Simulate agent at capacity: start maxConcurrent-1 other sessions so remaining >= maxConcurrent-1
    // maxConcurrent defaults to 3; start 2 other sessions so after removing the failing one, remaining=2 >= 2
    sessionTracker.startSession("charles", "linear-AI-1325"); // long-running task
    sessionTracker.startSession("charles", "linear-AI-1328"); // another task

    // The failing session for AI-1338
    bag.add("charles", "linear-AI-1338", "Issue");
    sessionTracker.startSession("charles", "linear-AI-1338");
    ackTracker.recordDispatch("charles", "linear-AI-1338");

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
      { warnMs: 0, failMs: 0, pollMs: 60_000, maxConcurrent: 3, deferredStaleMs: 3_600_000 },
    );

    const result = await detector.runCycle();

    // Should be classified as deferred, not hard-failed
    expect(result.deferredAtCapacity).toBe(1);
    expect(result.failed).toBe(0);

    // No re-dispatch attempted (agent is still at capacity)
    expect(dispatchedTickets).toHaveLength(0);

    // No Linear comment posted (no noise)
    expect(comments).toHaveLength(0);

    // deferred-at-capacity event logged
    const deferredEvents = operationalEventStore.query({ outcome: "deferred-at-capacity" });
    expect(deferredEvents).toHaveLength(1);
    expect(deferredEvents[0].agent).toBe("charles");
    expect(deferredEvents[0].key).toBe("linear-AI-1338");

    // No hard-failure event
    const failedEvents = operationalEventStore.query({ outcome: "no-activity-failed" });
    expect(failedEvents).toHaveLength(0);

    // Ticket still in bag (handleAtCapacity does not remove it)
    const pending = bag.getPendingTickets("charles");
    expect(pending.some((e) => e.ticketId === "linear-AI-1338")).toBe(true);

    // Ack tracker: ticket stays as "pending" (handleAtCapacity does not call markDeferred).
    // Re-dispatch happens via checkDeferredOnSessionEnd when a slot frees.
    const timedOut = ackTracker.getPendingTimedOut(0);
    expect(timedOut.filter((e) => e.ticketId === "linear-AI-1338")).toHaveLength(1);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("treats as hard failure when agent has sessions but is not at capacity", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    // One other session active — agent alive but NOT at capacity (1 of 3)
    sessionTracker.startSession("charles", "linear-AI-1100");

    bag.add("charles", "linear-AI-1338", "Issue");
    sessionTracker.startSession("charles", "linear-AI-1338");
    ackTracker.recordDispatch("charles", "linear-AI-1338");

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
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000, maxConcurrent: 3, deferredStaleMs: 3_600_000 },
    );

    const result = await detector.runCycle();

    // Should be treated as a hard failure, not deferred
    expect(result.failed).toBe(1);
    expect(result.deferredAtCapacity).toBe(0);
    expect(dispatchedTickets).toContain("linear-AI-1338");

    const failedEvents = operationalEventStore.query({ outcome: "no-activity-failed" });
    expect(failedEvents).toHaveLength(1);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("stale-deferred entries are rescued by the sweep", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    bag.add("charles", "linear-AI-1338", "Issue");
    // Session already ended — only a deferred ack entry remains
    ackTracker.recordDispatch("charles", "linear-AI-1338");
    ackTracker.markDeferred("charles", "linear-AI-1338");

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
      },
      { warnMs: 60_000, failMs: 60_000, pollMs: 60_000, maxConcurrent: 3, deferredStaleMs: 0 }, // deferredStaleMs=0 → all deferred entries are stale
    );

    const result = await detector.runCycle();

    // Main sweep finds nothing (session not active)
    expect(result.failed).toBe(0);
    expect(result.deferredAtCapacity).toBe(0);

    // Stale sweep rescues the deferred ticket
    expect(dispatchedTickets).toContain("linear-AI-1338");

    // Entry promoted to unconfirmed with incremented attempt count
    const deferred = ackTracker.getDeferredStale(0);
    expect(deferred.filter((e) => e.ticketId === "linear-AI-1338")).toHaveLength(0); // no longer deferred

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("checkDeferredOnSessionEnd re-dispatches deferred ticket when capacity is available", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    // Agent at capacity: 3 sessions (maxConcurrent=3)
    sessionTracker.startSession("charles", "linear-AI-1325");
    sessionTracker.startSession("charles", "linear-AI-1328");
    bag.add("charles", "linear-AI-1338", "Issue");
    sessionTracker.startSession("charles", "linear-AI-1338");
    ackTracker.recordDispatch("charles", "linear-AI-1338");

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
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000, maxConcurrent: 3, deferredStaleMs: 3_600_000 },
    );

    // Cycle defers the ticket (at capacity)
    const result = await detector.runCycle();
    expect(result.deferredAtCapacity).toBe(1);
    expect(dispatchedTickets).toHaveLength(0);

    // One session ends, freeing a slot
    sessionTracker.endSession("charles", "linear-AI-1325");

    // checkDeferredOnSessionEnd should now re-dispatch the deferred ticket
    await detector.checkDeferredOnSessionEnd("charles");
    expect(dispatchedTickets).toContain("linear-AI-1338");

    // deferred-capacity-rearm event logged
    const rearmEvents = operationalEventStore.query({ outcome: "deferred-capacity-rearm" });
    expect(rearmEvents).toHaveLength(1);
    expect(rearmEvents[0].agent).toBe("charles");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("checkDeferredOnSessionEnd stays deferred if agent is still at capacity", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatchedTickets: string[] = [];

    // Agent at capacity: 3 sessions
    sessionTracker.startSession("charles", "linear-AI-1325");
    sessionTracker.startSession("charles", "linear-AI-1328");
    bag.add("charles", "linear-AI-1338", "Issue");
    sessionTracker.startSession("charles", "linear-AI-1338");
    ackTracker.recordDispatch("charles", "linear-AI-1338");

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
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000, maxConcurrent: 3, deferredStaleMs: 3_600_000 },
    );

    // Cycle defers the ticket (at capacity)
    const result = await detector.runCycle();
    expect(result.deferredAtCapacity).toBe(1);

    // checkDeferredOnSessionEnd called but agent is still at max capacity (2 remaining sessions)
    await detector.checkDeferredOnSessionEnd("charles");

    // Should NOT dispatch — still at capacity
    expect(dispatchedTickets).toHaveLength(0);

    // No rearm event
    const rearmEvents = operationalEventStore.query({ outcome: "deferred-capacity-rearm" });
    expect(rearmEvents).toHaveLength(0);

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

  test("AI-1474: wakeConfigForAgent routes re-dispatch to per-agent container gateway", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const capturedConfigs: import("./wake-up.js").WakeUpConfig[] = [];

    bag.add("kana", "linear-AI-1474", "Issue");
    sessionTracker.startSession("kana", "linear-AI-1474");
    ackTracker.recordDispatch("kana", "linear-AI-1474");

    const containerConfig: import("./wake-up.js").WakeUpConfig = {
      nodeBin: process.execPath,
      timeoutMs: 10,
      maxRetries: 0,
      hooksUrl: "http://127.0.0.1:18823/hooks/agent-nodelivery-kana",
      hooksToken: "tok-kana",
    };

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        wakeConfigForAgent: (agentId: string) => {
          if (agentId === "kana") return containerConfig;
          return wakeConfig;
        },
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, _ticketIds, config) => {
            capturedConfigs.push(config);
          },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    const result = await detector.runCycle();

    expect(result.failed).toBe(1);
    expect(capturedConfigs).toHaveLength(1);
    // The re-dispatch must use the per-agent container hooksUrl, not the global one
    expect(capturedConfigs[0].hooksUrl).toBe("http://127.0.0.1:18823/hooks/agent-nodelivery-kana");
    expect(capturedConfigs[0].hooksToken).toBe("tok-kana");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  // ── AI-1664: proxy calls count as evidence of agent starting ─────────────
  //
  // Problem: Emi made proxy calls against ticket e6ef9813 at T+6s after delivery
  // (clearly started and working). The no-activity detector still declared failure
  // at T+308s and re-dispatched her into a new context.
  //
  // Root cause: proxy calls are handled by a separate code path and are not
  // tracked by the detector's evidence accumulator. Only webhook-side signals
  // (state transitions, comments, session-end) counted as evidence.
  //
  // Fix: expose NoActivityDetector.recordProxyActivity(agentId, ticketId) and
  // call it from the proxy endpoint on every ticket-matched proxy call.
  //
  // AC1  Proxy call against the dispatched ticket prevents failure declaration.
  // AC2  Existing webhook-based evidence detection works unchanged (regression).
  // AC3  Non-ticket proxy calls do not affect the no-activity timer.
  // AC4  Regression: proxy call at T+100s prevents failure declaration at T+308s.

  describe("AI-1664: proxy calls as activity evidence", () => {
    test("proxy call against dispatched ticket prevents failure declaration [AC1]", async () => {
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("emi", "linear-AI-1658", "Issue");
      sessionTracker.startSession("emi", "linear-AI-1658");
      ackTracker.recordDispatch("emi", "linear-AI-1658");

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
        },
        { warnMs: 0, failMs: 0, pollMs: 60_000 }, // failMs=0 → fires immediately without evidence
      );

      // Proxy call with matching ticket ID — evidence the agent started and is working.
      // NoActivityDetector does not yet expose recordProxyActivity → RED until implemented.
      detector.recordProxyActivity("emi", "linear-AI-1658");

      const result = await detector.runCycle();

      // Proxy evidence must prevent failure declaration.
      expect(result.failed).toBe(0);
      expect(dispatchedTickets).toHaveLength(0);
      const failEvents = operationalEventStore.query({ outcome: "no-activity-failed" });
      expect(failEvents).toHaveLength(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });

    test("proxy call without matching ticket ID does not prevent failure [AC3]", async () => {
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("emi", "linear-AI-1658", "Issue");
      sessionTracker.startSession("emi", "linear-AI-1658");
      ackTracker.recordDispatch("emi", "linear-AI-1658");

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
        },
        { warnMs: 0, failMs: 0, pollMs: 60_000 },
      );

      // Proxy call for a completely different ticket — must NOT reset the timer for AI-1658.
      // recordProxyActivity does not exist yet → RED; once implemented, the non-matching
      // ticket must be silently ignored so AI-1658 still fails.
      detector.recordProxyActivity("emi", "linear-AI-9999");

      const result = await detector.runCycle();

      // No evidence for linear-AI-1658 — failure must still fire.
      expect(result.failed).toBe(1);
      expect(dispatchedTickets).toContain("linear-AI-1658");

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });

    test("regression: proxy call at T+100s prevents failure declaration at T+308s [AC4]", async () => {
      // Canonical Emi scenario (AI-1664 description):
      //   T+0s   — dispatch delivered, ack entry created
      //   T+6s   — Emi makes proxy calls (agent clearly started)
      //   T+308s — no-activity detector fires, re-dispatches into a new context (bug)
      //
      // We model this as failMs=0 (any dispatch is immediately past threshold) and
      // verify that recordProxyActivity suppresses the failure.  Post-fix, the proxy
      // call acknowledges the ack entry so getPendingTimedOut no longer returns it
      // and runCycle skips it entirely.
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("emi", "linear-AI-1658", "Issue");
      sessionTracker.startSession("emi", "linear-AI-1658");
      ackTracker.recordDispatch("emi", "linear-AI-1658");

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
        },
        { warnMs: 0, failMs: 0, pollMs: 60_000 }, // failMs=0 → fires immediately
      );

      // T+100s: proxy call arrives with ticket identifier. Agent clearly started.
      detector.recordProxyActivity("emi", "linear-AI-1658");

      // T+308s: detector cycle runs — must NOT declare failure.
      const result = await detector.runCycle();

      expect(result.failed).toBe(0);
      expect(dispatchedTickets).toHaveLength(0);

      const failEvents = operationalEventStore.query({ outcome: "no-activity-failed" });
      expect(failEvents).toHaveLength(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });

    test("webhook-based evidence detection unchanged when no proxy call is made [AC2 regression]", async () => {
      // No proxy call made — detector must still fire for sessions that produce
      // no evidence. Existing behavior must not be regressed by the proxy-evidence feature.
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("felix", "linear-AI-9001", "Issue");
      sessionTracker.startSession("felix", "linear-AI-9001");
      ackTracker.recordDispatch("felix", "linear-AI-9001");

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
        },
        { warnMs: 0, failMs: 0, pollMs: 60_000 },
      );

      // No proxy call — no evidence of agent starting.
      const result = await detector.runCycle();

      expect(result.failed).toBe(1);
      expect(dispatchedTickets).toContain("linear-AI-9001");
      const failEvents = operationalEventStore.query({ outcome: "no-activity-failed" });
      expect(failEvents).toHaveLength(1);

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });
  });
});
