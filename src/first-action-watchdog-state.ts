/**
 * AI-2009 — In-process state for the first-action watchdog.
 *
 * Mirrors the rescue-sweep-state.ts singleton idiom (module-level mutable state,
 * whole-object record / cloned getter / reset-for-test) but holds a per-ticket
 * ladder array plus a scheduled flag so both /admin (per-ticket ladder) and
 * /health (liveness: scheduled + armedCount) can read it without waiting for a
 * deadline breach.
 */

/** One rung fired against a ticket, logged for the ops alert + /admin history. */
export interface LadderHistoryEntry {
  /** "redispatch" | "unreachable" | "reroute" */
  rung: string;
  /** ISO timestamp the rung fired. */
  at: string;
  /** Optional human-readable detail (e.g. reroute target). */
  detail?: string;
}

/** Per-ticket ladder state — armed deadline plus escalation progress. */
export interface FirstActionLadder {
  ticket: string;
  state: string;
  delegate: string;
  /** ISO — the (possibly restart-clamped) time the deadline is armed from. */
  armedAt: string;
  /**
   * AI-2091 §4 — the RAW dispatch delivered-at (epoch ms) this ladder was armed
   * for. `armedAt` may be clamped forward to sweep time on a cold/first arm over a
   * stale (pre-restart) backlog, so dispatch identity ("is this the same
   * dispatch?") is compared on this raw value, not on the clamped armedAt.
   */
  deliveredAtMs?: number;
  /** ISO — armedAt + the per-state (or default) first-action deadline. */
  deadlineAt: string;
  /** How many escalation rungs have fired for this ticket. */
  rungsFired: number;
  /** Set once the ladder is exhausted and the delegate is marked unreachable. */
  unreachable: boolean;
  history: LadderHistoryEntry[];
}

/** Liveness + ladder view surfaced at /health and /admin. */
export interface FirstActionWatchdogState {
  /** True once the watchdog cron is registered (armed and scheduled). */
  scheduled: boolean;
  /** Count of currently-armed ladders (not yet marked unreachable). */
  armedCount: number;
  ladders: FirstActionLadder[];
}

let scheduled = false;
const ladders = new Map<string, FirstActionLadder>();

/** Called by the cron registrar so /health can report the watchdog is armed. */
export function markFirstActionWatchdogScheduled(): void {
  scheduled = true;
}

/** Arm or update the ladder for a ticket (whole-object upsert, cloned history). */
export function upsertFirstActionLadder(ladder: FirstActionLadder): void {
  ladders.set(ladder.ticket, {
    ...ladder,
    history: ladder.history.map((h) => ({ ...h })),
  });
}

/** Read the current ladder for a ticket (clone), or null if not armed. */
export function getFirstActionLadder(ticket: string): FirstActionLadder | null {
  const l = ladders.get(ticket);
  if (!l) return null;
  return { ...l, history: l.history.map((h) => ({ ...h })) };
}

/** Drop a ladder entirely — used when the on-breach cross-check finds the
 *  mirror row was stale (ticket done/deleted/demoted in Linear). */
export function deleteFirstActionLadder(ticket: string): void {
  ladders.delete(ticket);
}

export function getFirstActionWatchdogState(): FirstActionWatchdogState {
  const all = [...ladders.values()].map((l) => ({
    ...l,
    history: l.history.map((h) => ({ ...h })),
  }));
  return {
    scheduled,
    armedCount: all.filter((l) => !l.unreachable).length,
    ladders: all,
  };
}

export function resetFirstActionWatchdogStateForTest(): void {
  scheduled = false;
  ladders.clear();
}
