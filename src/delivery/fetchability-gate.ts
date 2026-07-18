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
 *
 * AI-2389 — fetchable ≠ dispatchable. A ticket that is Done/Canceled reads back
 * non-null at delivery (`fetchable: true`), so existence-only gating let a
 * terminally-closed ticket be (re-)dispatched. This was the live specimen behind
 * the AI-2313 hourly replay: the stale C4 re-poke path (`src/index.ts`) called
 * this gate with `fetchable: linearState != null` and no state check, and re-poked
 * a Done ticket every cycle. When the caller supplies the ticket's live state, a
 * terminal state now drops the dispatch (severity "warn" — a legitimate drop, not
 * the AC3 phantom error). Callers that cannot cheaply read state omit `liveState`
 * and keep the prior existence-only behavior (fail-open).
 */

import { isTerminalIssueState } from "../linear-actionable.js";

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
  /** AI-2389 — the ticket's live state ({name, type}) at delivery time. When the
   *  ticket is fetchable but its state is terminal (Done/Canceled), the dispatch
   *  is dropped: a completed ticket must never be (re-)dispatched even though it
   *  reads back non-null. Optional — callers that cannot cheaply read the live
   *  state omit it and retain existence-only behavior. */
  liveState?: { name?: string | null; type?: string | null } | null;
  /** INF-83 — whether the ticket is trashed (soft-deleted) at delivery time.
   *  Archived/trashed tickets are still fetchable via the Linear API but cannot
   *  have comments posted to them (commentCreate fails with Entity not found),
   *  so agents woken on them will bounce commentless. Optional — when unset the
   *  gate falls through to the existing fetchable/terminal check. */
  trashed?: boolean | null;
  /** INF-83 — the ticket's archivedAt timestamp. A non-null value means the
   *  ticket is archived and not dispatchable (same constraint as trashed). */
  archivedAt?: string | null;
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
    // AI-2389: fetchable ≠ dispatchable. A terminally-closed ticket (Done/
    // Canceled) reads back non-null, but re-dispatching one is exactly the
    // AI-2313 replay bug. When the caller threads the live state, drop it here.
    // severity "warn": a legitimate drop of a closed ticket, not the AC3 phantom
    // error. `liveState` omitted ⇒ unknown ⇒ fail-open (existence-only behavior).
    if (target.liveState && isTerminalIssueState(target.liveState)) {
      const label = target.liveState.name ?? target.liveState.type ?? "done/canceled";
      return {
        dispatch: false,
        severity: "warn",
        reason: `${target.ticketId} is terminally closed (${label}) at delivery — dropping dispatch (no re-poke for a completed ticket)`,
      };
    }
    // INF-83: archive/trash check. An archived/trashed ticket is fetchable but
    // not dispatchable — commentCreate fails with Entity not found. When the
    // caller threads trashed/archivedAt, drop it here. Unset ⇒ unknown ⇒
    // fail-open (caller didn't read the field, typically a C4 re-poke on an
    // older linearState shape).
    if (target.trashed || target.archivedAt) {
      const label = target.trashed ? "trashed" : "archived";
      return {
        dispatch: false,
        severity: "warn",
        reason: `${target.ticketId} is ${label} at delivery — dropping dispatch (archived/trashed tickets reject comments)`,
      };
    }
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
