import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { redactOperationalDetail } from "../store/operational-event-store.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertInput {
  severity: AlertSeverity;
  /** Subsystem slug, e.g. "dispatch", "config-health", "token-refresh". */
  source: string;
  /** One-line human summary. */
  title: string;
  /** Optional multiline context. Redacted + truncated before storage. */
  detail?: unknown;
  agent?: string | null;
  ticket?: string | null;
  /** Dedup identity. Defaults to source|title|agent|ticket. */
  dedupKey?: string;
  /**
   * Override the suppression window for this dedup identity.
   * When set, AlertBus uses this value instead of the severity-based
   * SUPPRESS_WINDOW_MS for the record() call, allowing specific checks
   * (e.g. git-remote-liveness critical) to use a longer window.
   */
  suppressWindowMs?: number;
}

export interface AlertRow {
  id: number;
  firstAt: string;
  lastAt: string;
  severity: AlertSeverity;
  source: string;
  title: string;
  detail: unknown;
  agent: string | null;
  ticket: string | null;
  dedupKey: string;
  count: number;
  pushedAt: string | null;
  pushedVia: string | null;
  ackedAt: string | null;
}

export interface AlertQuery {
  severity?: AlertSeverity;
  source?: string;
  agent?: string;
  ticket?: string;
  unackedOnly?: boolean;
  since?: string;
  limit?: number;
}

/** AI-2037 / AC2.3: a dead-letter cluster, keyed on (source, dedupKey, agent). */
export interface AlertCluster {
  source: string;
  dedupKey: string;
  agent: string | null;
  count: number;
  exceedsThreshold: boolean;
  firstAt: string;
  lastAt: string;
}

export interface RecordResult {
  row: AlertRow;
  /** True when this occurrence was folded into an existing burst row. */
  suppressed: boolean;
  /** Count of the previous burst with the same dedupKey, if any (for "xN" context). */
  priorBurstCount: number | null;
}

export function defaultDedupKey(alert: AlertInput): string {
  return [alert.source, alert.title, alert.agent ?? "", alert.ticket ?? ""].join("|");
}

function rowToAlert(row: Record<string, unknown>): AlertRow {
  let detail: unknown;
  try {
    detail = JSON.parse(String(row.detail_json ?? "{}"));
  } catch {
    detail = { parseError: "Stored detail was invalid JSON" };
  }
  return {
    id: Number(row.id),
    firstAt: String(row.first_at),
    lastAt: String(row.last_at),
    severity: row.severity as AlertSeverity,
    source: String(row.source),
    title: String(row.title),
    detail,
    agent: (row.agent as string | null) ?? null,
    ticket: (row.ticket as string | null) ?? null,
    dedupKey: String(row.dedup_key),
    count: Number(row.count),
    pushedAt: (row.pushed_at as string | null) ?? null,
    pushedVia: (row.pushed_via as string | null) ?? null,
    ackedAt: (row.acked_at as string | null) ?? null,
  };
}

/**
 * Persistent, human-facing alert history (design: docs/alert-bus.md).
 *
 * One row per BURST: repeats of the same dedupKey inside the suppression
 * window increment `count` on the existing row instead of inserting. The
 * operational-event store remains the full-detail machine log; this table is
 * what a human (and later the console) should actually look at.
 */
