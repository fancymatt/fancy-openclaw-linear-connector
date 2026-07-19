/**
 * AI-2178 / INF-94: Dispatch circuit breaker.
 *
 * Feature 1: Per-ticket dispatch circuit breaker (AI-2178)
 *   After N (3) consecutive wakes where the ticket's workflow state hasn't
 *   changed, stop re-dispatching, emit one loud alert, and park dispatch until
 *   the state advances or a steward resets the breaker.
 *
 * Feature 2: Comment-fed re-wake suppression (pre-wake heuristic) (AI-2178)
 *   Cheaper guard that runs BEFORE the circuit breaker counter increments.
 *   Suppress the wake when all of:
 *     (a) The triggering event is a comment
 *     (b) The comment author is the ticket's current delegate
 *     (c) The state:* workflow label is identical to what it was at the
 *         delegate's last dispatch
 *   If suppressed, don't increment the breaker counter.
 *
 * INF-94 fix: Ad-hoc tickets (no wf:* label) never trip the transition-stuck
 *   alert — they have no workflow transitions to measure progress against.
 *   The DispatchCircuitBreaker class accepts raw label arrays and extracts the
 *   wf:* label internally, exempting label-less tickets. The legacy functional
 *   API (recordDispatch etc.) treats null stateLabel as ad-hoc and skips
 *   trip accounting.
 */

