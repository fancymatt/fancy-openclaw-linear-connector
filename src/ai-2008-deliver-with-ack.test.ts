/**
 * AI-2008 — Dispatch delivery acknowledgment + retry — no fire-and-forget wakes.
 *
 * Orchestration contract: `deliverWithAck` wraps a single delivery attempt with
 * outcome recording, bounded retry-with-backoff, ack expectation registration,
 * and loud exhaustion surfacing. This is the seam that removes the fire-and-forget
 * path (AC1) and produces the retry/exhaustion behavior in AC2/AC3/AC5.
 *
 * The module `./delivery/deliver-with-ack.js` does not exist yet — these tests are
 * the contract the implementer (igor) must satisfy. `deliver` is injected so the
 * orchestration can be exercised without a live gateway; `sleep` is injected so
 * backoff is asserted deterministically without real timers.
 *
 * Expected surface (implementer fills in):
 *   deliverWithAck(params: {
 *     agentId, ticketId, workflowState?, gateway?, dispatchId,
 *     deliver: (ctx: { attempt: number; dispatchId: string }) => Promise<DeliveryResult>,
 *     eventStore: OperationalEventStore,
 *     ackTracker: DispatchAckTracker,
 *     maxRetries?: number,
 *     backoffMs?: (attempt: number) => number,
 *     sleep?: (ms: number) => Promise<void>,
 *   }): Promise<{ status: "delivered" | "undeliverable"; attempts: number; dispatchId: string }>
 *
 * AC mapping:
 *   AC1 — every dispatch records a delivery outcome; no fire-and-forget path.
 *   AC2 — failed/unconfirmed → automatic retry with backoff (bounded), each
 *         attempt logged to the operational event store.
 *   AC3 — after final retry failure, a dispatch-undeliverable warning is emitted.
 *   AC5 — ack happy path; unack → retry → success; retry exhaustion → warning;
 *         no double-execution (stable dispatch id across retries).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliverWithAck } from "./delivery/deliver-with-ack.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import type { DeliveryResult } from "./delivery/deliver.js";

const OK: DeliveryResult = { dispatched: true, runId: "run-ok" };
const FAIL: DeliveryResult = { dispatched: false, hookErrorSummary: "gateway unreachable" };

const FAILED_OUTCOMES = new Set(["delivery-failed", "delivery-unconfirmed"]);

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-2008-${prefix}-`));
}

describe("AI-2008 deliverWithAck — dispatch delivery ack + retry", () => {
  let dir: string;
  let eventStore: OperationalEventStore;
  let ackTracker: DispatchAckTracker;
  let sleeps: number[];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };

  beforeEach(() => {
    dir = tmpDir("dwa");
    eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
    sleeps = [];
  });

  afterEach(() => {
    eventStore.close();
    ackTracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC5 ack happy path: delivers on the first attempt, records outcome + ack expectation", async () => {
    const calls: number[] = [];
    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2008",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-happy-1",
      deliver: async ({ attempt }) => {
        calls.push(attempt);
        return OK;
      },
      eventStore,
      ackTracker,
      maxRetries: 3,
      backoffMs: (n) => n * 10,
      sleep,
    });

    expect(outcome.status).toBe("delivered");
    expect(outcome.attempts).toBe(1);
    expect(calls).toEqual([1]); // no retries on success
    expect(sleeps).toEqual([]); // no backoff on a first-attempt success

    // A delivery outcome is recorded (AC1: no fire-and-forget).
    const events = eventStore.query({ key: "linear-AI-2008" });
    expect(events.some((e) => e.outcome === "delivered")).toBe(true);

    // An ack expectation is registered so an unacked wake self-heals via the watchdog.
    const acks = ackTracker.listRecent();
    expect(acks.some((a) => a.agentId === "igor" && a.ticketId === "linear-AI-2008")).toBe(true);
  });

  it("AC2/AC5 unack → retry → success: retries with backoff and logs every attempt", async () => {
    const calls: number[] = [];
    const responses = [FAIL, FAIL, OK];
    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2008",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-retry-1",
      deliver: async ({ attempt }) => {
        calls.push(attempt);
        return responses[attempt - 1];
      },
      eventStore,
      ackTracker,
      maxRetries: 3,
      backoffMs: (n) => n * 10,
      sleep,
    });

    expect(outcome.status).toBe("delivered");
    expect(outcome.attempts).toBe(3);
    expect(calls).toEqual([1, 2, 3]);

    // Backoff between attempts, increasing (attempt 1→2 waits backoffMs(1), 2→3 waits backoffMs(2)).
    expect(sleeps).toEqual([10, 20]);

    // Each failed attempt is logged to the operational event store (AC2).
    const events = eventStore.query({ key: "linear-AI-2008" });
    const failedAttempts = events.filter((e) => FAILED_OUTCOMES.has(e.outcome));
    expect(failedAttempts.length).toBe(2);
    // Attempt numbers are recorded so the timeline can show "retrying (N)".
    expect(failedAttempts.map((e) => e.attemptCount).sort()).toEqual([1, 2]);
    // Terminal success is recorded too.
    expect(events.some((e) => e.outcome === "delivered")).toBe(true);
    // No exhaustion warning on eventual success.
    expect(events.some((e) => e.outcome === "dispatch-undeliverable")).toBe(false);
  });

  it("AC2/AC3 retry exhaustion → warning: bounded attempts then dispatch-undeliverable", async () => {
    const calls: number[] = [];
    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2008",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-exhaust-1",
      deliver: async ({ attempt }) => {
        calls.push(attempt);
        return FAIL;
      },
      eventStore,
      ackTracker,
      maxRetries: 2,
      backoffMs: (n) => n * 10,
      sleep,
    });

    expect(outcome.status).toBe("undeliverable");
    // Bounded: maxRetries=2 → exactly 3 attempts, never unbounded.
    expect(calls).toEqual([1, 2, 3]);
    expect(outcome.attempts).toBe(3);

    const events = eventStore.query({ key: "linear-AI-2008" });
    const warning = events.find((e) => e.outcome === "dispatch-undeliverable");
    expect(warning).toBeDefined();
    // The warning names ticket, state, delegate, and gateway (loud, actionable).
    const detail = warning!.detail as Record<string, unknown>;
    expect(detail.ticket).toBe("AI-2008");
    expect(detail.state).toBe("implementation");
    expect(detail.delegate).toBe("igor");
    expect(detail.gateway).toBe("grover");
  });

  it("AC5 no double-execution: the same dispatch id is reused across every retry", async () => {
    const seenDispatchIds: string[] = [];
    await deliverWithAck({
      agentId: "igor",
      ticketId: "AI-2008",
      workflowState: "implementation",
      gateway: "grover",
      dispatchId: "disp-stable-xyz",
      deliver: async ({ dispatchId }) => {
        seenDispatchIds.push(dispatchId);
        return FAIL;
      },
      eventStore,
      ackTracker,
      maxRetries: 2,
      backoffMs: () => 0,
      sleep,
    });

    // Every attempt carries the identical dispatch id so the receiver can dedup
    // (idempotent on the receiving side) — a retried wake never executes twice.
    expect(seenDispatchIds.length).toBe(3);
    expect(new Set(seenDispatchIds)).toEqual(new Set(["disp-stable-xyz"]));
  });

  it("AC5 distinct dispatches carry distinct ids (dedup key is per-dispatch, not global)", async () => {
    const idA: string[] = [];
    const idB: string[] = [];
    const base = {
      agentId: "igor",
      ticketId: "AI-2008",
      workflowState: "implementation",
      gateway: "grover",
      eventStore,
      ackTracker,
      maxRetries: 0,
      backoffMs: () => 0,
      sleep,
    };
    const a = await deliverWithAck({
      ...base,
      dispatchId: "disp-A",
      deliver: async ({ dispatchId }) => {
        idA.push(dispatchId);
        return OK;
      },
    });
    const b = await deliverWithAck({
      ...base,
      dispatchId: "disp-B",
      deliver: async ({ dispatchId }) => {
        idB.push(dispatchId);
        return OK;
      },
    });

    expect(a.dispatchId).toBe("disp-A");
    expect(b.dispatchId).toBe("disp-B");
    expect(idA).toEqual(["disp-A"]);
    expect(idB).toEqual(["disp-B"]);
  });
});
