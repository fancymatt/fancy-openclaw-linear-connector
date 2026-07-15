/**
 * AI-1838 — Mutation audit log for out-of-band detection (Pillar-1 bypass).
 *
 * Records every state/label/delegate change the connector **observes** from
 * Linear webhooks (source = "webhook") and every state/label/delegate mutation
 * the proxy **forwards** upstream (source = "proxy"). The periodic reconcile
 * sweep (oob-reconcile-sweep.ts) compares the two populations to detect
 * out-of-band mutations — changes made directly to api.linear.app that
 * bypassed the proxy gate entirely.
 *
 * Design:
 *   - Single SQLite table with a `source` discriminator ('webhook' | 'proxy').
 *   - `correlated` flag: set by the reconcile sweep when a webhook record is
 *     matched to a proxy record. Unmatched webhook records past the grace
 *     window are the out-of-band signal.
 *   - Append-only: rows are never updated except for the correlation flag.
 *   - Pruning keeps the table bounded (default 30 days).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "mutation-audit-store");

// ── Types ────────────────────────────────────────────────────────────────────

export type MutationSource = "webhook" | "proxy";

export type ChangeType = "state" | "label" | "delegate" | "assignee";

export interface MutationAuditInput {
  source: MutationSource;
  ticket: string;
  changeType: ChangeType;
  /** Specific field name, e.g. "state:done", "wf:dev-impl", "delegateId". */
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  /** Linear user id of the actor (webhook) or agent name (proxy). */
  actorId?: string | null;
  /** Connector agent name (proxy ops). */
  agent?: string | null;
  /** Workflow intent (proxy ops only, e.g. "advance", "request-changes"). */
  intent?: string | null;
  /** Delivery/event id from EventStore (webhook source). */
  webhookEventId?: string | null;
  /** GraphQL operation name (proxy source). */
  opName?: string | null;
  /** UUID of the issue (for cross-referencing when proxy only has UUID and webhook has identifier). */
  ticketUuid?: string | null;
  /**
   * AI-1860 AC7: invoking session key (proxy source) — the OpenClaw session that
   * ran the governed intent, e.g. "agent:astrid:linear-ai-1848". Recording it makes
   * "who ran this governed mutation" a one-query lookup (the AI-1909 forensics gap).
   */
  sessionKey?: string | null;
  /** ISO timestamp; defaults to now. */
  recordedAt?: string;
}

export interface MutationAuditRecord {
  id: number;
  source: MutationSource;
  recordedAt: string;
  ticket: string;
  changeType: ChangeType;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  actorId: string | null;
  agent: string | null;
  intent: string | null;
  webhookEventId: string | null;
  opName: string | null;
  ticketUuid: string | null;
  sessionKey: string | null;
  correlated: number;
  correlatedAt: string | null;
}

export interface UnmatchedMutation {
  webhook: MutationAuditRecord;
  /** Proxy records for the same ticket in the time window (none matched). */
  candidateCount: number;
}

// ── Store ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_ROWS = 50_000;

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

export class MutationAuditStore {
  private db: Database.Database;
  private writeCount = 0;
  private readonly maxAgeDays: number;
  private readonly maxRows: number;
  private readonly pruneEveryN;

