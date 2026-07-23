/**
 * AI-2350 — Durable dispatch lease store.
 *
 * A single canonical re-dispatch-idempotency mechanism checked at every delivery
 * point (reconciliation sweep + webhook). Prevents re-dispatches to an agent
 * for a ticket that already has an active lease.
 *
 * Key: (agentId, ticketKey).
 *
 * This store also provides a simplified adapter interface used by the
 * reconciliation wake path (reconciliationWakeFn / INF-282).
 *
 * Lease TTL is configurable via DISPATCH_LEASE_TTL_MS env var (default: 90 min).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Default lease TTL: 90 minutes. */
export const DEFAULT_LEASE_TTL_MS = 90 * 60 * 1000;

/** Max lease TTL: 24 hours — safety cap. */
export const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Internal SQLite types ──────────────────────────────────────────────────

export interface LeaseRecord {
  agent_id: string;
  ticket_key: string;
  dispatched_at: string;
  expires_at: string;
  renewed_at: string;
  ticket_updated_at: string;
}

export interface AcquireResult {
  acquired: boolean;
  refused: boolean;
  superseded?: boolean;
  existingLease: LeaseRecord | null;
}

export interface LeaseStoreCounters {
  acquired: number;
  refused: number;
  superseded: number;
  renewed: number;
  released: number;
  stalePurged: number;
}

// ── Reconciliation-wake interface types ───────────────────────────────────

/**
 * Simplified lease entry shape for the reconciliation wake path.
 * Maps from the internal LeaseRecord to a friendlier shape.
 */
export interface LeaseEntry {
  agentId: string;
  ticketId: string;
  acquiredAt: number;
  ttlMs: number;
}

/**
 * Simplified interface for the reconciliation wake path.
 *
 * The full DispatchLeaseStore class also implements this interface, so callers
 * that only need the simplified API can accept DispatchLeaseStore.
 */
export interface DispatchLeaseStore {
  hasActiveLease(agentId: string, ticketId: string): boolean;
  acquireLease(agentId: string, ticketId: string, ttlMs: number): boolean;
  releaseLease(agentId: string, ticketId: string): void;
  getLease(agentId: string, ticketId: string): LeaseEntry | null;
  pruneExpired(): number;
}

// ── Full implementation ───────────────────────────────────────────────────

export class DispatchLeaseStore {
  private db: Database.Database;
  private readonly leaseTtlMs: number;
  private _acquired = 0;
  private _refused = 0;
  private _superseded = 0;
  private _renewed = 0;
  private _released = 0;
  private _stalePurged = 0;