export class AlertStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved =
      dbPath ??
      process.env.ALERTS_DB_PATH ??
      path.join(process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"), "alerts.db");
    if (resolved !== ":memory:") {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    }
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        agent TEXT,
        ticket TEXT,
        dedup_key TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        pushed_at TEXT,
        acked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts (dedup_key, last_at);
      CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity, last_at);
    `);
    // pushed_via: which transport claimed the push. "pushed" alone proved
    // meaningless on 2026-07-04 — hook-relay resolved success while the
    // message never reached Matt. Recording the transport makes "pushed_at"
    // auditable: hook-relay means ACCEPTED (model turn started), only
    // matrix-message means the gateway confirmed the channel send.
    const cols = this.db.prepare("PRAGMA table_info(alerts)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "pushed_via")) {
      this.db.exec("ALTER TABLE alerts ADD COLUMN pushed_via TEXT");
    }
  }

  /**
   * Record an occurrence. If the latest row for the dedupKey started within
   * `suppressWindowMs`, the occurrence folds into it (suppressed=true).
   */
  record(alert: AlertInput, suppressWindowMs: number, now = new Date()): RecordResult {
    const dedupKey = alert.dedupKey ?? defaultDedupKey(alert);
    const nowIso = now.toISOString();
    const detailJson = JSON.stringify(redactOperationalDetail(alert.detail ?? {}));

    const latest = this.db
      .prepare("SELECT * FROM alerts WHERE dedup_key = ? ORDER BY id DESC LIMIT 1")
      .get(dedupKey) as Record<string, unknown> | undefined;

    if (latest && now.getTime() - Date.parse(String(latest.first_at)) < suppressWindowMs) {
      this.db
        .prepare("UPDATE alerts SET last_at = ?, count = count + 1, detail_json = ? WHERE id = ?")
        .run(nowIso, detailJson, Number(latest.id));
      const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(Number(latest.id)) as Record<string, unknown>;
      return { row: rowToAlert(row), suppressed: true, priorBurstCount: null };
    }

    const inserted = this.db
      .prepare(
        `INSERT INTO alerts (first_at, last_at, severity, source, title, detail_json, agent, ticket, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nowIso,
        nowIso,
        alert.severity,
        alert.source,
        alert.title,
        detailJson,
        alert.agent ?? null,
        alert.ticket ?? null,
        dedupKey
      );
    const row = this.db
      .prepare("SELECT * FROM alerts WHERE id = ?")
      .get(Number(inserted.lastInsertRowid)) as Record<string, unknown>;
    return {
      row: rowToAlert(row),
      suppressed: false,
      priorBurstCount: latest && Number(latest.count) > 1 ? Number(latest.count) : null,
    };
  }

  markPushed(id: number, now = new Date(), via?: string): void {
    this.db
      .prepare("UPDATE alerts SET pushed_at = ?, pushed_via = ? WHERE id = ?")
      .run(now.toISOString(), via ?? null, id);
  }

  ack(id: number, now = new Date()): boolean {
    const result = this.db
      .prepare("UPDATE alerts SET acked_at = ? WHERE id = ? AND acked_at IS NULL")
      .run(now.toISOString(), id);
    return result.changes > 0;
  }

  query(q: AlertQuery = {}): AlertRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.severity) { clauses.push("severity = ?"); params.push(q.severity); }
    if (q.source) { clauses.push("source = ?"); params.push(q.source); }
    if (q.agent) { clauses.push("agent = ?"); params.push(q.agent); }
    if (q.ticket) { clauses.push("ticket = ?"); params.push(q.ticket); }
    if (q.unackedOnly) { clauses.push("acked_at IS NULL"); }
    if (q.since) { clauses.push("last_at >= ?"); params.push(q.since); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM alerts ${where} ORDER BY last_at DESC LIMIT ${limit}`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToAlert);
  }

  /**
   * AI-2037 / AC2.3: cluster dead-letter rows by (source, dedup_key, agent).
   *
   * A single dedup identity can span several rows: each burst outside the
   * suppression window inserts a new row carrying its own `count`. The cluster
   * count is therefore SUM(count) across those rows, not COUNT(*) of them.
   */
  clusters(q: { since?: string; until?: string; threshold?: number; limit?: number } = {}): AlertCluster[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.since) { clauses.push("last_at >= ?"); params.push(q.since); }
    if (q.until) { clauses.push("last_at <= ?"); params.push(q.until); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT source, dedup_key, agent,
                SUM(count) AS total,
                MIN(first_at) AS first_at,
                MAX(last_at)  AS last_at
         FROM alerts ${where}
         GROUP BY source, dedup_key, agent
         ORDER BY total DESC`
      )
      .all(...params) as Array<{ source: string; dedup_key: string; agent: string | null; total: number; first_at: string; last_at: string }>;

    const threshold = q.threshold;
    const clusters = rows.map((r) => ({
      source: r.source,
      dedupKey: r.dedup_key,
      agent: r.agent ?? null,
      count: Number(r.total),
      exceedsThreshold: threshold !== undefined && Number(r.total) >= threshold,
      firstAt: r.first_at,
      lastAt: r.last_at,
    }));
    return q.limit !== undefined && q.limit > 0 ? clusters.slice(0, q.limit) : clusters;
  }

  close(): void {
    this.db.close();
  }
}
