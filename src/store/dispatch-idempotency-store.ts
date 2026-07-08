/**
 * AI-1918 — Persistent dispatch idempotency store.
 *
 * Deduplicates dispatches keyed on (ticket, workflowState, agent) so that:
 *   1. A single webhook event replayed (different delivery IDs) produces at most
 *      one wake per target agent (AC1: dispatch dedup).
 *   2. An older snapshot that arrives after a newer one is dropped (AC2: stale-
 *      dispatch guard) — the updatedAt from the ticket payload is compared against
 *      the latest seen timestamp for that (ticket, agent) tuple.
 *   3. The store is durable (SQLite/WAL) so it survives connector restarts,
 *      preventing restart-echo fan-out (AC4: root-cause regression).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface IdempotencyRecord {
  /** Normalized ticket key, e.g. "linear-AI-1918". */
  ticketKey: string;
  /** Workflow state name or event id at dispatch time. */
  workflowState: string;
  /** Target agent name. */
  agent: string;
  /** ISO-8601 updatedAt from the webhook payload at dispatch time. */
  updatedAt: string;
  /** ISO-8601 timestamp of when the record was created. */
  createdAt: string;
}

export interface IdempotencyCheckResult {
  /** True if this dispatch should be suppressed as a duplicate. */
  suppressed: boolean;
  /** True if this dispatch should be dropped as stale (older snapshot). */
  stale: boolean;
}

export interface IdempotencyCounters {
  suppressedDuplicates: number;
  droppedStale: number;
}

export class DispatchIdempotencyStore {
  private db: Database.Database;
  private _suppressedDuplicates = 0;
  private _droppedStale = 0;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "dispatch-idempotency.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_idempotency (
        ticket_key TEXT NOT NULL,
        workflow_state TEXT NOT NULL,
        agent TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (ticket_key, workflow_state, agent)
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_ticket_agent
        ON dispatch_idempotency (ticket_key, agent);
    `);
  }

  /**
   * Check whether a dispatch should be admitted, suppressed (duplicate), or
   * dropped (stale). If admitted, the record is persisted. If suppressed or
   * dropped, the relevant in-memory counter is incremented.
   */
  checkAndRecord(
    ticketKey: string,
    workflowState: string,
    agent: string,
    updatedAt: string,
  ): IdempotencyCheckResult {
    // ── Duplicate check: exact (ticket, state, agent) key. ──
    const row = this.db
      .prepare(
        `SELECT updated_at, created_at FROM dispatch_idempotency
         WHERE ticket_key = ? AND workflow_state = ? AND agent = ?`,
      )
      .get(ticketKey, workflowState, agent) as
      | { updated_at: string; created_at: string }
      | undefined;

    if (row) {
      const existingUpdatedAt = new Date(row.updated_at).getTime();
      const incomingUpdatedAt = new Date(updatedAt).getTime();

      if (incomingUpdatedAt < existingUpdatedAt) {
        this._droppedStale++;
        return { suppressed: false, stale: true };
      }
      // Duplicate: identical snapshot (webhook replay / restart echo) — don't
      // re-dispatch. A strictly NEWER updatedAt is a genuinely new event
      // (AI-1969: workflow re-entry — e.g. a second handoff to the same agent
      // in the same state after a bounce cycle) and must be admitted; before
      // this distinction, re-entry handoffs were suppressed forever and the
      // target agent could never be woken again on that (ticket, state) key.
      if (incomingUpdatedAt === existingUpdatedAt) {
        this._suppressedDuplicates++;
        return { suppressed: true, stale: false };
      }
      // Fall through to admit: the INSERT OR REPLACE below refreshes the
      // stored updatedAt so the replay guard tracks the newest snapshot.
    }

    // ── Stale check: ticket-level across all agents/states. ──
    // If ANY agent has already seen a newer snapshot of this ticket, the
    // incoming (older) dispatch is stale and must be dropped. This catches the
    // AI-1857 session-B scenario: ticket advances via a newer update, then a
    // delayed older snapshot arrives for a different agent.
    const latestRow = this.db
      .prepare(
        `SELECT MAX(updated_at) as max_updated_at FROM dispatch_idempotency
         WHERE ticket_key = ?`,
      )
      .get(ticketKey) as { max_updated_at: string } | undefined;

    if (latestRow && latestRow.max_updated_at) {
      const latestUpdatedAt = new Date(latestRow.max_updated_at).getTime();
      const incomingUpdatedAt = new Date(updatedAt).getTime();

      if (incomingUpdatedAt < latestUpdatedAt) {
        this._droppedStale++;
        return { suppressed: false, stale: true };
      }
    }

    // ── Admit: fresh dispatch. Persist the record. ──
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dispatch_idempotency
         (ticket_key, workflow_state, agent, updated_at, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(ticketKey, workflowState, agent, updatedAt);

    return { suppressed: false, stale: false };
  }

  /** In-memory counters for observability (reset on restart, persisted counts
   *  come from operational events). */
  get counters(): IdempotencyCounters {
    return {
      suppressedDuplicates: this._suppressedDuplicates,
      droppedStale: this._droppedStale,
    };
  }

  close(): void {
    this.db.close();
  }
}
