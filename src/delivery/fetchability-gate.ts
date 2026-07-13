/**
 * AI-2091 §2 (AI-2015 AC1/AC3, AI-2034) — delivery-time fetchability gate.
 *
 * A wake must never be dispatched for a ticket that cannot be fetched at
 * DELIVERY time. Two failure modes were folded into this umbrella:
 *
 *   - AI-2034: a wake referenced a dead identifier (AI-2030) that never existed.
 *   - AI-2015: an agent was woken on AI-2014, deleted and unfetchable at dispatch
 *     time, with no abort — the wake shipped "workflow context unavailable".
 *
 * The gate runs at delivery, not arm time, and distinguishes a TERMINAL
 * not-found (the ticket is genuinely gone → hard abort, surfaced as an ERROR so
 * it is not a warning buried inside the wake message, AC3) from a TRANSIENT
 * fetch error (5xx / timeout → fail-open, retry — a transient hiccup is not a
 * phantom ticket and must not be swallowed as one).
 */

export interface DispatchTargetFetchability {
  /** The ticket identifier the dispatch targets (e.g. "AI-2014"). */
  ticketId: string;
  /** Whether the ticket was successfully fetched at delivery time. */
  fetchable: boolean;
  /** True only for a TERMINAL not-found (issue does not exist / was deleted),
   *  not for a transient 5xx / timeout. Callers set this from the Linear read:
   *  a null `data.issue` with no transport error is terminal; a network/HTTP
   *  failure is not. */
  terminalNotFound: boolean;
}

export interface DispatchFetchabilityDecision {
  /** Whether the dispatch should proceed. */
  dispatch: boolean;
  /** "error" only for a confirmed phantom (terminal not-found). A transient
   *  failure is "warn" — fail-open, retry — never the AC3 hard error. */
  severity: "ok" | "warn" | "error";
  reason: string;
}

/**
 * Decide whether a dispatch may proceed against its target ticket, given the
 * result of a delivery-time fetch.
 *
 * - fetchable                → dispatch, ok.
 * - unfetchable + terminal   → ABORT, error (confirmed phantom; AC1/AC3).
 * - unfetchable + transient  → dispatch (fail-open), warn — retry, do not treat
 *   a transient error as a phantom.
 */
export function assertDispatchTargetFetchable(
  target: DispatchTargetFetchability,
): DispatchFetchabilityDecision {
  if (target.fetchable) {
    return { dispatch: true, severity: "ok", reason: `${target.ticketId} fetchable at delivery` };
  }
  if (target.terminalNotFound) {
    // Confirmed phantom: the ticket does not exist. Abort and surface loudly.
    return {
      dispatch: false,
      severity: "error",
      reason: `${target.ticketId} not found at delivery — aborting dispatch (phantom ticket)`,
    };
  }
  // Transient fetch failure: not a phantom. Fail open so a Linear hiccup does
  // not silently drop legitimate work; the caller retries.
  return {
    dispatch: true,
    severity: "warn",
    reason: `${target.ticketId} fetch failed transiently at delivery — dispatching fail-open (retry)`,
  };
}
