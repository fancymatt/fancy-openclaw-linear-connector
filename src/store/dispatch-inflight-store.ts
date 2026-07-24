/**
 * INF-413 — Durable in-flight dispatch guard, keyed on ticket identifier.
 *
 * Complements the agent-scoped DispatchLeaseStore (AI-2564, key =
 * (agentId, ticketKey)). Where the lease prevents the SAME agent from being
 * re-dispatched for a ticket it already holds, this store prevents the same
 * TICKET from being dispatched to two concurrent workers REGARDLESS of agent
 * or session.
 *
 * Motivating defect (INF-400, 2026-07-23): ticket INF-400 was dispatched to
 * two concurrent subagent workers (sessions b9628e9f + 3add95e4) on the same
 * ticket. The agent-scoped lease cannot catch this class: two different
 * sessions/agents for one ticket are, to the lease, two distinct keys. A guard
 * keyed on the ticket identifier alone closes that gap: at most one active run
 * per ticket at a time.
 *
 * Key: (ticketKey) — the per-ticket session key (e.g. "linear-INF-400"), which
 * is agent-agnostic by construction (normalizeSessionKey(`linear-<id>`) never
 * includes the agent). Two dispatches for the same ticket to different agents
 * share this key; the second is refused.
 *
 * A `holder` (opaque, typically `${agentId}:${sessionKey}`) is recorded for
 * observability and scoped release, so a duplicate that never acquired cannot
 * release the real holder's record.
 *
 * Supersede-on-newer-updatedAt mirrors DispatchLeaseStore: a genuinely newer
 * ticket state (issue moved/reassigned) supersedes a stale in-flight record so
 * the new owner is not blocked by an outgoing worker's run.
 *
 * TTL is configurable via DISPATCH_INFLIGHT_TTL_MS (default: 15 min). It is a
 * crash-safety bound — a worker that dies without releasing frees the ticket
 * after the TTL rather than wedging it forever.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Default in-flight TTL: 15 minutes. A single worker turn is typically far
 *  shorter; the TTL bounds how long a crashed-without-release run blocks
 *  re-dispatch. */
export const DEFAULT_INFLIGHT_TTL_MS = 15 * 60 * 1000;

/** Max in-flight TTL: 24 hours — safety cap. */
export const MAX_INFLIGHT_TTL_MS = 24 * 60 * 60 * 1000;

export interface InFlightRecord {
  ticket_key: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
  ticket_updated_at: string;
}

export interface InFlightAcquireResult {
  acquired: boolean;
  refused: boolean;
  superseded?: boolean;
  /** The active record that blocked acquisition (only when refused). */
  existing: InFlightRecord | null;
}

export interface InFlightStoreCounters {
  acquired: number;
  refused: number;
  superseded: number;
  released: number;
  stalePurged: number;
}

export class DispatchInFlightStore {
  private db: Database.Database;
  private readonly ttlMs: number;
  private _acquired = 0;
  private _refused = 0;
  private _superseded = 0;
  private _released = 0;
  private _stalePurged = 0;