  constructor(dbPath?: string) {
    this.maxAgeDays = parseEnvInt("MUTATION_AUDIT_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS);
    this.maxRows = parseEnvInt("MUTATION_AUDIT_MAX_ROWS", DEFAULT_MAX_ROWS);
    this.pruneEveryN = 100;
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "mutation-audit.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.prune();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mutation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        ticket TEXT NOT NULL,
        change_type TEXT NOT NULL,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        actor_id TEXT,
        agent TEXT,
        intent TEXT,
        webhook_event_id TEXT,
        op_name TEXT,
        correlated INTEGER NOT NULL DEFAULT 0,
        correlated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_ticket_time
        ON mutation_audit(ticket, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_source_correlated
        ON mutation_audit(source, correlated, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_change_type
        ON mutation_audit(change_type, recorded_at DESC);
    `);

    // AI-1838: add ticket_uuid column for UUID⇄identifier cross-referencing.
    const addColumnIfMissing = (col: string, def: string): void => {
      const exists = this.db.prepare(
        `SELECT COUNT(*) AS c FROM pragma_table_info('mutation_audit') WHERE name = ?`,
      ).get(col) as { c: number };
      if (exists.c === 0) {
        this.db.exec(`ALTER TABLE mutation_audit ADD COLUMN ${col} ${def}`);
      }
    };
    addColumnIfMissing("ticket_uuid", "TEXT");
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_mutation_audit_ticket_uuid ON mutation_audit(ticket_uuid)`,
    );

    // AI-1860 AC7: invoking session identity for governed proxy mutations.
    addColumnIfMissing("session_key", "TEXT");
  }

  prune(): number {
    const ageResult = this.db.prepare(
      `DELETE FROM mutation_audit WHERE recorded_at < datetime('now', ?)`,
    ).run(`-${this.maxAgeDays} days`);
    const capResult = this.db.prepare(
      `DELETE FROM mutation_audit WHERE id NOT IN (
        SELECT id FROM mutation_audit ORDER BY recorded_at DESC, id DESC LIMIT ?
      )`,
    ).run(this.maxRows);
    const removed = ageResult.changes + capResult.changes;
    if (removed > 0) {
      log.info(`pruned ${removed} row(s) (age: ${ageResult.changes}, cap: ${capResult.changes})`);
    }
    return removed;
  }

  append(input: MutationAuditInput): number {
    const result = this.db.prepare(`
      INSERT INTO mutation_audit (
        recorded_at, source, ticket, change_type, field, old_value, new_value,
        actor_id, agent, intent, webhook_event_id, op_name, ticket_uuid, session_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.recordedAt ?? new Date().toISOString(),
      input.source,
      input.ticket,
      input.changeType,
      input.field ?? null,
      input.oldValue ?? null,
      input.newValue ?? null,
      input.actorId ?? null,
      input.agent ?? null,
      input.intent ?? null,
      input.webhookEventId ?? null,
      input.opName ?? null,
      input.ticketUuid ?? null,
      input.sessionKey ?? null,
    );
    this.writeCount++;
    if (this.writeCount % this.pruneEveryN === 0) this.prune();
    return Number(result.lastInsertRowid);
  }

  /** Batch-append multiple records in a single transaction. */
  appendBatch(inputs: MutationAuditInput[]): number[] {
    if (inputs.length === 0) return [];
    const insert = this.db.prepare(`
      INSERT INTO mutation_audit (
        recorded_at, source, ticket, change_type, field, old_value, new_value,
        actor_id, agent, intent, webhook_event_id, op_name, ticket_uuid, session_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      for (const input of inputs) {
        const result = insert.run(
          input.recordedAt ?? new Date().toISOString(),
          input.source,
          input.ticket,
          input.changeType,
          input.field ?? null,
          input.oldValue ?? null,
          input.newValue ?? null,
          input.actorId ?? null,
          input.agent ?? null,
          input.intent ?? null,
          input.webhookEventId ?? null,
          input.opName ?? null,
          input.ticketUuid ?? null,
          input.sessionKey ?? null,
        );
        ids.push(Number(result.lastInsertRowid));
      }
    });
    tx();
    this.writeCount += inputs.length;
    if (this.writeCount % this.pruneEveryN === 0) this.prune();
    return ids;
  }

  /**
   * Mark a webhook record as correlated to a proxy record.
   * Both records get `correlated=1` and a shared `correlated_at` timestamp.
   */
  correlate(webhookId: number, proxyId: number, correlatedAt?: string): void {
    const ts = correlatedAt ?? new Date().toISOString();
    this.db.prepare(`
      UPDATE mutation_audit SET correlated = 1, correlated_at = ?
      WHERE id = ? AND source = 'webhook'
    `).run(ts, webhookId);
    this.db.prepare(`
      UPDATE mutation_audit SET correlated = 1, correlated_at = ?
      WHERE id = ? AND source = 'proxy'
    `).run(ts, proxyId);
  }

  /**
   * AI-2191 — Mark a flagged webhook record as resolved after it has been
   * surfaced as an out-of-band mutation (no matching proxy op).
   *
   * Unlike {@link correlate}, this does NOT pair the record to a proxy op — it
   * records that the OOB alert has already been fired, so subsequent reconcile
   * sweeps skip it. `uncorrelatedWebhookMutations` filters on `correlated = 0`;
   * without this call, flagged records stay uncorrelated forever, so every
   * sweep re-examines the full cumulative set of unresolved OOB records and the
   * hourly alert count climbs monotonically (10 → 109 → … → 351) instead of
   * reporting the per-window delta.
   *
   * Reuses the existing `correlated` column (no schema change, no migration):
   * `correlated = 1` means "this webhook mutation needs no further reconcile
   * attention," whether because it matched a proxy op or because it was flagged
   * and alerted. The `correlated_at` timestamp persists in SQLite, so a restart
   * does not re-alert an already-flagged backlog.
   */
  markFlaggedResolved(webhookId: number, resolvedAt?: string): void {
    const ts = resolvedAt ?? new Date().toISOString();
    this.db.prepare(`
      UPDATE mutation_audit SET correlated = 1, correlated_at = ?
      WHERE id = ? AND source = 'webhook'
    `).run(ts, webhookId);
  }

  /**
   * Find proxy records for a given ticket/change_type within a time window.
   * Matches on exact ticket OR ticket_uuid to handle the UUID⇄identifier gap
   * (proxy often only has the UUID; webhook has the human-readable identifier).
   * Used by the reconcile sweep to match against webhook-observed changes.
   */
  findProxyCandidates(
    ticket: string,
    changeType: ChangeType,
    sinceIso: string,
    untilIso: string,
    ticketUuid?: string | null,
  ): MutationAuditRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM mutation_audit
      WHERE source = 'proxy'
        AND change_type = ?
        AND recorded_at >= ?
        AND recorded_at <= ?
        AND (ticket = ? OR ticket_uuid = ? ${ticketUuid ? "OR ticket = ? OR ticket_uuid = ?" : ""})
      ORDER BY recorded_at ASC
    `).all(
      changeType, sinceIso, untilIso,
      ticket, ticket ?? null,
      ...(ticketUuid ? [ticketUuid, ticketUuid] : []),
    ) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  /**
   * Return webhook-observed state/label/delegate mutations that are still
   * uncorrelated and older than the grace window. These are the candidates
   * for out-of-band detection.
   */
  uncorrelatedWebhookMutations(
    changeTypes: ChangeType[],
    sinceIso: string,
    graceCutoffIso: string,
  ): MutationAuditRecord[] {
    if (changeTypes.length === 0) return [];
    const placeholders = changeTypes.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM mutation_audit
      WHERE source = 'webhook'
        AND correlated = 0
        AND recorded_at >= ?
        AND recorded_at <= ?
        AND change_type IN (${placeholders})
      ORDER BY recorded_at ASC
    `).all(sinceIso, graceCutoffIso, ...changeTypes) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  /** All records for a ticket (admin/debug). */
  byTicket(ticket: string, limit = 100): MutationAuditRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM mutation_audit WHERE ticket = ?
      ORDER BY recorded_at DESC LIMIT ?
    `).all(ticket, limit) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  /** Stats for /health and admin views. */
  stats(): {
    webhookTotal: number;
    proxyTotal: number;
    correlated: number;
    uncorrelated: number;
  } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN source = 'webhook' THEN 1 ELSE 0 END) AS webhook_total,
        SUM(CASE WHEN source = 'proxy' THEN 1 ELSE 0 END) AS proxy_total,
        SUM(CASE WHEN correlated = 1 THEN 1 ELSE 0 END) AS correlated,
        SUM(CASE WHEN source = 'webhook' AND correlated = 0 THEN 1 ELSE 0 END) AS uncorrelated
      FROM mutation_audit
    `).get() as Record<string, number | null>;
    return {
      webhookTotal: row.webhook_total ?? 0,
      proxyTotal: row.proxy_total ?? 0,
      correlated: row.correlated ?? 0,
      uncorrelated: row.uncorrelated ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: Record<string, unknown>): MutationAuditRecord {
  return {
    id: Number(row.id),
    source: row.source as MutationSource,
    recordedAt: String(row.recorded_at),
    ticket: String(row.ticket),
    changeType: row.change_type as ChangeType,
    field: (row.field as string | null) ?? null,
    oldValue: (row.old_value as string | null) ?? null,
    newValue: (row.new_value as string | null) ?? null,
    actorId: (row.actor_id as string | null) ?? null,
    agent: (row.agent as string | null) ?? null,
    intent: (row.intent as string | null) ?? null,
    webhookEventId: (row.webhook_event_id as string | null) ?? null,
    opName: (row.op_name as string | null) ?? null,
    ticketUuid: (row.ticket_uuid as string | null) ?? null,
    sessionKey: (row.session_key as string | null) ?? null,
    correlated: Number(row.correlated),
    correlatedAt: (row.correlated_at as string | null) ?? null,
  };
}
