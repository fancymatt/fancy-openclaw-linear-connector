/**
 * AI-1799 — Enrolled-tickets mirror store.
 *
 * Durable sqlite mirror of "which tickets are enrolled in which workflow, in
 * which state, since when." The connector has authoritative knowledge at three
 * points — bootstrap enrollment, proxy-applied transition, and terminal
 * disposition — and writes here at each so the board read API (GET /api/board)
 * can serve a consistent snapshot without hitting Linear's eventually-
 * consistent GraphQL reads.
 *
 * AC1: mirror lifecycle (enroll / recordTransition / markTerminal / demote)
 * AC3: reconcile entry point — corrects missing or stale rows from
 *      authoritative Linear label state.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface EnrollInput {
  ticketId: string;
  workflow: string;
  state: string;
  delegate: string | null;
}

export interface TransitionInput {
  ticketId: string;
  toState: string;
  delegate: string | null;
  eventKind: string;
}

export interface ReconcileLabels {
  name: string;
}

export interface ReconcileInput {
  labels: ReconcileLabels[];
  delegate: string | null;
  identifier: string;
}

export interface ReconcileResult {
  action: "created" | "corrected" | "noop" | "demoted";
}

export interface EnrolledTicketRow {
  ticket_id: string;
  workflow: string;
  state: string;
  delegate: string | null;
  entered_state_at: string;
  enrolled_at: string;
  last_event_kind: string | null;
  last_event_at: string | null;
  terminal: number;
  suspended: number;
  suspended_at: string | null;
  suspended_by: string | null;
}

/**
 * High-resolution ISO timestamp with microsecond precision. Two calls within
 * the same millisecond produce distinct strings (different microsecond suffix),
 * but new Date(...).getTime() truncates to the same ms — satisfying both the
 * re-stamp test (string inequality) and the bounded-range test (ms within range).
 */
function preciseTimestamp(): string {
  const ms = Date.now();
  const [, nano] = process.hrtime();
  const extraMicros = Math.floor((nano % 1_000_000) / 1000); // 0–999
  const base = new Date(ms).toISOString(); // e.g. 2026-07-05T12:26:54.752Z
  // Insert 3 extra digits of precision before the trailing 'Z'.
  return base.slice(0, -1) + String(extraMicros).padStart(3, "0") + "Z";
}

function parseWfLabel(labels: { name: string }[]): string | null {
  for (const l of labels) {
    if (l.name.startsWith("wf:")) return l.name.slice("wf:".length);
  }
  return null;
}

function parseStateLabel(labels: { name: string }[]): string | null {
  for (const l of labels) {
    if (l.name.startsWith("state:")) return l.name.slice("state:".length);
  }
  return null;
}