  constructor(dbPath?: string, ttlMs?: number) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "dispatch-inflight.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.ttlMs = this.resolveTtl(ttlMs);
    this.migrate();
  }

  private resolveTtl(explicit?: number): number {
    const raw = explicit ?? process.env.DISPATCH_INFLIGHT_TTL_MS;
    if (raw !== undefined) {
      const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!isNaN(parsed) && parsed > 0) {
        return Math.min(parsed, MAX_INFLIGHT_TTL_MS);
      }
    }
    return DEFAULT_INFLIGHT_TTL_MS;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_inflight (
        ticket_key TEXT NOT NULL,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ticket_updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (ticket_key)
      );
      CREATE INDEX IF NOT EXISTS idx_inflight_expires
        ON dispatch_inflight (expires_at);
      CREATE INDEX IF NOT EXISTS idx_inflight_holder
        ON dispatch_inflight (holder);
    `);
  }

  private now(options?: { nowMs?: number }): Date {
    return new Date(options?.nowMs ?? Date.now());
  }

  private iso(d: Date): string {
    return d.toISOString();
  }

  /**
   * Atomically check-and-acquire the in-flight record for `ticketKey`.
   *
   * - No active record → insert and return { acquired: true }.
   * - Active record, incoming `updatedAt` strictly newer than the record's
   *   `ticket_updated_at` → supersede (replace) and return
   *   { acquired: true, superseded: true }.
   * - Active record, same-or-older state → refuse and return
   *   { acquired: false, refused: true, existing }.
   *
   * The whole check-and-set runs inside a single better-sqlite3 transaction,
   * so two overlapping callers cannot both acquire: the second observes the
   * first's row and is refused.
   */
  tryAcquire(
    ticketKey: string,
    holder: string,
    options?: { nowMs?: number; ttlOverrideMs?: number; updatedAt?: string },
  ): InFlightAcquireResult {
    const now = this.now(options);
    const expiresAt = new Date(now.getTime() + (options?.ttlOverrideMs ?? this.ttlMs));

    const run = this.db.transaction((): InFlightAcquireResult => {
      const row = this.db.prepare(
        `SELECT ticket_key, holder, acquired_at, expires_at, ticket_updated_at
         FROM dispatch_inflight
         WHERE ticket_key = ?`,
      ).get(ticketKey) as InFlightRecord | undefined;

      let superseded = false;
      if (row) {
        const expiresMs = new Date(row.expires_at).getTime();
        if (expiresMs > now.getTime()) {
          if (options?.updatedAt && options.updatedAt > row.ticket_updated_at) {
            this.db.prepare(
              `DELETE FROM dispatch_inflight WHERE ticket_key = ?`,
            ).run(ticketKey);
            this._superseded++;
            superseded = true;
          } else {
            this._refused++;
            return { acquired: false, refused: true, existing: row };
          }
        } else {
          // Expired record — clear it and acquire fresh.
          this.db.prepare(
            `DELETE FROM dispatch_inflight WHERE ticket_key = ?`,
          ).run(ticketKey);
        }
      }

      const ticketUpdatedAt = options?.updatedAt ?? this.iso(now);
      this.db.prepare(
        `INSERT INTO dispatch_inflight (ticket_key, holder, acquired_at, expires_at, ticket_updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ticketKey, holder, this.iso(now), this.iso(expiresAt), ticketUpdatedAt);

      this._acquired++;
      return { acquired: true, refused: false, superseded, existing: null };
    });

    return run();
  }

  /** Return the active (unexpired) record for `ticketKey`, or null. */
  isInFlight(ticketKey: string, options?: { nowMs?: number }): InFlightRecord | null {
    const now = this.now(options);
    const row = this.db.prepare(
      `SELECT ticket_key, holder, acquired_at, expires_at, ticket_updated_at
       FROM dispatch_inflight
       WHERE ticket_key = ? AND expires_at > ?`,
    ).get(ticketKey, this.iso(now)) as InFlightRecord | undefined;
    return row ?? null;
  }

  /** Extend the in-flight record's expiry by the TTL from now. */
  renew(
    ticketKey: string,
    options?: { nowMs?: number; ttlOverrideMs?: number },
  ): boolean {
    const now = this.now(options);
    const expiresAt = new Date(now.getTime() + (options?.ttlOverrideMs ?? this.ttlMs));
    const result = this.db.prepare(
      `UPDATE dispatch_inflight
       SET expires_at = ?
       WHERE ticket_key = ? AND expires_at > ?`,
    ).run(this.iso(expiresAt), ticketKey, this.iso(now));
    return result.changes > 0;
  }

  /**
   * Release the in-flight record for `ticketKey`.
   *
   * When `holder` is given, the row is deleted only if its holder matches —
   * this prevents a refused duplicate (which never acquired) from releasing
   * the real holder's record. Omit `holder` to force release.
   */
  release(ticketKey: string, options?: { holder?: string }): boolean {
    const result = options?.holder !== undefined
      ? this.db.prepare(
          `DELETE FROM dispatch_inflight WHERE ticket_key = ? AND holder = ?`,
        ).run(ticketKey, options.holder)
      : this.db.prepare(
          `DELETE FROM dispatch_inflight WHERE ticket_key = ?`,
        ).run(ticketKey);
    if (result.changes > 0) {
      this._released += result.changes;
      return true;
    }
    return false;
  }

  /**
   * Release every in-flight record held by `agentId`.
   *
   * Holders are recorded as `${agentId}:${sessionKey}`; this deletes rows whose
   * holder begins with `${agentId}:`. Used at session-end to free a departing
   * agent's tickets, mirroring DispatchLeaseStore.releaseAll(agentId).
   */
  releaseForAgent(agentId: string): number {
    const result = this.db.prepare(
      `DELETE FROM dispatch_inflight WHERE holder LIKE ? ESCAPE '\\'`,
    ).run(`${escapeLike(agentId)}:%`);
    if (result.changes > 0) {
      this._released += result.changes;
    }
    return result.changes;
  }

  /** Purge all expired records. */
  pruneExpired(options?: { nowMs?: number }): number {
    const now = this.now(options);
    const result = this.db.prepare(
      `DELETE FROM dispatch_inflight WHERE expires_at <= ?`,
    ).run(this.iso(now));
    if (result.changes > 0) {
      this._stalePurged += result.changes;
    }
    return result.changes;
  }

  /** Get a record (even if expired). For diagnostics. */
  get(ticketKey: string): InFlightRecord | null {
    const row = this.db.prepare(
      `SELECT ticket_key, holder, acquired_at, expires_at, ticket_updated_at
       FROM dispatch_inflight
       WHERE ticket_key = ?`,
    ).get(ticketKey) as InFlightRecord | undefined;
    return row ?? null;
  }

  /** Get all active (unexpired) records. */
  getAllActive(options?: { nowMs?: number }): InFlightRecord[] {
    const now = this.now(options);
    return this.db.prepare(
      `SELECT ticket_key, holder, acquired_at, expires_at, ticket_updated_at
       FROM dispatch_inflight
       WHERE expires_at > ?
       ORDER BY ticket_key`,
    ).all(this.iso(now)) as InFlightRecord[];
  }

  get counters(): InFlightStoreCounters {
    return {
      acquired: this._acquired,
      refused: this._refused,
      superseded: this._superseded,
      released: this._released,
      stalePurged: this._stalePurged,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Escape LIKE wildcards in a literal so an agentId with %/_ matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