import { createLogger, componentLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(), "dispatch-circuit-breaker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max consecutive wakes before tripping the breaker. */
const DEFAULT_MAX_WAKES = 3;

// ---------------------------------------------------------------------------
// Legacy state types
// ---------------------------------------------------------------------------

export interface TicketBreakerState {
  /** The workflow state:* label observed at last dispatch. */
  lastStateLabel: string | null;
  /** ISO timestamp of the last dispatch. */
  lastDispatchAt: string | null;
  /** Consecutive wakes with no state change. */
  wakeCount: number;
  /** Whether the breaker is currently tripped (open). */
  tripped: boolean;
  /** ISO timestamp when the breaker tripped. */
  trippedAt: string | null;
}

/** Snapshot for /health exposure. */
export interface CircuitBreakerHealth {
  active: boolean;
  trackedTickets: number;
  trippedCount: number;
  config: {
    maxWakes: number;
  };
}

// ---------------------------------------------------------------------------
// Class-based API types (INF-94)
// ---------------------------------------------------------------------------

export interface DispatchCircuitBreakerConfig {
  /** Number of wakes without progress before alerting. Default: 3. */
  maxWakesBeforeAlert?: number;
}

export interface DispatchCircuitBreakerResult {
  /** Whether a transition-stuck alert should fire. */
  shouldAlert: boolean;
  /** Total recorded wakes for this ticket. */
  wakeCount: number;
  /** The wf:* label if the ticket has one, otherwise null. */
  stateLabel: string | null;
  /** Human-readable reason for the result. */
  reason: string | null;
}

interface TicketState {
  /** The wf:* label (null for ad-hoc tickets). */
  stateLabel: string | null;
  /** Accumulated wake count. */
  wakeCount: number;
  /** ISO timestamp of the last delegate activity, if any. */
  lastActivityAt: string | null;
  /** Whether the breaker is currently alerting. */
  shouldAlert: boolean;
}

// ---------------------------------------------------------------------------
// Legacy in-memory state store
// ---------------------------------------------------------------------------

const breakerState = new Map<string, TicketBreakerState>();

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Extract the wf:* label from a Linear labels array.
 * Returns null if no wf:* label is present (ad-hoc ticket).
 */
export function extractWorkflowLabel(labels: string[]): string | null {
  return labels.find((l) => /^wf:/i.test(l)) ?? null;
}

// ---------------------------------------------------------------------------
// Class-based API (INF-94)
// ---------------------------------------------------------------------------

/**
 * DispatchCircuitBreaker — transition-stuck detection with ad-hoc ticket exemption.
 *
 * Tracks wake dispatches per ticket and fires a `transition-stuck` signal when
 * a governed (wf:*) ticket receives multiple wakes without evidence of progress
 * (delegate activity or state transition). Ad-hoc tickets (no wf: label) are
 * exempt from transition-stuck firing because they have no workflow transitions
 * to measure progress against.
 */
export class DispatchCircuitBreaker {
  private readonly state = new Map<string, TicketState>();
  private readonly maxWakes: number;

  constructor(config?: DispatchCircuitBreakerConfig) {
    this.maxWakes = config?.maxWakesBeforeAlert ?? DEFAULT_MAX_WAKES;
  }

  /**
   * Record a successful wake dispatch to a ticket with its linear labels.
   * Labels are used to determine if the ticket is workflow-governed (wf:*).
   */
  recordWake(ticketId: string, labels: string[]): void {
    const wfLabel = extractWorkflowLabel(labels);
    const existing = this.state.get(ticketId);

    if (!existing) {
      // First wake for this ticket. Count starts at 1 (this IS a wake).
      const shouldAlert = wfLabel !== null
        ? 1 >= this.maxWakes
        : false;
      this.state.set(ticketId, {
        stateLabel: wfLabel,
        wakeCount: 1,
        lastActivityAt: null,
        shouldAlert,
      });
      return;
    }

    if (wfLabel === null) {
      // INF-94: Ad-hoc ticket (no wf:* label). Track the wake count for
      // observability but never alert. These tickets have no workflow
      // transitions to measure progress against.
      this.state.set(ticketId, {
        ...existing,
        stateLabel: null,
        wakeCount: existing.wakeCount + 1,
        shouldAlert: false,
      });
      return;
    }

    // If delegate already posted activity, reset the counter
    if (existing.lastActivityAt !== null) {
      this.state.set(ticketId, {
        ...existing,
        wakeCount: 1,
        shouldAlert: false,
      });
      return;
    }

    // wf:* ticket — accumulate wakes and alert if threshold exceeded without
    // any delegate activity.
    const newCount = existing.wakeCount + 1;
    const shouldAlert = newCount >= this.maxWakes && existing.lastActivityAt === null;

    this.state.set(ticketId, {
      stateLabel: wfLabel,
      wakeCount: newCount,
      lastActivityAt: existing.lastActivityAt,
      shouldAlert,
    });
  }

  /**
   * Record evidence of delegate activity (comment posted, state changed, ack
   * received). For ad-hoc tickets this is the only "progress" signal; for wf:*
   * tickets it clears the stuck timer.
   */
  recordDelegateActivity(ticketId: string): void {
    const existing = this.state.get(ticketId);
    if (!existing) return;

    this.state.set(ticketId, {
      ...existing,
      wakeCount: 0,
      lastActivityAt: new Date().toISOString(),
      shouldAlert: false,
    });
  }

  /**
   * Evaluate whether this ticket should fire a transition-stuck alert.
   */
  evaluate(ticketId: string): DispatchCircuitBreakerResult {
    const existing = this.state.get(ticketId);
    if (!existing) {
      return { shouldAlert: false, wakeCount: 0, stateLabel: null, reason: null };
    }

    const { stateLabel, wakeCount, shouldAlert, lastActivityAt } = existing;

    if (stateLabel === null) {
      // Ad-hoc ticket — never fire transition-stuck.
      return {
        shouldAlert: false,
        wakeCount,
        stateLabel: null,
        reason: `ad-hoc: no wf:* label — transition-stuck not applicable`,
      };
    }

    if (shouldAlert) {
      return {
        shouldAlert: true,
        wakeCount,
        stateLabel,
        reason: `transition-stuck: ${wakeCount} consecutive wakes on ${stateLabel}, no delegate activity`,
      };
    }

    if (lastActivityAt !== null) {
      return {
        shouldAlert: false,
        wakeCount,
        stateLabel,
        reason: `delegate activity at ${lastActivityAt}`,
      };
    }

    return {
      shouldAlert: false,
      wakeCount,
      stateLabel,
      reason: `${wakeCount}/${this.maxWakes} wakes before alert threshold`,
    };
  }

  /**
   * Reset tracking for a ticket (e.g., when the ticket transitions or is
   * completed).
   */
  reset(ticketId: string): void {
    this.state.delete(ticketId);
  }

  /** Access all tracked tickets (for diagnostics/testing). */
  allStates(): ReadonlyMap<string, TicketState> {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Legacy functional API (AI-2178 compatible)
// ---------------------------------------------------------------------------

/**
 * Record a dispatch attempt and update the circuit breaker state.
 *
 * INF-94: If stateLabel is null (ad-hoc ticket, no wf:* workflow label), the
 * ticket has no workflow transitions to stall — never trip the breaker.
 *
 * @returns The updated breaker state.
 */
export function recordDispatch(
  ticketId: string,
  stateLabel: string | null,
  maxWakes: number = DEFAULT_MAX_WAKES,
): TicketBreakerState {
  // INF-94: Null stateLabel means this ticket has no workflow state to measure
  // progress against. Ad-hoc tickets (no wf:* label) always have null stateLabel.
  // Record the dispatch but never trip — there are no transitions to stall on.
  if (stateLabel === null) {
    const fresh: TicketBreakerState = {
      lastStateLabel: null,
      lastDispatchAt: new Date().toISOString(),
      wakeCount: 0,
      tripped: false,
      trippedAt: null,
    };
    breakerState.set(ticketId, fresh);
    return fresh;
  }

  const existing = breakerState.get(ticketId);

  if (!existing) {
    // First dispatch for this ticket — seed the state.
    const fresh: TicketBreakerState = {
      lastStateLabel: stateLabel,
      lastDispatchAt: new Date().toISOString(),
      wakeCount: 0,
      tripped: false,
      trippedAt: null,
    };
    breakerState.set(ticketId, fresh);
    log.debug(`Circuit breaker: first dispatch for ${ticketId} → state=${stateLabel}`);
    return fresh;
  }

  // If the breaker is tripped, a state advance resets it.
  if (existing.tripped) {
    if (existing.lastStateLabel !== stateLabel && stateLabel !== null) {
      // State advance un-trips the breaker.
      const updated: TicketBreakerState = {
        lastStateLabel: stateLabel,
        lastDispatchAt: new Date().toISOString(),
        wakeCount: 0,
        tripped: false,
        trippedAt: null,
      };
      breakerState.set(ticketId, updated);
      log.info(
        `Circuit breaker: state advanced (un-trip) for ${ticketId}: ${existing.lastStateLabel ?? "none"} → ${stateLabel} — breaker reset`,
      );
      return updated;
    }
    // State unchanged while tripped — stay tripped.
    return existing;
  }

  // State changed since last dispatch → reset the counter (ticket progressed).
  if (existing.lastStateLabel !== stateLabel) {
    const updated: TicketBreakerState = {
      lastStateLabel: stateLabel,
      lastDispatchAt: new Date().toISOString(),
      wakeCount: 0,
      tripped: false,
      trippedAt: null,
    };
    breakerState.set(ticketId, updated);
    log.info(
      `Circuit breaker: state advanced for ${ticketId}: ${existing.lastStateLabel ?? "none"} → ${stateLabel ?? "none"} — counter reset`,
    );
    return updated;
  }

  // State is the same as last dispatch — this is a repeat wake on the same
  // state. Increment the counter and trip if threshold reached.
  const newCount = (existing.wakeCount ?? 0) + 1;
  const shouldTrip = newCount >= maxWakes;

  const updated: TicketBreakerState = {
    lastStateLabel: stateLabel,
    lastDispatchAt: new Date().toISOString(),
    wakeCount: newCount,
    tripped: shouldTrip,
    trippedAt: shouldTrip ? new Date().toISOString() : null,
  };
  breakerState.set(ticketId, updated);

  if (shouldTrip) {
    log.warn(
      `Circuit breaker TRIPPED for ${ticketId}: ${newCount} consecutive wakes, state=${stateLabel ?? "unknown"}`,
    );
    notify({
      severity: "warning",
      source: "dispatch-circuit-breaker",
      title: `transition-stuck: ${ticketId.replace(/^linear-/, "")} ${stateLabel ?? "unknown"} — ${newCount} wakes, no progress`,
      detail: {
        ticketId,
        stateLabel,
        wakeCount: newCount,
        trippedAt: updated.trippedAt,
      },
      ticket: ticketId,
    });
  } else if (newCount > 1) {
    log.info(
      `Circuit breaker: state unchanged for ${ticketId} (${newCount}/${maxWakes} wakes, state=${stateLabel ?? "unknown"})`,
    );
  }

  return updated;
}

/**
 * Called by the dispatch path AFTER a successful dispatch returns, when the
 * state was the same as before. This increments the consecutive-wake counter.
 *
 * INF-94: If the ticket has no state label (ad-hoc, no wf:*), don't trip.
 */
export function recordFailedWake(
  ticketId: string,
  stateLabel: string | null,
  maxWakes: number = DEFAULT_MAX_WAKES,
): { tripped: boolean; wakeCount: number } {
  const existing = breakerState.get(ticketId);
  if (!existing || existing.tripped) {
    // If already tripped, don't mutate further — only a state advance or
    // explicit reset can un-trip.
    return { tripped: existing?.tripped ?? false, wakeCount: existing?.wakeCount ?? 0 };
  }

  // INF-94: If the ticket has no state label (ad-hoc, no wf:*), don't trip —
  // there are no transitions to stall on.
  const effectiveLabel = stateLabel ?? existing.lastStateLabel;
  if (effectiveLabel === null) {
    return { tripped: false, wakeCount: 0 };
  }

  const newCount = (existing.wakeCount ?? 0) + 1;
  const shouldTrip = newCount >= maxWakes;

  breakerState.set(ticketId, {
    lastStateLabel: effectiveLabel,
    lastDispatchAt: new Date().toISOString(),
    wakeCount: newCount,
    tripped: shouldTrip,
    trippedAt: shouldTrip ? new Date().toISOString() : null,
  });

  if (shouldTrip) {
    log.warn(
      `Circuit breaker TRIPPED for ${ticketId}: ${newCount} consecutive wakes, state=${effectiveLabel}`,
    );
    notify({
      severity: "warning",
      source: "dispatch-circuit-breaker",
      title: `transition-stuck: ${ticketId} ${effectiveLabel} — ${newCount} wakes, no progress`,
      detail: {
        ticketId,
        stateLabel: effectiveLabel,
        wakeCount: newCount,
        trippedAt: breakerState.get(ticketId)!.trippedAt,
      },
      ticket: ticketId,
    });
  } else {
    log.info(
      `Circuit breaker: state unchanged for ${ticketId} (${newCount}/${maxWakes} wakes, state=${effectiveLabel})`,
    );
  }

  return { tripped: shouldTrip, wakeCount: newCount };
}

/**
 * Check if the breaker is tripped for a ticket.
 * Returns `{ blocked: true, state }` if the breaker is open and dispatch should
 * be suppressed. Returns `{ blocked: false }` otherwise.
 */
export function checkBreaker(
  ticketId: string,
): { blocked: boolean; state?: TicketBreakerState } {
  const existing = breakerState.get(ticketId);
  if (existing?.tripped) {
    log.info(
      `Circuit breaker: blocking dispatch for ${ticketId} — tripped at ${existing.trippedAt} after ${existing.wakeCount} wakes (state=${existing.lastStateLabel ?? "unknown"})`,
    );
    return { blocked: true, state: existing };
  }
  return { blocked: false };
}

/**
 * Reset the breaker for a ticket (steward override or state advance from
 * an incoming webhook). Returns true if there was state to clear.
 */
export function resetBreaker(ticketId: string): boolean {
  const hadState = breakerState.has(ticketId);
  breakerState.delete(ticketId);
  if (hadState) {
    log.info(`Circuit breaker: reset for ${ticketId}`);
  }
  return hadState;
}

// ---------------------------------------------------------------------------
// Comment-fed re-wake suppression (Feature 2)
// ---------------------------------------------------------------------------

/**
 * Comment-fed suppression check that takes the ticket ID explicitly.
 *
 * @param ticketId - Normalized ticket session key (e.g. "linear-AI-2178").
 * @param event - The normalized Linear event (any subtype, actor access via duck-typing).
 * @param currentStateLabel - The state:* label from the current event data.
 * @param delegateAgentName - The agent name targeted for dispatch.
 * @returns suppression result.
 */
export function checkCommentFedSuppressionForTicket(
  ticketId: string,
  event: { type: string; actor?: { id?: string; name?: string } | null },
  currentStateLabel: string | null,
  delegateAgentName: string,
): { suppressed: boolean; reason?: string } {
  // (a) Must be a comment event
  if (event.type !== "Comment") {
    return { suppressed: false };
  }

  // (b) Author must be the current delegate
  const authorName = event.actor?.name ?? null;
  if (!authorName) {
    return { suppressed: false };
  }

  // The delegate agent name is the routed target. The author matches if the
  // clean agent name (openclaw agent name) matches the comment author's name.
  // In Linear, the author is the OAuth app user name (e.g. "Astrid (CPO)").
  // We compare case-insensitively against the delegate agent name.
  const authorLower = authorName.toLowerCase();
  const delegateLower = delegateAgentName.toLowerCase();
  const isAuthorTheDelegate =
    authorLower === delegateLower ||
    authorLower.startsWith(delegateLower) ||
    delegateLower.startsWith(authorLower);

  if (!isAuthorTheDelegate) {
    return { suppressed: false };
  }

  // (c) state label unchanged since last dispatch
  const existing = breakerState.get(ticketId);
  if (!existing) {
    // No prior dispatch tracked — nothing to compare against.
    // This is the first dispatch, so no suppression.
    return { suppressed: false };
  }

  const lastLabel = existing.lastStateLabel;
  if (lastLabel === currentStateLabel) {
    log.info(
      `Comment-fed suppression: ${delegateAgentName} commented on ${ticketId} but state unchanged (${lastLabel}) — suppressing wake`,
    );
    return { suppressed: true, reason: `state unchanged (${lastLabel}) since delegate's last dispatch` };
  }

  return { suppressed: false };
}

// ---------------------------------------------------------------------------
// Health / observability
// ---------------------------------------------------------------------------

/**
 * Get a snapshot of the circuit breaker state for /health.
 */
export function getCircuitBreakerHealth(): CircuitBreakerHealth {
  let trippedCount = 0;
  for (const state of breakerState.values()) {
    if (state.tripped) trippedCount++;
  }

  return {
    active: true,
    trackedTickets: breakerState.size,
    trippedCount,
    config: {
      maxWakes: DEFAULT_MAX_WAKES,
    },
  };
}

/**
 * Get a deep-clone of all breaker states (for admin endpoints or diagnostics).
 */
export function getAllBreakerStates(): Record<string, TicketBreakerState> {
  const out: Record<string, TicketBreakerState> = {};
  for (const [key, val] of breakerState) {
    out[key] = { ...val };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Reset all breaker state (for testing). */
export function resetCircuitBreakerForTest(): void {
  breakerState.clear();
}
