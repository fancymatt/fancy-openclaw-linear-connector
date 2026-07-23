/**
 * AI-2008 — DispatchDeliveryScheduler.
 *
 * The armed, bootstrap-wired front door for acknowledged dispatch delivery. It
 * owns the retry/ack machinery (deliverWithAck) and is the object real dispatch
 * sites route through, so every workflow wake records a delivery outcome and
 * retries on failure (AC1: no fire-and-forget path).
 *
 * Liveness is genuine, not cosmetic: `schedulerActive` is false until `start()`
 * arms the driver and registers it in the connector cron registry, and
 * `pendingRetries` is the live count of in-flight retry waits inside the
 * delivery layer — not a value derived from a pre-existing store. This is the
 * dead-code-in-prod guard from AI-1808 (AI-1773/AI-1775 shipped fully tested but
 * never registered at bootstrap).
 */

import { OperationalEventStore } from "../store/operational-event-store.js";
import { DispatchAckTracker } from "../bag/dispatch-ack-tracker.js";
import { registerCron, formatIntervalMs, markCronRun } from "../cron/registry.js";
import { createLogger, componentLogger } from "../logger.js";
import {
  deliverWithAck,
  type DeliverWithAckParams,
  type DeliverWithAckOutcome,
} from "./deliver-with-ack.js";

const log = componentLogger(createLogger(), "dispatch-delivery-scheduler");

export interface DispatchDeliverySchedulerDeps {
  eventStore: OperationalEventStore;
  ackTracker: DispatchAckTracker;
  /** Liveness heartbeat interval; the timer keeps the driver observably armed. */
  heartbeatMs?: number;
}

/** Per-dispatch params — the stores + retry observers are supplied by the scheduler. */
export type SchedulerDispatchParams = Omit<
  DeliverWithAckParams,
  "eventStore" | "ackTracker" | "onRetryScheduled" | "onRetryResolved"
>;

const DEFAULT_HEARTBEAT_MS = 60_000;

export class DispatchDeliveryScheduler {
  private active = false;
  private inFlightRetries = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly heartbeatMs: number;

  constructor(private readonly deps: DispatchDeliverySchedulerDeps) {
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  /** Arm the driver. Registers in the cron registry on the timer-creation path. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.heartbeat = setInterval(() => {
      // Liveness heartbeat only — the retry loop runs inline in dispatch().
      markCronRun("dispatch-delivery-scheduler");
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
    registerCron(
      "dispatch-delivery-scheduler",
      `every ${formatIntervalMs(this.heartbeatMs)}`,
    );
    log.info("dispatch delivery scheduler armed");
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.active = false;
  }

  get schedulerActive(): boolean {
    return this.active;
  }

  get pendingRetries(): number {
    return this.inFlightRetries;
  }

  /** /health liveness field: `{ schedulerActive, pendingRetries }` (AC1, AI-1808). */
  liveness(): { schedulerActive: boolean; pendingRetries: number } {
    return { schedulerActive: this.active, pendingRetries: this.inFlightRetries };
  }

  /** Deliver a wake through the acknowledged, retrying, loud-failure path. */
  dispatch(params: SchedulerDispatchParams): Promise<DeliverWithAckOutcome> {
    return deliverWithAck({
      ...params,
      eventStore: this.deps.eventStore,
      ackTracker: this.deps.ackTracker,
      onRetryScheduled: () => {
        this.inFlightRetries++;
      },
      onRetryResolved: () => {
        this.inFlightRetries = Math.max(0, this.inFlightRetries - 1);
      },
    });
  }
}