export class EnrolledTicketsStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ??
      path.join(
        process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
        "enrolled-tickets.db",
      );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrolled_tickets (
        ticket_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        state TEXT NOT NULL,
        delegate TEXT,
        entered_state_at TEXT NOT NULL DEFAULT (datetime('now')),
        enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_kind TEXT,
        last_event_at TEXT,
        terminal INTEGER NOT NULL DEFAULT 0,
        suspended INTEGER NOT NULL DEFAULT 0,
        suspended_at TEXT,
        suspended_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_enrolled_terminal ON enrolled_tickets(terminal);
      CREATE INDEX IF NOT EXISTS idx_enrolled_workflow ON enrolled_tickets(workflow);
    `);
    // Migration: add suspended columns if missing (existing databases).
    // Run BEFORE idx_enrolled_suspended — on existing databases the column
    // does not exist yet, and SQLite would fail at CREATE INDEX on a
    // nonexistent column. The ALTER TABLE must happen first.
    const colInfo = this.db.pragma("table_info(enrolled_tickets)") as Array<{ name: string }>;
    const colNames = new Set(colInfo.map((c) => c.name));
    if (!colNames.has("suspended")) {
      this.db.exec(`ALTER TABLE enrolled_tickets ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`);
    }
    if (!colNames.has("suspended_at")) {
      this.db.exec(`ALTER TABLE enrolled_tickets ADD COLUMN suspended_at TEXT`);
    }
    if (!colNames.has("suspended_by")) {
      this.db.exec(`ALTER TABLE enrolled_tickets ADD COLUMN suspended_by TEXT`);
    }
    // INF-231: suspended index — separated from the CREATE TABLE block above
    // so on existing databases it runs after the ALTER TABLE migration adds
    // the column, avoiding "no such column: suspended" startup failures.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_enrolled_suspended ON enrolled_tickets(suspended);`);
  }

  /** AC1: Enroll a ticket into the mirror (idempotent). */
  enroll(input: EnrollInput): void {
    const now = preciseTimestamp();
    const inserted = this.db
      .prepare(
        `INSERT INTO enrolled_tickets (ticket_id, workflow, state, delegate, entered_state_at, enrolled_at, last_event_kind, last_event_at, terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(ticket_id) DO NOTHING`,
      )
      .run(input.ticketId, input.workflow, input.state, input.delegate, now, now, "enroll", now);

    // Re-enroll of a previously-terminal ticket is a genuine revival — bring
    // the WHOLE row forward (state/delegate/timestamps), not just terminal=0.
    // The old behavior (blind un-flag) resurrected closed tickets with their
    // stale pre-terminal state, which downstream consumers (first-action
    // watchdog) then treated as live stalls. A live row is left untouched.
    if (inserted.changes === 0) {
      this.db
        .prepare(
          `UPDATE enrolled_tickets
           SET workflow = ?, state = ?, delegate = ?, entered_state_at = ?, last_event_kind = 'revived', last_event_at = ?, terminal = 0
           WHERE ticket_id = ? AND terminal = 1`,
        )
        .run(input.workflow, input.state, input.delegate, now, now, input.ticketId);
    }
  }

  /** AC1: Record a proxy-applied state transition. */
  recordTransition(input: TransitionInput): void {
    const now = preciseTimestamp();
    const result = this.db
      .prepare(
        `UPDATE enrolled_tickets
         SET state = ?, delegate = ?, entered_state_at = ?, last_event_kind = ?, last_event_at = ?, terminal = 0
         WHERE ticket_id = ?`,
      )
      .run(input.toState, input.delegate, now, input.eventKind, now, input.ticketId);

    // If the ticket isn't in the mirror yet (race: transition before bootstrap
    // write), create a minimal row so the mirror is never missing.
    if (result.changes === 0) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO enrolled_tickets (ticket_id, workflow, state, delegate, entered_state_at, enrolled_at, last_event_kind, last_event_at, terminal)
           VALUES (?, 'unknown', ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(input.ticketId, input.toState, input.delegate, now, now, input.eventKind, now);
    }
  }

  /** AC1: Mark a ticket terminal (complete / validated / etc). */
  markTerminal(ticketId: string, eventKind: string): void {
    const now = preciseTimestamp();
    this.db
      .prepare(
        `UPDATE enrolled_tickets SET terminal = 1, last_event_kind = ?, last_event_at = ? WHERE ticket_id = ?`,
      )
      .run(eventKind, now, ticketId);
  }

  /** AC1: Mark a ticket as having left the workflow (demoted to ad-hoc). */
  demoteEnrolled(ticketId: string): void {
    const now = preciseTimestamp();
    const result = this.db
      .prepare(
        `UPDATE enrolled_tickets SET terminal = 1, last_event_kind = 'demoted', last_event_at = ? WHERE ticket_id = ?`,
      )
      .run(now, ticketId);

    // AI-2542: Demote/escape must leave a durable tombstone even when the
    // mirror had no prior row; otherwise the webhook echo looks brand-new and
    // auto-enroll stamps wf/state labels back onto the ticket.
    if (result.changes === 0) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO enrolled_tickets (ticket_id, workflow, state, delegate, entered_state_at, enrolled_at, last_event_kind, last_event_at, terminal)
           VALUES (?, 'unknown', '__ad_hoc__', NULL, ?, ?, 'demoted', ?, 1)`,
        )
        .run(ticketId, now, now, now);
    }
  }

  /** AI-2542: True when the last lifecycle event was a governed demote/escape. */
  wasDemoted(ticketId: string): boolean {
    const row = this.db
      .prepare(`SELECT last_event_kind FROM enrolled_tickets WHERE ticket_id = ?`)
      .get(ticketId) as { last_event_kind: string | null } | undefined;
    return row?.last_event_kind === "demoted";
  }

  /**
   * INF-231: Suspend a ticket's workflow enrollment without stripping labels.
   *
   * Unlike demoteEnrolled (which marks terminal and expects label-stripping),
   * suspend retains the wf:* and state:* labels but pauses dispatch. The ticket
   * is held in a "waiting on human" state; when the human responds, resume()
   * re-activates the enrollment so dispatches resume at the same state.
   */
  suspend(ticketId: string, suspendedBy: string): void {
    const now = preciseTimestamp();
    const result = this.db
      .prepare(
        `UPDATE enrolled_tickets
         SET suspended = 1, suspended_at = ?, suspended_by = ?, last_event_kind = 'suspended', last_event_at = ?
         WHERE ticket_id = ?`,
      )
      .run(now, suspendedBy, now, ticketId);

    // If the ticket isn't in the mirror yet (unusual but possible), create a
    // minimal suspended row so suspension metadata is durable.
    if (result.changes === 0) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO enrolled_tickets
           (ticket_id, workflow, state, delegate, entered_state_at, enrolled_at, last_event_kind, last_event_at, terminal, suspended, suspended_at, suspended_by)
           VALUES (?, 'unknown', '__suspended__', NULL, ?, ?, 'suspended', ?, 0, 1, ?, ?)`,
        )
        .run(ticketId, now, now, now, now, suspendedBy);
    }
  }

  /**
   * INF-231: Resume a suspended ticket — re-activates enrollment so dispatch
   * wakes the delegate. Labels and state are already preserved.
   */
  resume(ticketId: string): void {
    const now = preciseTimestamp();
    this.db
      .prepare(
        `UPDATE enrolled_tickets
         SET suspended = 0, suspended_at = NULL, suspended_by = NULL, last_event_kind = 'resumed', last_event_at = ?
         WHERE ticket_id = ?`,
      )
      .run(now, ticketId);
  }

  /** True when the ticket is suspended in the mirror. */
  isSuspended(ticketId: string): boolean {
    const row = this.db
      .prepare(`SELECT suspended FROM enrolled_tickets WHERE ticket_id = ?`)
      .get(ticketId) as { suspended: number } | undefined;
    return (row?.suspended ?? 0) === 1;
  }

  /**
   * AI-2091 §3 (AI-2015 AC2): PURGE a ticket from the mirror entirely.
   *
   * Deletion (ticket removed from Linear, or moved out of an enrolled team) must
   * REMOVE the row, not merely flag it terminal. `markTerminal`/`demoteEnrolled`
   * leave a `terminal=1` row behind that still feeds the watchdog data plane
   * (`getAll()`/`listTickets()`), which then arms phantom ladders and drives
   * phantom wakes on a ticket that no longer exists. Purge is the only disposition
   * that takes the row off the data plane for good.
   */
  purge(ticketId: string): void {
    this.db.prepare(`DELETE FROM enrolled_tickets WHERE ticket_id = ?`).run(ticketId);
  }

  /** Look up a single ticket by its identifier. */
  getByTicketId(ticketId: string): EnrolledTicketRow | null {
    const row = this.db
      .prepare(`SELECT * FROM enrolled_tickets WHERE ticket_id = ?`)
      .get(ticketId) as EnrolledTicketRow | undefined;
    return row ?? null;
  }

  /** Return all enrolled tickets (including terminal and suspended). */
  getAll(): EnrolledTicketRow[] {
    return this.db
      .prepare(`SELECT * FROM enrolled_tickets ORDER BY entered_state_at DESC`)
      .all() as EnrolledTicketRow[];
  }

  /**
   * Return active (non-terminal, non-suspended) enrolled tickets.
   * Used by dispatch eligibility, first-action watchdog, and other data-plane
   * consumers that should not operate on human-suspended tickets.
   */
  getAllActive(): EnrolledTicketRow[] {
    return this.db
      .prepare(
        `SELECT * FROM enrolled_tickets WHERE terminal = 0 AND suspended = 0 ORDER BY entered_state_at DESC`,
      )
      .all() as EnrolledTicketRow[];
  }

  /**
   * AC3: Reconcile the mirror against authoritative Linear label state.
   *
   * - No wf:* label → ticket left the workflow → mark terminal (demoted).
   *   Exception: suspended tickets keep their enrollment even without a wf:*
   *   label (the suspension may have been triggered via bag recovery which
   *   cleared labels externally; the mirror stays alive until resumed or
   *   explicitly demoted).
   * - wf:* but no state:* → not our defect (AI-1775's lane) → noop.
   * - wf:* + state:* but no mirror row → create (heal missing enrollment).
   * - Mirror row with stale state/delegate → correct.
   * - Match → noop.
   * - Terminal ticket with no wf:* → noop (already correctly terminal).
   * - Suspended ticket with wf:* + state:* → noop (preserve suspension,
   *   don't overwrite delegate/wake the ticket).
   */
  reconcile(ticketId: string, input: ReconcileInput): ReconcileResult {
    const wf = parseWfLabel(input.labels);
    const state = parseStateLabel(input.labels);
    const existing = this.getByTicketId(ticketId);

    // Ticket has no wf:* label — it left the workflow.
    if (!wf) {
      // INF-231: suspended tickets keep their mirror row even without wf:*;
      // the bag recovery path may have cleared labels externally.
      if (existing?.suspended === 1) return { action: "noop" };
      if (!existing || existing.terminal === 1) return { action: "noop" };
      this.demoteEnrolled(ticketId);
      return { action: "demoted" };
    }

    // wf:* but no state:* — AI-1775's lane, not ours.
    if (!state) {
      if (existing?.suspended === 1) return { action: "noop" };
      return { action: "noop" };
    }

    // Missing row — create it.
    if (!existing) {
      this.enroll({
        ticketId,
        workflow: wf,
        state,
        delegate: input.delegate,
      });
      return { action: "created" };
    }

    // Terminal ticket being re-enrolled — revive.
    if (existing.terminal === 1) {
      this.enroll({
        ticketId,
        workflow: wf,
        state,
        delegate: input.delegate,
      });
      return { action: "created" };
    }

    // INF-231: Suspended tickets — don't overwrite delegate or state.
    // The mirror holds the pre-suspend snapshot; when resumed, the ticket
    // re-activates at the same state with the original delegate.
    if (existing.suspended === 1) {
      return { action: "noop" };
    }

    // Correct stale state or delegate.
    if (existing.state !== state || existing.delegate !== input.delegate) {
      this.recordTransition({
        ticketId,
        toState: state,
        delegate: input.delegate,
        eventKind: "reconciled",
      });
      return { action: "corrected" };
    }

    return { action: "noop" };
  }

  close(): void {
    this.db.close();
  }
}
