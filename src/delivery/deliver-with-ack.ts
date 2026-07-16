/**
 * AI-2008 — Dispatch delivery acknowledgment + retry — no fire-and-forget wakes.
 *
 * `deliverWithAck` is the seam that removes the fire-and-forget dispatch path
 * and owns dispatch retry. The injected delivery primitive performs one
 * attempt per call; this module is the only retry loop. It wraps delivery with:
 *   - a recorded delivery outcome for EVERY attempt (AC1: no fire-and-forget),
 *   - bounded retry-with-backoff on failed/unconfirmed delivery (AC2),
 *   - a loud `dispatch-undeliverable` warning after the final attempt fails,
 *     naming ticket / state / delegate / gateway (AC3),
 *   - an ack expectation registered on success so an unacked wake still
 *     self-heals via the dispatch watchdog,
 *   - a stable dispatch id reused across every retry for delivery paths that
 *     carry it. The gateway path does not send dispatchId today, so queued
 *     connect-established aborts are treated as pending ack and not retried,
 *     making receiver-side dedup unnecessary for that case.
 *
 * `deliver` is injected so the orchestration is exercisable without a live
 * gateway; `sleep` is injected so backoff is asserted without real timers.
 */

import { normalizeSessionKey } from "../session-key.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { DispatchAckTracker } from "../bag/dispatch-ack-tracker.js";
import type { DeliveryResult } from "./deliver.js";

export interface DeliverWithAckParams {
  /** Delegate agent id (also the "delegate" named in the loud warning). */
  agentId: string;
  /** Linear ticket id (raw, e.g. "AI-2008" — normalized internally for keys). */
  ticketId: string;
  /** Workflow state at dispatch time (e.g. "implementation"). */
  workflowState?: string;
  /** Gateway/host the delegate lives on (e.g. "grover"). */
  gateway?: string;
  /**
   * Stable dispatch id. Reused verbatim across every retry so the receiving
   * side can dedup (idempotent) — a retried wake never double-executes.
   */
  dispatchId: string;
  /** The single-attempt delivery primitive. Injected for testability. */
  deliver: (ctx: { attempt: number; dispatchId: string }) => Promise<DeliveryResult>;
  eventStore: OperationalEventStore;
  ackTracker: DispatchAckTracker;
  /** Max RETRIES after the first attempt (bounded). Total attempts = maxRetries + 1. */
  maxRetries?: number;
  /** Backoff before the Nth retry, keyed by the attempt that just failed. */
  backoffMs?: (attempt: number) => number;
  /** Sleep primitive. Injected so backoff is deterministic in tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * AI-2008: retry-depth observers so the DispatchDeliveryScheduler can report a
   * genuine live `pendingRetries` (in-flight backoff waits in the delivery
   * layer), not a value derived from a pre-existing store. Called around each
   * backoff wait; no-ops when a caller invokes deliverWithAck directly.
   */
  onRetryScheduled?: () => void;
  onRetryResolved?: () => void;
}

export interface DeliverWithAckOutcome {
  status: "delivered" | "delivered-pending-ack" | "undeliverable";
  attempts: number;
  dispatchId: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = (attempt: number): number => Math.min(attempt * 5_000, 60_000);
const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed attempt with an explicit error is "failed"; a silent miss is "unconfirmed". */
function failureOutcome(result: DeliveryResult): "delivery-failed" | "delivery-unconfirmed" {
  return result.hookError || result.hookErrorSummary ? "delivery-failed" : "delivery-unconfirmed";
}

export async function deliverWithAck(params: DeliverWithAckParams): Promise<DeliverWithAckOutcome> {
  const {
    agentId,
    ticketId,
    workflowState,
    gateway,
    dispatchId,
    deliver,
    eventStore,
    ackTracker,
  } = params;

  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = params.sleep ?? DEFAULT_SLEEP;

  // Canonical key for the operational event store and ack tracker.
  const key = normalizeSessionKey(ticketId);
  // Display ticket id for the loud warning (strip any linear- prefix).
  const displayTicket = ticketId.replace(/^linear-/i, "").toUpperCase();
  const totalAttempts = maxRetries + 1;

  const baseDetail = {
    ticket: displayTicket,
    state: workflowState ?? null,
    delegate: agentId,
    gateway: gateway ?? null,
    dispatchId,
    attemptBound: totalAttempts,
  };

  let attempt = 0;
  while (attempt < totalAttempts) {
    attempt += 1;
    const result = await deliver({ attempt, dispatchId });

    if (result.dispatched) {
      // AC1: record the delivery outcome — no fire-and-forget.
      eventStore.append({
        outcome: "delivered",
        agent: agentId,
        key,
        sessionKey: key,
        workflowState: workflowState ?? null,
        attemptCount: attempt,
        runId: result.runId ?? null,
        wakeId: dispatchId,
        detail: baseDetail,
      });
      // Register the ack expectation so an unacked wake self-heals via the watchdog.
      ackTracker.recordDispatch(agentId, ticketId);
      return { status: "delivered", attempts: attempt, dispatchId };
    }

    if (result.pendingAck) {
      eventStore.append({
        outcome: "delivery-pending-ack",
        agent: agentId,
        key,
        sessionKey: key,
        workflowState: workflowState ?? null,
        attemptCount: attempt,
        wakeId: dispatchId,
        detail: baseDetail,
      });
      ackTracker.recordDispatch(agentId, ticketId);
      return { status: "delivered-pending-ack", attempts: attempt, dispatchId };
    }

    // AC2: log every failed/unconfirmed attempt to the operational event store.
    eventStore.append({
      outcome: failureOutcome(result),
      agent: agentId,
      key,
      sessionKey: key,
      workflowState: workflowState ?? null,
      attemptCount: attempt,
      wakeId: dispatchId,
      errorSummary: result.hookErrorSummary ?? null,
      detail: baseDetail,
    });

    // Bounded retry with backoff — only wait when another attempt follows.
    if (attempt < totalAttempts) {
      params.onRetryScheduled?.();
      try {
        await sleep(backoffMs(attempt));
      } finally {
        params.onRetryResolved?.();
      }
    }
  }

  // AC3: every attempt failed — emit a loud, first-class undeliverable warning
  // naming ticket, state, delegate, and gateway. Not a silent log line.
  eventStore.append({
    outcome: "dispatch-undeliverable",
    agent: agentId,
    key,
    sessionKey: key,
    workflowState: workflowState ?? null,
    attemptCount: totalAttempts,
    wakeId: dispatchId,
    errorSummary: `dispatch-undeliverable after ${totalAttempts} attempt(s): ${displayTicket} (${workflowState ?? "?"}) → ${agentId} @ ${gateway ?? "?"}`,
    detail: baseDetail,
  });

  return { status: "undeliverable", attempts: totalAttempts, dispatchId };
}
