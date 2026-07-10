import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import type { ApplyProposal, AppliedRecord, MetricsBaseline } from "../proposal/apply-pipeline.js";

/**
 * AI-2039 (P4-C4) — persistence for learning-loop proposals and their apply
 * outcomes. Backs the `/admin/api/proposals` review-queue console (C5, AI-2040)
 * and the apply pipeline's idempotency store (AC4.5) in one row per proposal.
 *
 * A row carries both the C3-generated proposal (`proposal_json`, holding the
 * `targets[]` the pipeline consumes) and the apply outcome
 * (`status`/`version`/`commit`/`apply_json`). The apply pipeline reads it via
 * {@link getByIdempotencyKey} and writes back via {@link record}; the console
 * lists it via {@link list} and retries via {@link getById}.
 *
 * This is **operational state** — the queue can be rebuilt from the distillation
 * job; deleting the db only drops in-flight review items.
 */

/** A proposal row as surfaced to the console + retry route. */
export interface ProposalRow {
  id: string;
  idempotencyKey: string | null;
  status: string;
  version: number | null;
  commit: string | null;
  /** The C3 proposal (targets[] etc.), when one was stored — required for retry. */
  proposal: ApplyProposal | null;
  metricsBaseline: MetricsBaseline | null;
  error: string | null;
  retryable: boolean | null;
  staleTargets: string[] | null;
  updatedAt: string;
}

export class ProposalStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "proposals.db");
    if (resolvedPath !== ":memory:") {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id              TEXT PRIMARY KEY,
        idempotency_key TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        version         INTEGER,
        commit_hash     TEXT,
        proposal_json   TEXT,
        apply_json      TEXT,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_idempotency ON proposals (idempotency_key);
    `);
  }

  /** Upsert a generated proposal (C3). Preserves any existing apply outcome. */
  saveProposal(proposal: ApplyProposal, status = "pending"): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, idempotency_key, status, proposal_json, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           idempotency_key = excluded.idempotency_key,
           proposal_json   = excluded.proposal_json,
           updated_at      = datetime('now')`,
      )
      .run(proposal.id, proposal.idempotencyKey, status, JSON.stringify(proposal));
  }

  /** All proposals, newest first — the console queue source. */
  list(): ProposalRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM proposals ORDER BY updated_at DESC`)
      .all() as RawRow[];
    return rows.map(rowToProposal);
  }

  getById(id: string): ProposalRow | null {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  // ── Apply-pipeline store interface (AC4.5 idempotency) ────────────────────

  /** Returns the apply outcome record for a proposal by idempotency key, or null. */
  getByIdempotencyKey(key: string): AppliedRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM proposals WHERE idempotency_key = ?`)
      .get(key) as RawRow | undefined;
    if (!row) return null;
    const apply = row.apply_json ? (JSON.parse(row.apply_json) as Partial<AppliedRecord>) : {};
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key ?? key,
      status: row.status as AppliedRecord["status"],
      version: row.version ?? undefined,
      commit: row.commit_hash ?? undefined,
      metricsBaseline: apply.metricsBaseline,
      staleTargets: apply.staleTargets,
      error: apply.error,
      retryable: apply.retryable,
      updatedAt: apply.updatedAt ?? 0,
    };
  }

  /** Persist an apply outcome onto the proposal row (creating one if absent). */
  record(rec: AppliedRecord): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, idempotency_key, status, version, commit_hash, apply_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           idempotency_key = excluded.idempotency_key,
           status          = excluded.status,
           version         = excluded.version,
           commit_hash     = excluded.commit_hash,
           apply_json      = excluded.apply_json,
           updated_at      = datetime('now')`,
      )
      .run(
        rec.id,
        rec.idempotencyKey,
        rec.status,
        rec.version ?? null,
        rec.commit ?? null,
        JSON.stringify(rec),
      );
  }

  close(): void {
    this.db.close();
  }
}

interface RawRow {
  id: string;
  idempotency_key: string | null;
  status: string;
  version: number | null;
  commit_hash: string | null;
  proposal_json: string | null;
  apply_json: string | null;
  updated_at: string;
}

function rowToProposal(row: RawRow): ProposalRow {
  const apply = row.apply_json ? (JSON.parse(row.apply_json) as Partial<AppliedRecord>) : {};
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    version: row.version,
    commit: row.commit_hash,
    proposal: row.proposal_json ? (JSON.parse(row.proposal_json) as ApplyProposal) : null,
    metricsBaseline: apply.metricsBaseline ?? null,
    error: apply.error ?? null,
    retryable: apply.retryable ?? null,
    staleTargets: apply.staleTargets ?? null,
    updatedAt: row.updated_at,
  };
}
