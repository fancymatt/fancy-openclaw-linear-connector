/**
 * Phase 6.5 / H-3 (AI-1478) — Engine stall detection + agent response.
 *
 * **Engine owns detection.** Each state carries a time-in-state SLA (from workflow
 * def YAML); when an outstanding child breaches it, the engine detects the breach
 * and emits a stall event against that specific child and its ancestor chain.
 * The parent does not poll for staleness.
 *
 * **Parent agent owns the qualitative response.** On a stall event, the `managing`
 * owner decides what the situation needs — nudge, guidance, or escalation of the
 * specific stuck child (barrier-level break-glass, §5.3).
 *
 * **At-capacity ≠ stall.** A legitimately deferred/at-capacity child (the AI-1339
 * case) has its waiting time attributed up the ancestor SLA accounting as
 * **known deferral**, so an overloaded-but-healthy subtree does not trip stall
 * escalation while a genuinely stuck leaf still does.
 *
 * This module:
 *   - Re-exports StallEvent, DeferralAccountant from barrier.ts (canonical types).
 *   - Provides triggerStallDetection() as the main entry point for the
 *     managing-poller to call during its stewardship-wake cycle.
 *   - Delegates per-state SLA detection to barrier.ts's detectStalledChildren().
 *
 * Design: design.md §5.5, §16.1.
 *
 * ACs:
 *   - A deliberately stalled leaf produces a stall event to its parent.
 *   - An at-capacity-but-healthy subtree does NOT trip stall escalation.
 *
 * Cross-ref AI-1339 (capacity-aware delivery recovery — the at-capacity classification this consumes).
 */

import { componentLogger, createLogger } from "./logger.js";
import {
  detectStalledChildren,
  surfaceStalledChildren,
  buildStallEvent,
  deferralAccountant,
  type StallEvent,
  type StalledChild,
  type DeferralAccountant,
} from "./barrier.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "engine-stall");

// Re-export canonical types from barrier.ts
export type { StallEvent, StalledChild, DeferralAccountant };
export { buildStallEvent, deferralAccountant, surfaceStalledChildren, detectStalledChildren };

// ── Public API: Trigger stall detection and emission ───────────────────────

export interface StallDetectionResult {
  /** Number of stall events emitted. */
  eventsEmitted: number;
  /** The stall events that were detected. */
  events: StallEvent[];
  /** Number of at-capacity children that were skipped. */
  atCapacitySkipped: number;
}

/**
 * Main entry point for engine stall detection and emission.
 *
 * Call this when the engine wants to check for stalled children of a parent
 * ticket in `managing` state. It:
 *   1. Detects children that have breached their per-state SLA.
 *   2. Filters out at-capacity/deferred children (known deferrals).
 *   3. Emits stall events via tripwire comments on the parent.
 *
 * The parent agent's managing-wake delivers the stall event data; the parent
 * decides the qualitative response (nudge, guidance, or escalation).
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @param operationalEventStore - Optional ops store for stall outcome events
 * @returns Stall detection result with events emitted and at-capacity skips
 */
export async function triggerStallDetection(
  parentIdentifier: string,
  authToken: string,
  operationalEventStore?: OperationalEventStore,
): Promise<StallDetectionResult> {
  log.info(`engine-stall: checking for stalled children on ${parentIdentifier}`);

  const { surfaced, events, atCapacitySkipped } = await surfaceStalledChildren(parentIdentifier, authToken);

  if (events.length > 0 && operationalEventStore) {
    for (const event of events) {
      operationalEventStore.append({
        outcome: "stall-detected",
        agent: event.parentIdentifier,
        key: event.childIdentifier,
        sessionKey: event.childIdentifier,
        deliveryMode: "engine-stall",
        detail: {
          childIdentifier: event.childIdentifier,
          parentIdentifier: event.parentIdentifier,
          currentState: event.currentState,
          timeInStateMs: event.timeInStateMs,
          slaMs: event.slaMs,
          breachMs: event.breachMs,
          knownDeferralMs: event.knownDeferralMs,
          isDeferredAtCapacity: event.isDeferredAtCapacity,
        },
      });
    }
  }

  return {
    eventsEmitted: surfaced,
    events,
    atCapacitySkipped,
  };
}

/**
 * Register a child as at-capacity (deferred) in the deferral accountant.
 *
 * Call this when the no-activity detector classifies a child as deferred-at-capacity.
 * The deferral time will be subtracted from the child's SLA clock, preventing
 * stall escalation for legitimately overloaded-but-healthy subtrees.
 */
export function registerDeferral(childIdentifier: string): void {
  deferralAccountant.startDeferral(childIdentifier);
  log.info(`engine-stall: registered deferral for ${childIdentifier}`);
}

/**
 * Unregister a child from the deferral accountant.
 *
 * Call this when a deferred child becomes active again (e.g., session-end
 * re-arm picks it up).
 */
export function unregisterDeferral(childIdentifier: string): void {
  const totalMs = deferralAccountant.stopDeferral(childIdentifier);
  if (totalMs > 0) {
    log.info(
      `engine-stall: unregistered deferral for ${childIdentifier} ` +
      `(${Math.round(totalMs / 60000)}m total deferral time)`,
    );
  }
}
