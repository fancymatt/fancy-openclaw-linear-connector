/**
 * AI-1664: No-activity detector should count proxy calls as evidence of agent starting.
 *
 * AC coverage:
 *   AC1+4: NoActivityDetector.recordProxyActivity(agentId, ticketId) satisfies the no-activity
 *          timer — equivalent to "proxy call at T+100s prevents failure declaration at T+308s".
 *   AC2:   Without a proxy call, existing failure detection still fires (regression guard).
 *   AC3a:  Proxy call for a different ticket does not satisfy the dispatched ticket's timer.
 *   AC3b:  Proxy call with a non-normalizable ID (UUID, garbage) is silently ignored.
 *   AC3c:  Proxy call attributed to a different agent does not satisfy the dispatched agent's timer.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "no-activity-ai1664-test-"));
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, ackTracker, operationalEventStore };
}

describe("NoActivityDetector — proxy call evidence (AI-1664)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1+AC4: recordProxyActivity satisfies the no-activity timer (proxy call at T+100s prevents failure at T+308s)", async () => {
    // Simulates the Emi reproduction: agent dispatched, makes proxy calls at T+6s,
    // detector should NOT declare failure at T+308s (failMs=0 = immediate failure without evidence).
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const failedTickets: string[] = [];

    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { failedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // Proxy call recorded at T+100s (before the T+308s fail cycle in production).
    // failMs=0 means the cycle would immediately declare failure without this call.
    detector.recordProxyActivity("emi", "AI-1664");

    const result = await detector.runCycle();

    // Timer satisfied: no failure or warning declared
    expect(result.failed).toBe(0);
    expect(result.warned).toBe(0);
    expect(failedTickets).toHaveLength(0);

    const events = operationalEventStore.query({ outcome: "no-activity-failed" });
    expect(events).toHaveLength(0);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AC1: recordProxyActivity also accepts the normalized linear- prefix form", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // Fully normalized form should also work
    detector.recordProxyActivity("emi", "linear-AI-1664");

    const result = await detector.runCycle();
    expect(result.failed).toBe(0);
    expect(result.warned).toBe(0);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AC2: without a proxy call, existing failure detection fires unchanged (regression guard)", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const failedTickets: string[] = [];

    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { failedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // No recordProxyActivity call — normal path
    const result = await detector.runCycle();

    expect(result.failed).toBe(1);
    expect(failedTickets).toContain("linear-AI-1664");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AC3a: proxy call for a different ticket does not satisfy the dispatched ticket's timer", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const failedTickets: string[] = [];

    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { failedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // Proxy call for a DIFFERENT ticket — AI-9999 is not the dispatched ticket
    detector.recordProxyActivity("emi", "AI-9999");

    const result = await detector.runCycle();

    // The original dispatched ticket (AI-1664) should still be detected as failed
    expect(result.failed).toBe(1);
    expect(failedTickets).toContain("linear-AI-1664");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AC3b: proxy call with a UUID (non-normalizable ID) is silently ignored", async () => {
    // When the proxy has only a UUID (issueUpdate mutation) and no Linear identifier,
    // the call cannot be matched to a dispatch and must not affect the timer.
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const failedTickets: string[] = [];

    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { failedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // UUID form — not a valid Linear identifier, should be silently ignored
    detector.recordProxyActivity("emi", "e6ef9813-4baa-4cbf-bbe6-f5d9164d4916");

    const result = await detector.runCycle();

    expect(result.failed).toBe(1);
    expect(failedTickets).toContain("linear-AI-1664");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AC3c: proxy call attributed to a different agent does not satisfy the dispatched agent's timer", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);
    const failedTickets: string[] = [];

    // Ticket dispatched to emi
    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      {
        sessionTracker,
        ackTracker,
        bag,
        operationalEventStore,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => { failedTickets.push(...ticketIds); },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // Proxy call attributed to DIFFERENT agent (felix, not emi)
    detector.recordProxyActivity("felix", "AI-1664");

    const result = await detector.runCycle();

    // Emi's dispatch is still pending — felix's call doesn't satisfy emi's timer
    expect(result.failed).toBe(1);
    expect(failedTickets).toContain("linear-AI-1664");

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("AC1: recordProxyActivity is idempotent — multiple proxy calls keep the timer satisfied", async () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    bag.add("emi", "linear-AI-1664", "Issue");
    sessionTracker.startSession("emi", "linear-AI-1664");
    ackTracker.recordDispatch("emi", "linear-AI-1664");

    const detector = new NoActivityDetector(
      { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig },
      { warnMs: 0, failMs: 0, pollMs: 60_000 },
    );

    // Multiple proxy calls — idempotent, should not cause errors or double-count
    detector.recordProxyActivity("emi", "AI-1664");
    detector.recordProxyActivity("emi", "AI-1664");
    detector.recordProxyActivity("emi", "AI-1664");

    const result = await detector.runCycle();
    expect(result.failed).toBe(0);

    detector.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});
