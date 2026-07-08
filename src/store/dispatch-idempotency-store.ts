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
 *
 * AI-1973 extensions:
 *   - Delegate-change invalidation: when a dispatch carries delegateChanged:true,
 *     all prior rows for (ticket, agent) are cleared before admitting the new
 *     dispatch. This fixes the permanent re-wake suppression behind the AI-1965
 *     merge-gate stall (AI-1855 19h, AI-1926 19.6h).
 *   - Dedup TTL: rows older than the TTL stop suppressing. Prevents long-lived
 *     stale rows from locking out re-dispatches.
 *   - clearAgentRows() escape hatch for manual recovery.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Default TTL: 6 hours. Replay storms happen in seconds-to-minutes, not days.
 *  The AI-1855 stall was ~19 hours — beyond this window. */
export const DEFAULT_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

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
  /** True if the existing row existed but was past its TTL, allowing admit. */
  ttlExpired?: boolean;
  /** Number of prior rows cleared for (ticket, agent) due to delegate change. */
  clearedRows?: number;
}

export interface IdempotencyCounters {
  suppressedDuplicates: number;
  droppedStale: number;
  /** Rows cleared by delegate-change invalidation. */
  delegateChangeCleared: number;
  /** Admits granted because the existing row exceeded the TTL. */
  ttlExpiredAdmits: number;
}

export interface IdempotencyOptions {
  /** Override "now" timestamp (ms since epoch) for deterministic testing. */
  nowMs?: number;
  /** True when this dispatch is triggered by a delegate change. When true,
   *  all prior idempotency rows for (ticket, agent) are cleared before
   *  admitting the new dispatch. */
  delegateChanged?: boolean;
}

export class DispatchIdempotencyStore {
  private db: Database.Database;
  private _suppressedDuplicates = 0;
  private _droppedStale = 0;
  private _delegateChangeCleared = 0;
  private _ttlExpiredAdmits = 0;
  private readonly dedupTtlMs: number;

