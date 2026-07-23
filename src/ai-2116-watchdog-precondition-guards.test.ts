/**
 * AI-2116 — Dispatch watchdog precondition guards: resolve-check, delegate-match,
 * workflow-state precondition.
 *
 * FAILING tests (TDD write-tests state). RED until implementation adds the
 * missing precondition checks in DispatchWatchdog / resignal path.
 *
 * AC mapping:
 *   AC5 — resolve-check: validate target ticket ID resolves to a real issue
 *         before re-dispatch; if unresolvable, drop and escalate once without retry
 *   AC6 — delegate-match guard: dispatch only wakes the ticket's current delegate;
 *         if delegate changed since last dispatch, re-evaluate
 *   AC7 — workflow-state precondition check: verify the ticket is in a workflow
 *         with a resolvable forward verb before emitting a "run pending transition" wake
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-2116-pcg-"));
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
// AC5: resolve-check — verify target ticket ID resolves before re-dispatch
// ════════════════════════════════════════════════════════════════════════════

describe("AC5: resolve-check — only re-dispatch if ticket resolves in Linear", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("skips re-dispatch when ticket ID does not resolve to a real Linear issue", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    // Phantom ticket — the existing pattern from Symptom B (AI-2014 was non-existent)
    bag.add("astrid", "linear-AI-2014", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2014");
    ackTracker.recordDispatch("astrid", "linear-AI-2014");

    // resolveCheck returns false — ticket doesn't exist
    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        linearResolveCheck: async (_ticketId: string) => false,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // No re-dispatch for unresolvable ticket
    expect(result.resignaled).toBe(0);
    expect(dispatched).toHaveLength(0);

    // Must emit an escalation/drop operational event once
    const dropEvents = operationalEventStore.query({ outcome: "watchdog-drop-unresolvable" });
    expect(dropEvents.length).toBeGreaterThanOrEqual(1);
    expect(dropEvents[0].agent).toBe("astrid");
    expect(dropEvents[0].key).toBe("linear-AI-2014");

    // After drop, no further attempts fire on subsequent cycles
    const result2 = await watchdog.runCycle();
    expect(result2.resignaled).toBe(0);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("re-dispatches normally when ticket resolves (resolveCheck returns true)", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("emi", "linear-AI-2116", "Issue");
    sessionTracker.startSession("emi", "linear-AI-2116");
    ackTracker.recordDispatch("emi", "linear-AI-2116");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        linearResolveCheck: async (_ticketId: string) => true,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.resignaled).toBe(1);
    expect(dispatched).toContain("linear-AI-2116");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC6: delegate-match guard — only wake the ticket's current delegate
// ════════════════════════════════════════════════════════════════════════════

describe("AC6: delegate-match guard — dispatch only to current delegate", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("skips re-dispatch when delegate changed since last dispatch (wrong agent)", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    // Ticket AI-2116 was delegated to Astrid at dispatch time
    bag.add("astrid", "linear-AI-2116", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2116");
    ackTracker.recordDispatch("astrid", "linear-AI-2116");

    // Delegate changed: the current delegate is now Grover, not Astrid
    const delegateCheck = async (_ticketId: string, agentId: string) => {
      // Return the CURRENT delegate for the ticket — Grover, not Astrid
      return agentId === "grover";
    };

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        delegateCheck,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Re-dispatch skipped because delegate no longer matches Astrid
    expect(result.resignaled).toBe(0);
    expect(dispatched).toHaveLength(0);

    // Must emit an operational event documenting the delegate mismatch
    const mismatchEvents = operationalEventStore.query({ outcome: "watchdog-delegate-mismatch" });
    expect(mismatchEvents.length).toBeGreaterThanOrEqual(1);
    expect(mismatchEvents[0].agent).toBe("astrid");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("re-dispatches when delegate still matches", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-2116", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2116");
    ackTracker.recordDispatch("astrid", "linear-AI-2116");

    const delegateCheck = async (_ticketId: string, agentId: string) => agentId === "astrid";

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        delegateCheck,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.resignaled).toBe(1);
    expect(dispatched).toContain("linear-AI-2116");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("delegate-check error (transient) fails open — re-dispatch proceeds", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-2116", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2116");
    ackTracker.recordDispatch("astrid", "linear-AI-2116");

    // Transient error: delegateCheck throws
    const delegateCheck = async (_ticketId: string, _agentId: string) => {
      throw new Error("Linear API transient error");
    };

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        delegateCheck,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Fail open: re-dispatch proceeds on transient error
    expect(result.resignaled).toBe(1);
    expect(dispatched).toContain("linear-AI-2116");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC7: workflow-state precondition check — verify ticket has resolvable verb
// ════════════════════════════════════════════════════════════════════════════

describe("AC7: workflow-state precondition — only fabricate transition wake if resolvable verb exists", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("skips re-dispatch when ticket has no workflow or no resolvable forward verb", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    // Ticket AI-2116 is parked — To Do, delegate Astrid, no active workflow
    bag.add("astrid", "linear-AI-2116", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2116");
    ackTracker.recordDispatch("astrid", "linear-AI-2116");

    // Workflow check: no resolvable forward verb (simulates Symptom D:
    // ticket is parked, not in any dev-impl workflow)
    const workflowStateCheck = async (_ticketId: string) => ({
      inWorkflow: false,
      resolvableVerb: null as string | null,
    });

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        workflowStateCheck,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // No re-dispatch because ticket has no active workflow / resolvable verb
    expect(result.resignaled).toBe(0);
    expect(dispatched).toHaveLength(0);

    // Operational event documenting the skipped wake
    const skipEvents = operationalEventStore.query({ outcome: "watchdog-skip-no-workflow" });
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("re-dispatches when ticket has a workflow with a resolvable forward verb", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-2116", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2116");
    ackTracker.recordDispatch("astrid", "linear-AI-2116");

    const workflowStateCheck = async (_ticketId: string) => ({
      inWorkflow: true,
      resolvableVerb: "continue-workflow" as string | null,
    });

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        workflowStateCheck,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    expect(result.resignaled).toBe(1);
    expect(dispatched).toContain("linear-AI-2116");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  it("workflow-state check error (transient) fails open — re-dispatch proceeds", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    bag.add("astrid", "linear-AI-2116", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2116");
    ackTracker.recordDispatch("astrid", "linear-AI-2116");

    const workflowStateCheck = async (_ticketId: string) => {
      throw new Error("workflow registry transient error");
    };

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,
        workflowStateCheck,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Fail open: re-dispatch proceeds on transient error
    expect(result.resignaled).toBe(1);
    expect(dispatched).toContain("linear-AI-2116");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Combined: all three precondition guards fire in one cycle
// ════════════════════════════════════════════════════════════════════════════

describe("All precondition guards: resolve + delegate + workflow fire together", () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("skips only the entries that fail a guard, proceeds for passing entries", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const dispatched: string[] = [];

    // Ticket 1: passes all guards → should be resignaled
    bag.add("emi", "linear-AI-2119", "Issue");
    sessionTracker.startSession("emi", "linear-AI-2119");
    ackTracker.recordDispatch("emi", "linear-AI-2119");

    // Ticket 2: phantom (fails resolve check) → should be dropped
    bag.add("astrid", "linear-AI-2014", "Issue");
    sessionTracker.startSession("astrid", "linear-AI-2014");
    ackTracker.recordDispatch("astrid", "linear-AI-2014");

    // Ticket 3: wrong delegate → should be skipped
    bag.add("igor", "linear-AI-2117", "Issue");
    sessionTracker.startSession("igor", "linear-AI-2117");
    ackTracker.recordDispatch("igor", "linear-AI-2117");

    const watchdog = new DispatchWatchdog(
      {
        bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig,

        linearResolveCheck: async (ticketId: string) => ticketId !== "linear-AI-2014",

        delegateCheck: async (_ticketId: string, agentId: string) => {
          // Ticket B (now AI-2117) moved to a different delegate
          if (_ticketId === "linear-AI-2117") return agentId === "sage";
          return agentId === "emi";
        },

        workflowStateCheck: async (_ticketId: string) => ({
          inWorkflow: true,
          resolvableVerb: "continue-workflow" as string | null,
        }),

        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { dispatched.push(...ticketIds); },
        },
      },
      { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
    );

    const result = await watchdog.runCycle();

    // Only ticket A (which passes all guards) should be resignaled
    expect(result.resignaled).toBe(1);
    expect(dispatched).toContain("linear-AI-2119");
    expect(dispatched).not.toContain("linear-AI-2014");
    expect(dispatched).not.toContain("linear-AI-2117");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});
