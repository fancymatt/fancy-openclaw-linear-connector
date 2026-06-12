/**
 * Tests for HeldRunRetrier — AI-1533.
 *
 * Problem: when an agent is dispatched, runs briefly, and ends without making any
 * state-advancing transition (a "held run"), the ticket is silently stranded.
 * The no-activity-detector only fires at its fail threshold (up to 900s later);
 * transient holds should self-heal sooner.
 *
 * This component watches per-(agent, ticket) dispatch windows. If a session ends
 * with no observed transition within `dispatchRetryGraceMs`, it re-dispatches.
 * After `maxAttempts` retries it stops retrying and leaves the ticket for the
 * existing no-activity fail path.
 *
 * AC (AI-1533):
 *   1. No transition within dispatchRetryGraceMs → re-dispatch (held-run-then-retry)
 *   2. Transition observed → no re-dispatch (healthy-run-no-retry)
 *   3. Max attempts exhausted → no further dispatch, fall through to no-activity fail (max-attempts-then-fail)
 *   4. Transition clears retry state (transition-clears-retry-state)
 *   5. Existing no-activity-detector tests unaffected (covered by no-activity-detector.test.ts)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import { HeldRunRetrier } from "./held-run-retrier.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "held-run-retrier-test-"));
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, operationalEventStore };
}

describe("HeldRunRetrier", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // AC test 1 — named in AC: held-run-then-retry
  test("held-run-then-retry: re-dispatches when session ends with no transition observed", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-1531");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    // Dispatch recorded at intake
    retrier.trackDispatch("astrid", "linear-AI-1531");

    // Agent ran but held — no transition recorded
    // Session ends (agent's one-shot run completed with no workflow transition)
    const retried = await retrier.onSessionEnd("astrid", "linear-AI-1531");

    expect(retried).toBe(true);
    expect(dispatched).toContain("linear-AI-1531");

    // Operational event records the held-run retry
    const events = operationalEventStore.query({ outcome: "held-run-retry" });
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe("astrid");
    expect(events[0].key).toBe("linear-AI-1531");

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // AC test 2 — named in AC: healthy-run-no-retry
  test("healthy-run-no-retry: no re-dispatch when a state-advancing transition was observed", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-1531");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    retrier.trackDispatch("astrid", "linear-AI-1531");

    // Agent made a state-advancing transition — e.g. handoff-work, consider-work, etc.
    retrier.recordTransition("astrid", "linear-AI-1531");

    // Session ends — healthy run, transition was observed
    const retried = await retrier.onSessionEnd("astrid", "linear-AI-1531");

    expect(retried).toBe(false);
    expect(dispatched).toHaveLength(0);

    // No held-run-retry event
    const events = operationalEventStore.query({ outcome: "held-run-retry" });
    expect(events).toHaveLength(0);

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // AC test 3 — named in AC: max-attempts-then-fail
  test("max-attempts-then-fail: stops retrying after maxAttempts and falls through to no-activity path", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    // Cycle 1: dispatch + held run → retry #1
    retrier.trackDispatch("astrid", "linear-AI-1531");
    sessionTracker.startSession("astrid", "linear-AI-1531");
    const retried1 = await retrier.onSessionEnd("astrid", "linear-AI-1531");
    expect(retried1).toBe(true);
    expect(dispatched).toHaveLength(1);

    // Cycle 2: retry #1 session + held run → retry #2
    sessionTracker.startSession("astrid", "linear-AI-1531");
    const retried2 = await retrier.onSessionEnd("astrid", "linear-AI-1531");
    expect(retried2).toBe(true);
    expect(dispatched).toHaveLength(2);

    // Cycle 3: retry #2 session + held run → max attempts exhausted, no further dispatch
    sessionTracker.startSession("astrid", "linear-AI-1531");
    const retried3 = await retrier.onSessionEnd("astrid", "linear-AI-1531");
    expect(retried3).toBe(false);
    // Dispatch count stays at 2 — no third re-dispatch
    expect(dispatched).toHaveLength(2);

    // held-run-exhausted event logged so the operator / no-activity-detector can pick it up
    const exhaustedEvents = operationalEventStore.query({ outcome: "held-run-exhausted" });
    expect(exhaustedEvents).toHaveLength(1);
    expect(exhaustedEvents[0].agent).toBe("astrid");
    expect(exhaustedEvents[0].key).toBe("linear-AI-1531");

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // AC test 4 — named in AC: transition-clears-retry-state
  test("transition-clears-retry-state: recording a transition stops further retries for that (agent, ticket)", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    // Cycle 1: dispatch + held run → retry
    retrier.trackDispatch("astrid", "linear-AI-1531");
    sessionTracker.startSession("astrid", "linear-AI-1531");
    const retried1 = await retrier.onSessionEnd("astrid", "linear-AI-1531");
    expect(retried1).toBe(true);
    expect(dispatched).toHaveLength(1);

    // Cycle 2: retry session completes with a real transition (e.g. handoff-work fires)
    sessionTracker.startSession("astrid", "linear-AI-1531");
    retrier.recordTransition("astrid", "linear-AI-1531");
    const retried2 = await retrier.onSessionEnd("astrid", "linear-AI-1531");

    // Transition observed — no retry, state cleared
    expect(retried2).toBe(false);
    expect(dispatched).toHaveLength(1); // still only the first retry

    // Cycle 3: even if another session ends for this ticket, no retry state remains
    sessionTracker.startSession("astrid", "linear-AI-1531");
    const retried3 = await retrier.onSessionEnd("astrid", "linear-AI-1531");
    expect(retried3).toBe(false);

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // AC point 4: retry decision clears when delegate changes
  test("onDelegateChange clears retry state so a new delegate is not penalized by prior held runs", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    // Astrid holds once — retry count = 1
    retrier.trackDispatch("astrid", "linear-AI-1531");
    sessionTracker.startSession("astrid", "linear-AI-1531");
    await retrier.onSessionEnd("astrid", "linear-AI-1531");
    expect(dispatched).toHaveLength(1);

    // Ticket is re-delegated to a different agent
    retrier.onDelegateChange("linear-AI-1531");

    // New agent (charles) dispatched — should start with a clean attempt count
    bag.add("charles", "linear-AI-1531", "Issue");
    retrier.trackDispatch("charles", "linear-AI-1531");
    sessionTracker.startSession("charles", "linear-AI-1531");
    // Charles also holds on first try — still within max 2 attempts for charles
    const retried = await retrier.onSessionEnd("charles", "linear-AI-1531");
    expect(retried).toBe(true);

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // Edge: no-op when onSessionEnd called for an untracked (agent, ticket)
  test("onSessionEnd is a no-op when no dispatch was tracked for that pair", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    // No trackDispatch was called
    const retried = await retrier.onSessionEnd("astrid", "linear-AI-9999");
    expect(retried).toBe(false);
    expect(dispatched).toHaveLength(0);

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // Edge: non-actionable ticket is pruned rather than retried
  test("does not retry a non-actionable ticket (ticket was resolved/cancelled during the held run)", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-1531");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => false, // ticket no longer actionable
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    retrier.trackDispatch("astrid", "linear-AI-1531");
    const retried = await retrier.onSessionEnd("astrid", "linear-AI-1531");

    expect(retried).toBe(false);
    expect(dispatched).toHaveLength(0);

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });

  // Verify retry state is per-(agent, ticket): one pair holding does not affect another
  test("held-run retry state is isolated per (agent, ticket) — unrelated pairs unaffected", async () => {
    const { bag, sessionTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-1531", "Issue");
    bag.add("astrid", "linear-AI-1532", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-1531");
    sessionTracker.startSession("astrid", "linear-AI-1532");

    const retrier = new HeldRunRetrier(
      {
        bag,
        sessionTracker,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { dispatchRetryGraceMs: 120_000, maxAttempts: 2 },
    );

    // Track dispatch for both
    retrier.trackDispatch("astrid", "linear-AI-1531");
    retrier.trackDispatch("astrid", "linear-AI-1532");

    // AI-1532 makes a healthy transition
    retrier.recordTransition("astrid", "linear-AI-1532");

    // AI-1531 holds; AI-1532 is healthy
    const retried1531 = await retrier.onSessionEnd("astrid", "linear-AI-1531");
    const retried1532 = await retrier.onSessionEnd("astrid", "linear-AI-1532");

    expect(retried1531).toBe(true);
    expect(dispatched).toContain("linear-AI-1531");

    expect(retried1532).toBe(false);
    expect(dispatched).not.toContain("linear-AI-1532");

    bag.close();
    sessionTracker.close();
    operationalEventStore.close();
  });
});
