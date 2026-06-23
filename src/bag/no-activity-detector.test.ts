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

  // ── AI-1666: per-step noActivityTimeout override ──────────────────────────
  //
  // Acceptance criteria (AC):
  //   AC1  Workflow YAML accepts noActivityTimeout at state level
  //   AC2  Connector uses per-state timeout when specified, global default otherwise
  //   AC4  Specific: generating state with 600s timeout does not trigger at 308s
  //
  // Interface contract: NoActivityDeps gains an optional
  //   getFailMsForTicket?(agentId, ticketId): number | undefined
  // dep. When it returns a number, runCycle uses that instead of config.failMs for
  // that ticket. When it returns undefined, the global config.failMs applies.
  //
  // The real wiring resolves the ticket's current workflow state from the
  // AppliedStateStore / WorkflowDef and reads noActivityTimeout from there.
  // Tests inject a direct callback to keep them fast and network-free.

  describe("AI-1666: per-state noActivityTimeout override", () => {
    test("per-state timeout suppresses failure when below state threshold [AC2, AC4]", async () => {
      // Simulates: generating state with 600s timeout does not trigger at 308s.
      // We model this as: globalFailMs=0 (fires immediately for all tickets) but
      // getFailMsForTicket returns 600_000 for this ticket.
      // At ~0ms elapsed the per-state 600s is not exceeded → must NOT fail.
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("image-artist", "linear-AI-1050", "Issue");
      sessionTracker.startSession("image-artist", "linear-AI-1050");
      ackTracker.recordDispatch("image-artist", "linear-AI-1050");

      const detector = new NoActivityDetector(
        {
          sessionTracker,
          ackTracker,
          bag,
          operationalEventStore,
          wakeConfig,
          // Per-state 600s override for this ticket.
          // NoActivityDeps does not yet declare this field (AC2 not implemented).
          // With isolatedModules the extra key is not a compile error; at runtime
          // the detector ignores it and fires via failMs=0 → test is RED until implemented.
          ...(({ getFailMsForTicket: (_a: string, _t: string) => 600_000 }) as Record<string, unknown>),
          resignalOptions: {
            isTicketActionable: () => true,
            sendWakeUp: async (_agentId: string, ticketIds: string[]) => {
              dispatchedTickets.push(...ticketIds);
            },
          },
        } as Parameters<typeof NoActivityDetector>[0],
        { warnMs: 0, failMs: 0, pollMs: 60_000 }, // global failMs=0 fires immediately
      );

      const result = await detector.runCycle();

      // Per-state 600s is not exceeded → must NOT fail.
      // FAILS currently: detector ignores getFailMsForTicket and uses failMs=0 → result.failed=1.
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

    test("per-state timeout fires when state threshold is exceeded [AC2]", async () => {
      // When getFailMsForTicket returns a small value (0), it should fire even
      // when the global config.failMs is very large (1hr — would never fire).
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("image-artist", "linear-AI-1051", "Issue");
      sessionTracker.startSession("image-artist", "linear-AI-1051");
      ackTracker.recordDispatch("image-artist", "linear-AI-1051");

      const detector = new NoActivityDetector(
        {
          sessionTracker,
          ackTracker,
          bag,
          operationalEventStore,
          wakeConfig,
          // Per-state 0ms override → fires immediately.
          ...(({ getFailMsForTicket: (_a: string, _t: string) => 0 }) as Record<string, unknown>),
          resignalOptions: {
            isTicketActionable: () => true,
            sendWakeUp: async (_agentId: string, ticketIds: string[]) => {
              dispatchedTickets.push(...ticketIds);
            },
          },
        } as Parameters<typeof NoActivityDetector>[0],
        { warnMs: 0, failMs: 3_600_000, pollMs: 60_000 }, // global 1hr — would NOT fire
      );

      const result = await detector.runCycle();

      // Per-state 0ms is always exceeded → must fail and re-dispatch.
      // FAILS currently: detector uses global failMs=3_600_000 → does not fire → result.failed=0.
      expect(result.failed).toBe(1);
      expect(dispatchedTickets).toContain("linear-AI-1051");

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });

    test("per-state timeout is independent per ticket in the same cycle [AC2]", async () => {
      // ticket-a: per-state 600_000 (should NOT fail despite global=0)
      // ticket-b: no override (should fail via global=0)
      // Only ticket-b should appear in failed count.
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("image-artist", "linear-AI-1052", "Issue");
      sessionTracker.startSession("image-artist", "linear-AI-1052");
      ackTracker.recordDispatch("image-artist", "linear-AI-1052");

      bag.add("image-artist", "linear-AI-1053", "Issue");
      sessionTracker.startSession("image-artist", "linear-AI-1053");
      ackTracker.recordDispatch("image-artist", "linear-AI-1053");

      const detector = new NoActivityDetector(
        {
          sessionTracker,
          ackTracker,
          bag,
          operationalEventStore,
          wakeConfig,
          ...(({
            getFailMsForTicket: (_a: string, ticketId: string) => {
              if (ticketId === "linear-AI-1052") return 600_000; // suppressed
              return undefined; // ticket-b: use global
            },
          }) as Record<string, unknown>),
          resignalOptions: {
            isTicketActionable: () => true,
            sendWakeUp: async (_agentId: string, ticketIds: string[]) => {
              dispatchedTickets.push(...ticketIds);
            },
          },
        } as Parameters<typeof NoActivityDetector>[0],
        { warnMs: 0, failMs: 0, pollMs: 60_000 },
      );

      const result = await detector.runCycle();

      // Only ticket-b (AI-1053) should fail; ticket-a (AI-1052) is suppressed by per-state timeout.
      // FAILS currently: both tickets fire (global=0 applies to both) → result.failed=2.
      expect(result.failed).toBe(1);
      expect(dispatchedTickets).not.toContain("linear-AI-1052");
      expect(dispatchedTickets).toContain("linear-AI-1053");

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });

    test("global failMs applies unchanged when getFailMsForTicket returns undefined [AC2 regression]", async () => {
      // Verifies existing behavior is not broken: when the callback returns undefined,
      // the global config.failMs is used.
      const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
      const dispatchedTickets: string[] = [];

      bag.add("image-artist", "linear-AI-1054", "Issue");
      sessionTracker.startSession("image-artist", "linear-AI-1054");
      ackTracker.recordDispatch("image-artist", "linear-AI-1054");

      const detector = new NoActivityDetector(
        {
          sessionTracker,
          ackTracker,
          bag,
          operationalEventStore,
          wakeConfig,
          ...(({ getFailMsForTicket: () => undefined }) as Record<string, unknown>),
          resignalOptions: {
            isTicketActionable: () => true,
            sendWakeUp: async (_agentId: string, ticketIds: string[]) => {
              dispatchedTickets.push(...ticketIds);
            },
          },
        } as Parameters<typeof NoActivityDetector>[0],
        { warnMs: 0, failMs: 0, pollMs: 60_000 },
      );

      const result = await detector.runCycle();

      // Global threshold applies → should fail normally.
      // This test PASSES currently (no behavioral change needed for this path).
      expect(result.failed).toBe(1);
      expect(dispatchedTickets).toContain("linear-AI-1054");

      detector.stop();
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    });
  });
});
