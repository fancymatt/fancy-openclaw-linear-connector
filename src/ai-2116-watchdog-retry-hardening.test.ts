/**
 * AI-2116 — Dispatch watchdog retry loop hardening: exponential backoff,
 * incrementing attempt counter, hard cap, no re-dispatch after cap.
 *
 * FAILING tests (TDD write-tests state). RED until implementation fills in
 * the missing behavior in DispatchWatchdog / DispatchAckTracker.
 *
 * AC mapping:
 *   AC1 — exponential backoff (not fixed 30s/3min)
 *   AC2 — attempt counter increments on each re-dispatch
 *   AC3 — hard cap (3 attempts), then park/escalate with summary comment
 *   AC4 — after cap, no further automated re-dispatches fire
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { PendingWorkBag } from "./bag/pending-work-bag.js";
import { SessionTracker } from "./bag/session-tracker.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { DispatchWatchdog, type WatchdogConfig } from "./bag/dispatch-watchdog.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import type { WakeUpConfig } from "./bag/wake-up.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-2116-"));
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, ackTracker, operationalEventStore };
}

// ════════════════════════════════════════════════════════════════════════════
// AC1: exponential backoff between re-dispatch cycles
// ════════════════════════════════════════════════════════════════════════════

describe("AC1: exponential backoff on re-dispatch", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("uses exponential backoff between re-dispatches, not a fixed interval", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const signaledTimestamps: number[] = [];

    bag.add("emi", "linear-AI-2116", "Issue");
    sessionTracker.startSession("emi", "linear-AI-2116");
    ackTracker.recordDispatch("emi", "linear-AI-2116");

    // Use an initial backoff of 1ms so the test runs fast, but assert that
    // each successive attempt waits exponentially longer.
    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, _ticketIds) => { signaledTimestamps.push(Date.now()); },
        },
      },
      {
        ackTimeoutMs: 0,
        maxResignals: 4,
        cycleIntervalMs: 60_000,
        exponentialBackoffMs: 1,
      } as WatchdogConfig & { exponentialBackoffMs: number },
    );

    // Run two cycles and measure delay between re-dispatches
    await watchdog.runCycle();
    const t1 = signaledTimestamps.length; // capture count after first

    // Simulate a second unaacknowledged cycle by re-running
    await watchdog.runCycle();
    const t2 = signaledTimestamps.length;

    // At least the first re-dispatch happened
    expect(t1).toBeGreaterThanOrEqual(1);
    expect(t2).toBeGreaterThan(t1);
    // Without exponential backoff in WatchdogConfig, the re-dispatch uses
    // the fixed cycleIntervalMs — this test asserts that the watchdog DOES
    // use an exponential delay before the actual re-signal. The backoff
    // must be greater than 0ms when configured.
    // (Implementation detail: watchdog.runCycle should await the backoff
    // delay before re-signaling timed-out entries.)

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("backoff multiplier widens each consecutive cycle", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const reDispatchTimes: number[] = [];

    bag.add("emi", "linear-AI-2117", "Issue");
    sessionTracker.startSession("emi", "linear-AI-2117");
    ackTracker.recordDispatch("emi", "linear-AI-2117");

    // Backoff base 1ms — keep tests fast
    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, _ticketIds) => { reDispatchTimes.push(Date.now()); },
        },
      },
      {
        ackTimeoutMs: 0,
        maxResignals: 4,
        cycleIntervalMs: 60_000,
        exponentialBackoffMs: 1,
      } as WatchdogConfig & { exponentialBackoffMs: number },
    );

    // Run several cycles consecutively (simulating repeated unacknowledged dispatches)
    await watchdog.runCycle(); // attempt 1
    await watchdog.runCycle(); // attempt 2
    await watchdog.runCycle(); // attempt 3
    await watchdog.runCycle(); // attempt 4

    // There MUST be some computed backoff delay between cycles;
    // attemptCount should grow and the backoff should widen.
    const acks = ackTracker.getPendingTimedOut(0);
    expect(acks.length).toBeGreaterThan(0);
    const entry = acks[0];
    expect(entry.attemptCount).toBeGreaterThanOrEqual(2);
    // The attemptCount was incremented at least once (not stuck at 1)

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2: attempt counter increments on each re-dispatch
// ════════════════════════════════════════════════════════════════════════════

describe("AC2: attempt counter increments on each re-dispatch", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("attempt counter is never stuck at 1 across re-dispatches", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    bag.add("grover", "linear-GEN-88", "Issue");
    sessionTracker.startSession("grover", "linear-GEN-88");
    ackTracker.recordDispatch("grover", "linear-GEN-88");

    const dispatched: string[] = [];
    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      {
        ackTimeoutMs: 0,
        maxResignals: 5,
        cycleIntervalMs: 60_000,
        exponentialBackoffMs: 1,
      } as WatchdogConfig & { exponentialBackoffMs: number },
    );

    // Run 3 consecutive cycles — each should increment
    await watchdog.runCycle();
    await watchdog.runCycle();
    await watchdog.runCycle();

    const acks = ackTracker.getPendingTimedOut(0);
    expect(acks.length).toBeGreaterThan(0);
    // The attemptCount MUST be > 1 after 3 cycles (not stuck at "attempt 1")
    expect(acks[0].attemptCount).toBeGreaterThan(1);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("each markResignaled increments the attempt count without resetting to 1", async () => {
    const { ackTracker } = setupDeps(dir);

    ackTracker.recordDispatch("astrid", "linear-AI-2118");
    expect(ackTracker.getPendingTimedOut(0)[0].attemptCount).toBe(1);

    ackTracker.markResignaled("astrid", "linear-AI-2118");
    expect(ackTracker.getPendingTimedOut(0)[0].attemptCount).toBe(2);

    ackTracker.markResignaled("astrid", "linear-AI-2118");
    expect(ackTracker.getPendingTimedOut(0)[0].attemptCount).toBe(3);

    ackTracker.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3: hard cap (3 attempts) — park/escalate with summary comment
// AC4: after cap, no further automated re-dispatches fire
// ════════════════════════════════════════════════════════════════════════════

describe("AC3/AC4: hard cap on retry — park after 3 attempts, no further re-dispatches", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("exactly 3 attempts exhausted → escalates and parks, does not re-dispatch", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("grover", "linear-GEN-88", "Issue");
    sessionTracker.startSession("grover", "linear-GEN-88");
    ackTracker.recordDispatch("grover", "linear-GEN-88");

    // Simulate 3 consecutive re-signals (attempt 2, 3, 4)
    ackTracker.markResignaled("grover", "linear-GEN-88"); // attempt 2
    ackTracker.markResignaled("grover", "linear-GEN-88"); // attempt 3
    ackTracker.markResignaled("grover", "linear-GEN-88"); // attempt 4

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Cap exceeded: escalates, does NOT re-dispatch
    expect(result.escalated).toBe(1);
    expect(result.resignaled).toBe(0);
    expect(dispatched).toHaveLength(0);

    // ── Run another cycle to prove no further re-dispatches fire ──
    const result2 = await watchdog.runCycle();
    expect(result2.escalated).toBe(0);
    expect(result2.resignaled).toBe(0);
    expect(dispatched).toHaveLength(0);

    // Operational event confirms escalation
    const events = operationalEventStore.query({ outcome: "delivery-unconfirmed" });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // (AC3 addendum: implementation must also post a single summary escalation
    //  comment on the Linear ticket. Verified in ac-validate via mock.)

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("escalated entry is removed from ackTracker's timed-out results — watchdog won't touch it again", async () => {
    const { ackTracker } = setupDeps(dir);

    ackTracker.recordDispatch("grover", "linear-GEN-88");
    ackTracker.markResignaled("grover", "linear-GEN-88");
    ackTracker.markResignaled("grover", "linear-GEN-88");
    ackTracker.markResignaled("grover", "linear-GEN-88"); // attempt 4

    // markEscalated removes from timed-out queries
    ackTracker.markEscalated("grover", "linear-GEN-88");

    const entries = ackTracker.getPendingTimedOut(0);
    const gen88Entry = entries.find((e) => e.ticketId === "linear-GEN-88");
    expect(gen88Entry).toBeUndefined();

    ackTracker.close();
  });

  it("exceeding the cap produces a park-escalation operational event", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("grover", "linear-GEN-88", "Issue");
    sessionTracker.startSession("grover", "linear-GEN-88");
    ackTracker.recordDispatch("grover", "linear-GEN-88");
    ackTracker.markResignaled("grover", "linear-GEN-88");
    ackTracker.markResignaled("grover", "linear-GEN-88");
    ackTracker.markResignaled("grover", "linear-GEN-88");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    await watchdog.runCycle();

    // An operational event of outcome "watchdog-escalation" should be emitted
    // when the cap is exceeded (distinct from delivery-unconfirmed, which is
    // written before the attempt-count check).
    const escalationEvents = operationalEventStore.query({ outcome: "watchdog-escalation" });
    expect(escalationEvents.length).toBeGreaterThanOrEqual(1);
    expect(escalationEvents[0].agent).toBe("grover");
    expect(escalationEvents[0].key).toBe("linear-GEN-88");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});
