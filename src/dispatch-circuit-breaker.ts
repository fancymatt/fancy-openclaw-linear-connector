/**
 * AI-2178: Dispatch circuit breaker — stop re-waking a delegate on a ticket
 * whose workflow state hasn't moved after N wakes.
 *
 * Two features:
 *
 * Feature 1: Per-ticket dispatch circuit breaker
 *   After N (3) consecutive wakes where the ticket's workflow state hasn't
 *   changed, stop re-dispatching, emit one loud alert, and park dispatch until
 *   the state advances or a steward resets the breaker.
 *
 * Feature 2: Comment-fed re-wake suppression (pre-wake heuristic)
 *   Cheaper guard that runs BEFORE the circuit breaker counter increments.
 *   Suppress the wake when all of:
 *     (a) The triggering event is a comment
 *     (b) The comment author is the ticket's current delegate
 *     (c) The state:* workflow label is identical to what it was at the
 *         delegate's last dispatch
 *   If suppressed, don't increment the breaker counter.
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
// State types
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
// In-memory state store
// ---------------------------------------------------------------------------

const breakerState = new Map<string, TicketBreakerState>();

// ---------------------------------------------------------------------------
// Circuit breaker operations
// ---------------------------------------------------------------------------

/**
 * Record a dispatch attempt and update the circuit breaker state.
 *
 * Logic:
 *   - First dispatch for a ticket: seeds the state, counter=0.
 *   - State changed since last dispatch: the ticket advanced → reset counter
 *     to 0 and update the tracked state label.
 *   - State unchanged from last dispatch: this is a REPEAT (failed) wake on
 *     the same state — increment the counter. If counter >= maxWakes, trip.
 *
 * @returns The updated breaker state.
 */
export function recordDispatch(
  ticketId: string,
  stateLabel: string | null,
  maxWakes: number = DEFAULT_MAX_WAKES,
): TicketBreakerState {
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
  // If the state is the same (or null/missing), the breaker stays tripped.
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
 * The dispatch path workflow:
 *   1. recordDispatch() — sets the state snapshot for THIS dispatch, resets
 *      the counter if the state advanced.
 *   2. [dispatch proceeds through guards and delivery]
 *   3. recordWakeOutcome() — called AFTER the session returns, records
 *      whether the state advanced (→ reset) or not (→ increment).
 *
 * For the simpler pattern used in dispatchRoute, the flow is:
 *   - At webhook ingress: compare event stateLabel vs lastStateLabel.
 *     If same AND lastStateLabel existed → recordFailedWake (increment).
 *     If different → recordDispatch resets on next webhook.
 *
 * This function is the increment-and-trip path.
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

  const newCount = (existing.wakeCount ?? 0) + 1;
  const shouldTrip = newCount >= maxWakes;

  breakerState.set(ticketId, {
    lastStateLabel: stateLabel ?? existing.lastStateLabel,
    lastDispatchAt: new Date().toISOString(),
    wakeCount: newCount,
    tripped: shouldTrip,
    trippedAt: shouldTrip ? new Date().toISOString() : null,
  });

  if (shouldTrip) {
    log.warn(
      `Circuit breaker TRIPPED for ${ticketId}: ${newCount} consecutive wakes, state=${stateLabel ?? "unknown"}`,
    );
    notify({
      severity: "warning",
      source: "dispatch-circuit-breaker",
      title: `transition-stuck: ${ticketId} ${stateLabel ?? "unknown"} — ${newCount} wakes, no progress`,
      detail: {
        ticketId,
        stateLabel,
        wakeCount: newCount,
        trippedAt: breakerState.get(ticketId)!.trippedAt,
      },
      ticket: ticketId,
    });
  } else {
    log.info(
      `Circuit breaker: state unchanged for ${ticketId} (${newCount}/${maxWakes} wakes, state=${stateLabel ?? "unknown"})`,
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