  constructor(dbPath?: string, leaseTtlMs?: number) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "dispatch-lease.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.leaseTtlMs = this.resolveTtl(leaseTtlMs);
    this.migrate();
  }

  /**
   * Resolve TTL from argument, env var, or default. Clamped to MAX_LEASE_TTL_MS.
   */
  private resolveTtl(explicit?: number): number {
    const raw = explicit ?? process.env.DISPATCH_LEASE_TTL_MS;
    if (raw !== undefined) {
      const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!isNaN(parsed) && parsed > 0) {
        return Math.min(parsed, MAX_LEASE_TTL_MS);
      }
    }
    return DEFAULT_LEASE_TTL_MS;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_lease (
        agent_id TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        dispatched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL DEFAULT (datetime('now')),
        ticket_updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (agent_id, ticket_key)
      );
      CREATE INDEX IF NOT EXISTS idx_lease_expires
        ON dispatch_lease (expires_at);
    `);
  }

  /**
   * Resolve "now" timestamp. Overridable via options for deterministic testing.
   */
  private now(options?: { nowMs?: number }): Date {
    return new Date(options?.nowMs ?? Date.now());
  }

  /**
   * Format a timestamp as ISO-8601 without zone suffix (compatible with SQLite).
   */
  private iso(d: Date): string {
    return d.toISOString();
  }

  /**
   * Acquire a dispatch lease for (agentId, ticketKey).
   *
   * If no active lease exists, creates one and returns { acquired: true }.
   *
   * If an unexpired lease exists:
   *   - If `updatedAt` is provided and is strictly newer than the existing
   *     lease's `ticket_updated_at`, the old lease is superseded.
   *   - Otherwise, returns { acquired: false, refused: true }.
   */
  acquire(
    agentId: string,
    ticketKey: string,
    options?: { nowMs?: number; ttlOverrideMs?: number; updatedAt?: string },
  ): AcquireResult {
    const now = this.now(options);
    const expiresAt = new Date(now.getTime() + (options?.ttlOverrideMs ?? this.leaseTtlMs));

    const acquire = this.db.transaction((): AcquireResult => {
      const row = this.db.prepare(
        `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at, ticket_updated_at
         FROM dispatch_lease
         WHERE agent_id = ? AND ticket_key = ?`,
      ).get(agentId, ticketKey) as LeaseRecord | undefined;

      if (row) {
        const expiresMs = new Date(row.expires_at).getTime();
        if (expiresMs > now.getTime()) {
          if (
            options?.updatedAt &&
            options.updatedAt > row.ticket_updated_at
          ) {
            this.db.prepare(
              `DELETE FROM dispatch_lease WHERE agent_id = ? AND ticket_key = ?`,
            ).run(agentId, ticketKey);
            this._superseded++;
          } else {
            this._refused++;
            return {
              acquired: false,
              refused: true,
              existingLease: row,
            };
          }
        } else {
          this.db.prepare(
            `DELETE FROM dispatch_lease WHERE agent_id = ? AND ticket_key = ?`,
          ).run(agentId, ticketKey);
        }
      }

      const ticketUpdatedAt = options?.updatedAt ?? this.iso(now);
      this.db.prepare(
        `INSERT INTO dispatch_lease (agent_id, ticket_key, dispatched_at, expires_at, renewed_at, ticket_updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(agentId, ticketKey, this.iso(now), this.iso(expiresAt), this.iso(now), ticketUpdatedAt);

      this._acquired++;
      return {
        acquired: true,
        refused: false,
        existingLease: null,
      };
    });

    return acquire();
  }

  /**
   * Check whether an unexpired lease exists without mutating.
   */
  isActive(
    agentId: string,
    ticketKey: string,
    options?: { nowMs?: number },
  ): LeaseRecord | null {
    const now = this.now(options);
    const row = this.db.prepare(
      `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at, ticket_updated_at
       FROM dispatch_lease
       WHERE agent_id = ? AND ticket_key = ? AND expires_at > ?`,
    ).get(agentId, ticketKey, this.iso(now)) as LeaseRecord | undefined;
    return row ?? null;
  }

  /**
   * Renew a lease, extending its expiry by the TTL from now.
   */
  renew(
    agentId: string,
    ticketKey: string,
    options?: { nowMs?: number; ttlOverrideMs?: number },
  ): boolean {
    const now = this.now(options);
    const expiresAt = new Date(now.getTime() + (options?.ttlOverrideMs ?? this.leaseTtlMs));
    const result = this.db.prepare(
      `UPDATE dispatch_lease
       SET renewed_at = ?, expires_at = ?
       WHERE agent_id = ? AND ticket_key = ? AND expires_at > ?`,
    ).run(this.iso(now), this.iso(expiresAt), agentId, ticketKey, this.iso(now));
    if (result.changes > 0) {
      this._renewed++;
      return true;
    }
    return false;
  }

  /**
   * Release a lease — delete the row.
   */
  release(agentId: string, ticketKey: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM dispatch_lease WHERE agent_id = ? AND ticket_key = ?`,
    ).run(agentId, ticketKey);
    if (result.changes > 0) {
      this._released++;
      return true;
    }
    return false;
  }

  /**
   * Release all leases for a given agent.
   */
  releaseAll(agentId: string): number {
    const result = this.db.prepare(
      `DELETE FROM dispatch_lease WHERE agent_id = ?`,
    ).run(agentId);
    if (result.changes > 0) {
      this._released += result.changes;
    }
    return result.changes;
  }

  /**
   * Purge all expired leases.
   */
  purgeExpired(options?: { nowMs?: number }): number {
    const now = this.now(options);
    const result = this.db.prepare(
      `DELETE FROM dispatch_lease WHERE expires_at <= ?`,
    ).run(this.iso(now));
    if (result.changes > 0) {
      this._stalePurged += result.changes;
    }
    return result.changes;
  }

  /**
   * Get a lease record (even if expired). For diagnostics.
   */
  get(agentId: string, ticketKey: string): LeaseRecord | null {
    const row = this.db.prepare(
      `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at, ticket_updated_at
       FROM dispatch_lease
       WHERE agent_id = ? AND ticket_key = ?`,
    ).get(agentId, ticketKey) as LeaseRecord | undefined;
    return row ?? null;
  }

  /** Get all active (unexpired) leases. */
  getAllActive(options?: { nowMs?: number }): LeaseRecord[] {
    const now = this.now(options);
    return this.db.prepare(
      `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at, ticket_updated_at
       FROM dispatch_lease
       WHERE expires_at > ?
       ORDER BY agent_id, ticket_key`,
    ).all(this.iso(now)) as LeaseRecord[];
  }

  get counters(): LeaseStoreCounters {
    return {
      acquired: this._acquired,
      refused: this._refused,
      superseded: this._superseded,
      renewed: this._renewed,
      released: this._released,
      stalePurged: this._stalePurged,
    };
  }

  close(): void {
    this.db.close();
  }

  // ── DispatchLeaseStore interface adapters ─────────────────────────────

  /**
   * Simplified interface: returns true if an unexpired lease exists for (agentId, ticketKey).
   */
  hasActiveLease(agentId: string, ticketKey: string): boolean {
    return this.isActive(agentId, ticketKey) !== null;
  }

  /**
   * Simplified interface: acquire a lease for (agentId, ticketKey) with explicit TTL.
   * Returns true if acquired, false if refused.
   */
  acquireLease(agentId: string, ticketKey: string, ttlMs: number): boolean {
    const result = this.acquire(agentId, ticketKey, { ttlOverrideMs: ttlMs });
    return result.acquired;
  }

  /**
   * Simplified interface: release a lease (void return).
   */
  releaseLease(agentId: string, ticketKey: string): void {
    this.release(agentId, ticketKey);
  }

  /**
   * Simplified interface: get lease entry or null.
   */
  getLease(agentId: string, ticketKey: string): LeaseEntry | null {
    const record = this.get(agentId, ticketKey);
    if (!record) return null;
    const acquired = new Date(record.dispatched_at).getTime();
    const expires = new Date(record.expires_at).getTime();
    return {
      agentId: record.agent_id,
      ticketId: record.ticket_key,
      acquiredAt: acquired,
      ttlMs: expires - acquired,
    };
  }

  /** Alias for purgeExpired — fulfills DispatchLeaseStore.pruneExpired(). */
  pruneExpired(): number {
    return this.purgeExpired();
  }
}
