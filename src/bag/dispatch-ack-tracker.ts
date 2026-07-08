/**
 * DispatchAckTracker — per-ticket dispatch acknowledgment state for the watchdog.
 *
 * Tracks every successful wake-up dispatch (agent, ticket). The watchdog queries
 * this store to find dispatches that have not been acknowledged within a timeout
 * window, then re-signals or escalates them.
 *
 * Acknowledgment sources:
 *   - /session-end callback fires → agent ran, work was picked up
 *   - Watchdog auto-acknowledges a ticket that disappears from the pending bag
 *     (implies the agent pulled it via linear queue)
 *
 * Schema note: UNIQUE(agent_id, ticket_id) means repeated dispatches to the same
 * agent+ticket update last_signal_at and increment attempt_count rather than
 * creating a new row. This keeps the table small and preserves the original
 * dispatched_at for age calculations.
 */

import Database from "better-sqlite3";
import path from "path";
import { createLogger, componentLogger } from "../logger.js";
import { normalizeSessionKey } from "../session-key.js";
import { emitStreamTopic } from "../admin-stream.js";

const log = componentLogger(createLogger(), "dispatch-ack-tracker");

export type AckStatus = "pending" | "acknowledged" | "unconfirmed" | "escalated" | "deferred";

export interface DispatchAckEntry {
  id: number;
  agentId: string;
  ticketId: string;
  dispatchedAt: string;
  lastSignalAt: string;
  ackStatus: AckStatus;
  attemptCount: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class DispatchAckTracker {
  private db: Database.Database;
  private ttlMs: number;

  constructor(dbPath?: string, ttlMs?: number) {
    const resolvedPath =
      dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "dispatch-acks.db");
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_acks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id       TEXT NOT NULL,
        ticket_id      TEXT NOT NULL,
        dispatched_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_signal_at TEXT NOT NULL DEFAULT (datetime('now')),
        ack_status     TEXT NOT NULL DEFAULT 'pending',
        attempt_count  INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_acks_status
        ON dispatch_acks(ack_status, last_signal_at);
      CREATE INDEX IF NOT EXISTS idx_dispatch_acks_agent
        ON dispatch_acks(agent_id);
    `);
  }

  /**
   * Record a successful dispatch for a (agent, ticket) pair.
   *
   * If an entry already exists and is still pending/unconfirmed, updates
   * last_signal_at and increments attempt_count (idempotent re-signal tracking).
   * If it was previously acknowledged, resets to pending (re-delegation case).
   */
  recordDispatch(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `INSERT INTO dispatch_acks
           (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
         VALUES (?, ?, datetime('now'), datetime('now'), 'pending', 1)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET
           last_signal_at = datetime('now'),
           ack_status     = CASE WHEN ack_status = 'acknowledged' THEN 'pending' ELSE ack_status END,
           attempt_count  = attempt_count + 1`,
      )
      .run(agentId, normalizedId);
    log.info(`Dispatch recorded: ${agentId} [${normalizedId}]`);
    emitStreamTopic("fleet");
  }

  /**
   * Register a pending dispatch expectation for a (agent, ticket) pair when the
   * connector commits to delivering to a newly-assigned delegate, BEFORE the
   * wake-up is actually sent.
   *
   * If a real dispatch follows, recordDispatch bumps this row (0 → 1) so the
   * happy-path attempt_count is unchanged. If the delivery is instead swallowed
   * (e.g. by nudge-dedup coalescing) or delivered through a path that records no
   * ack, this placeholder remains 'pending' and the watchdog re-signals it —
   * so a swallowed delivery self-heals instead of stalling indefinitely (AI-1538).
   *
   * Inserted with attempt_count=0 and ON CONFLICT DO NOTHING: it never bumps the
   * counter, never resets last_signal_at, and never resurrects an acknowledged
   * entry.
   */
  ensurePending(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `INSERT INTO dispatch_acks
           (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
         VALUES (?, ?, datetime('now'), datetime('now'), 'pending', 0)
         ON CONFLICT(agent_id, ticket_id) DO NOTHING`,
      )
      .run(agentId, normalizedId);
  }

  /**
   * Acknowledge dispatches for an agent — called when /session-end fires.
   *
   * If ticketId is provided, acknowledges only that specific ticket.
   * If omitted, acknowledges all pending/unconfirmed tickets for the agent
   * (backward-compat path: session-end without per-ticket detail).
   *
   * Returns the number of rows updated.
   */
  acknowledge(agentId: string, ticketId?: string): number {
    if (ticketId) {
      const normalizedId = normalizeSessionKey(ticketId);
      const result = this.db
        .prepare(
          `UPDATE dispatch_acks SET ack_status = 'acknowledged'
           WHERE agent_id = ? AND ticket_id = ?
             AND ack_status IN ('pending', 'unconfirmed')`,
        )
        .run(agentId, normalizedId);
      return result.changes;
    }
    const result = this.db
      .prepare(
        `UPDATE dispatch_acks SET ack_status = 'acknowledged'
         WHERE agent_id = ? AND ack_status IN ('pending', 'unconfirmed')`,
      )
      .run(agentId);
    if (result.changes > 0) {
      log.info(`Acknowledged ${result.changes} dispatch(es) for ${agentId}`);
    }
    return result.changes;
  }

  /**
   * Return dispatches that are still pending/unconfirmed and whose last_signal_at
   * is older than timeoutMs milliseconds. The watchdog calls this each cycle.
   *
   * When timeoutMs <= 0, all pending/unconfirmed entries are returned immediately
   * (useful for testing and for a "check everything now" flush).
   */
  getPendingTimedOut(timeoutMs: number): DispatchAckEntry[] {
    let query: string;
    let params: unknown[];

    if (timeoutMs <= 0) {
      // No timeout: every pending/unconfirmed entry is considered overdue
      query = `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                      ack_status, attempt_count
               FROM dispatch_acks
               WHERE ack_status IN ('pending', 'unconfirmed')
               ORDER BY last_signal_at ASC
               LIMIT 100`;
      params = [];
    } else {
      // JS-computed cutoff in "YYYY-MM-DD HH:MM:SS" (UTC) — same format as datetime('now')
      const cutoff = new Date(Date.now() - timeoutMs)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");
      query = `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                      ack_status, attempt_count
               FROM dispatch_acks
               WHERE ack_status IN ('pending', 'unconfirmed')
                 AND last_signal_at <= ?
               ORDER BY last_signal_at ASC
               LIMIT 100`;
      params = [cutoff];
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      agent_id: string;
      ticket_id: string;
      dispatched_at: string;
      last_signal_at: string;
      ack_status: string;
      attempt_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
    }));
  }

  /**
   * Most recent dispatch entries across all agents and statuses — the
   * management console's fleet/dispatch view (Phase 3). Read-only.
   */
  listRecent(limit = 200): DispatchAckEntry[] {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                ack_status, attempt_count
         FROM dispatch_acks
         ORDER BY last_signal_at DESC
         LIMIT ?`,
      )
      .all(capped) as Array<{
        id: number;
        agent_id: string;
        ticket_id: string;
        dispatched_at: string;
        last_signal_at: string;
        ack_status: string;
        attempt_count: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
    }));
  }

  /**
   * Update a dispatch record after a watchdog re-signal attempt.
   * Sets status to 'unconfirmed', bumps attempt_count, resets last_signal_at
   * AND dispatched_at — a re-signal is a new dispatch attempt, so its
   * no-activity window starts now. Judging retries against the original
   * dispatch clock executed attempts 2 and 3 within one detector cycle
   * (~30s each) instead of giving them full windows (AI-1759, 2026-07-04).
   */
  markResignaled(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks
         SET ack_status = 'unconfirmed',
             dispatched_at = datetime('now'),
             last_signal_at = datetime('now'),
             attempt_count = attempt_count + 1
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
  }

  /**
   * Mark a dispatch as escalated — max re-signals exhausted, admin action required.
   */
  markEscalated(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks SET ack_status = 'escalated'
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
    log.error(`Dispatch escalated: ${agentId} [${normalizedId}] — max re-signals exceeded`);
  }

  /**
   * Mark a dispatch as deferred — agent is alive but at capacity.
   * Does NOT increment attempt_count; this is not a retry, just a hold.
   * The entry will be rescued when a session-end fires or by the stale-deferred sweep.
   */
  markDeferred(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks
         SET ack_status = 'deferred',
             last_signal_at = datetime('now')
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
    log.info(`Dispatch deferred (at-capacity): ${agentId} [${normalizedId}]`);
  }

  /**
   * Return deferred entries whose last_signal_at is older than staleMs.
   * Used by the no-activity detector to rescue entries that were never
   * re-dispatched by a session-end signal.
   */
  getDeferredStale(staleMs: number): DispatchAckEntry[] {
    const cutoff = new Date(Date.now() - staleMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                ack_status, attempt_count
         FROM dispatch_acks
         WHERE ack_status = 'deferred' AND last_signal_at <= ?
         ORDER BY last_signal_at ASC
         LIMIT 50`,
      )
      .all(cutoff) as Array<{
        id: number;
        agent_id: string;
        ticket_id: string;
        dispatched_at: string;
        last_signal_at: string;
        ack_status: string;
        attempt_count: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
    }));
  }

  /**
   * Return true if there is a pending/unconfirmed dispatch for (agentId, ticketId)
   * whose dispatched_at is within the last withinMs milliseconds.
   *
   * Used by StuckDelegateDetector (AI-1650) to guard against re-dispatching a
   * session that is still actively running after a connector restart. The in-memory
   * SessionTracker is reset on restart, so this persisted check is the only way to
   * know a session was recently dispatched and may still be in progress.
   */
  hasRecentPending(agentId: string, ticketId: string, withinMs: number): boolean {
    const normalizedId = normalizeSessionKey(ticketId);
    const cutoff = new Date(Date.now() - withinMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const row = this.db
      .prepare(
        `SELECT 1 FROM dispatch_acks
         WHERE agent_id = ? AND ticket_id = ?
           AND ack_status IN ('pending', 'unconfirmed')
           AND dispatched_at >= ?
         LIMIT 1`,
      )
      .get(agentId, normalizedId, cutoff);
    return row !== undefined;
  }

  /**
   * Prune acknowledged and escalated records older than ttlMs.
   * Called automatically at the end of each watchdog cycle.
   */
  cleanup(): number {
    const cutoff = new Date(Date.now() - this.ttlMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const result = this.db
      .prepare(
        `DELETE FROM dispatch_acks
         WHERE ack_status IN ('acknowledged', 'escalated')
           AND last_signal_at < ?`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      log.info(`Pruned ${result.changes} dispatch ack record(s)`);
    }
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