  constructor(dbPath?: string, dedupTtlMs?: number) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "dispatch-idempotency.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.dedupTtlMs = dedupTtlMs ?? this.envTtlMs();
    this.migrate();
  }

  /** Read DISPATCH_IDEMPOTENCY_TTL_MS env var, or fall back to DEFAULT_DEDUP_TTL_MS. */
  private envTtlMs(): number {
    const raw = process.env.DISPATCH_IDEMPOTENCY_TTL_MS;
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_DEDUP_TTL_MS;
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
   * Resolve the "now" timestamp from options or wall clock.
   */
  private now(options?: IdempotencyOptions): Date {
    return new Date(options?.nowMs ?? Date.now());
  }

  /**
   * Check whether a dispatch should be admitted, suppressed (duplicate), or
   * dropped (stale). If admitted, the record is persisted. If suppressed or
   * dropped, the relevant in-memory counter is incremented.
   *
   * When options.delegateChanged is true, all prior rows for (ticket, agent)
   * are cleared before admitting — this ensures a re-delegated agent receives
   * the wake even if they previously handled the ticket in the same native
   * state (AI-1973, AI-1855/AI-1926 round-trip fix).
   */
  checkAndRecord(
    ticketKey: string,
    workflowState: string,
    agent: string,
    updatedAt: string,
    options?: IdempotencyOptions,
  ): IdempotencyCheckResult {
    const now = this.now(options);
    const incomingUpdatedAt = new Date(updatedAt).getTime();

    // ── Delegate-change invalidation ────────────────────────────────────────
    // Clear all prior rows for (ticket, agent) BEFORE the duplicate check, so
    // a re-delegation to an agent that previously held the same (ticket, state)
    // is treated as fresh, not suppressed.
    if (options?.delegateChanged) {
      // Check whether the incoming is same-or-older than what we already have
      // for this (ticket, agent). An outdated or equal re-delivery should not
      // trigger a re-wake — suppress as duplicate.
      const latestForAgent = this.db
        .prepare(
          `SELECT MAX(updated_at) as max_updated_at FROM dispatch_idempotency
           WHERE ticket_key = ? AND agent = ?`,
        )
        .get(ticketKey, agent) as { max_updated_at: string } | undefined;

      if (latestForAgent?.max_updated_at) {
        const latestUpdatedAt = new Date(latestForAgent.max_updated_at).getTime();
        if (incomingUpdatedAt < latestUpdatedAt) {
          // Older snapshot — drop as stale.
          this._droppedStale++;
          return { suppressed: false, stale: true };
        }
        if (incomingUpdatedAt === latestUpdatedAt) {
          // Same timestamp — suppress as duplicate (replay dedup).
          this._suppressedDuplicates++;
          return { suppressed: true, stale: false };
        }
      }

      const deleteResult = this.db
        .prepare(`DELETE FROM dispatch_idempotency WHERE ticket_key = ? AND agent = ?`)
        .run(ticketKey, agent);
      if (deleteResult.changes > 0) {
        this._delegateChangeCleared += deleteResult.changes;
      }

      // Admit the new dispatch immediately: we just cleared all rows, so
      // there's nothing to dedup against.
      this.db
        .prepare(
          `INSERT INTO dispatch_idempotency
           (ticket_key, workflow_state, agent, updated_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ticketKey, workflowState, agent, updatedAt, now.toISOString());

      return { suppressed: false, stale: false, clearedRows: deleteResult.changes };
    }

    // ── Stale check (before TTL): snapshot freshness ────────────────────
    // If ANY agent has already seen a newer snapshot of this ticket, the
    // incoming (older) dispatch is stale and must be dropped, regardless of
    // TTL. This check must run BEFORE TTL purge so it can see all rows
    // including those that will be purged below (AI-1973, stale-snapshot
    // ordering ignores TTL).
    const latestTicketRow = this.db
      .prepare(
        `SELECT MAX(updated_at) as max_updated_at FROM dispatch_idempotency
         WHERE ticket_key = ?`,
      )
      .get(ticketKey) as { max_updated_at: string } | undefined;

    if (latestTicketRow && latestTicketRow.max_updated_at) {
      const latestUpdatedAt = new Date(latestTicketRow.max_updated_at).getTime();
      if (incomingUpdatedAt < latestUpdatedAt) {
        this._droppedStale++;
        return { suppressed: false, stale: true };
      }
    }

    // ── TTL-expired admit guard ─────────────────────────────────────────────
    // Before the exact-key duplicate check, purge any row older than TTL.
    // This allows a re-dispatch on the same (ticket, state, agent) after hours
    // of silence without relying on delegate-change signaling.
    const ttlCutoffEpochSecs = Math.floor((now.getTime() - this.dedupTtlMs) / 1000);
    const ttlDeleteResult = this.db
      .prepare(
        `DELETE FROM dispatch_idempotency
         WHERE ticket_key = ? AND workflow_state = ? AND agent = ?
           AND cast(strftime('%s', created_at) AS integer) < ?`,
      )
      .run(ticketKey, workflowState, agent, ttlCutoffEpochSecs);
    const ttlDeletedRows = ttlDeleteResult.changes;

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

    // ── Admit: fresh dispatch. Persist the record. ──
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dispatch_idempotency
         (ticket_key, workflow_state, agent, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ticketKey, workflowState, agent, updatedAt, now.toISOString());

    const result: IdempotencyCheckResult = { suppressed: false, stale: false };
    if (ttlDeletedRows > 0) {
      result.ttlExpired = true;
      this._ttlExpiredAdmits++;
    }
    return result;
  }

  /**
   * Delete all idempotency rows for (ticketKey, agent). Returns the count
   * of deleted rows. Escape hatch for manual recovery.
   */
  clearAgentRows(ticketKey: string, agent: string): number {
    const result = this.db
      .prepare(`DELETE FROM dispatch_idempotency WHERE ticket_key = ? AND agent = ?`)
      .run(ticketKey, agent);
    return result.changes;
  }

  /** In-memory counters for observability (reset on restart, persisted counts
   *  come from operational events). */
  get counters(): IdempotencyCounters {
    return {
      suppressedDuplicates: this._suppressedDuplicates,
      droppedStale: this._droppedStale,
      delegateChangeCleared: this._delegateChangeCleared,
      ttlExpiredAdmits: this._ttlExpiredAdmits,
    };
  }

  close(): void {
    this.db.close();
  }
}
