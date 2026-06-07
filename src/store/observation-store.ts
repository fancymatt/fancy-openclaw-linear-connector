/**
 * Phase 4 / P4-1 — Append-only observation store for categorized reject feedback.
 *
 * Design: design.md §8 (learning loop), §9 (Observations tier), §10 (micro layer).
 *
 * Every `request-changes` and `reject` transition that carries a validated
 * `category_enum` value writes exactly one observation row. The store is
 * append-only — rows are never updated or deleted. Cheap, auditable,
 * machine-aggregatable.
 *
 * The store lives connector-side (§4.2 / §12 resolved), not in Linear labels.
 * Ad-hoc tickets (no wf:* label) produce no observations.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "observation-store");

/** The validated reason codes from the workflow definition. */
export const REASON_CODES = [
  "missing-tests",
  "style",
  "scope-creep",
  "correctness",
  "ac-mismatch",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Input for a new observation row. */
export interface ObservationInput {
  /** Ticket identifier (e.g. "AI-1378"). */
  ticket: string;
  /** Workflow ID (e.g. "dev-impl"). */
  workflow: string;
  /** Workflow step/state where the feedback was given (e.g. "code-review"). */
  step: string;
  /** The body (agent) that triggered the feedback transition. */
  fromBody: string;
  /** The body (agent) that gave the feedback (reviewer). */
  reviewerBody: string;
  /** Validated category_enum value. */
  reasonCode: ReasonCode;
  /** Optional free-text feedback from the reviewer. */
  freeText?: string | null;
  /** ISO-8601 timestamp; defaults to now. */
  timestamp?: string;
}

/** A persisted observation row. */
export interface Observation {
  id: number;
  ticket: string;
  workflow: string;
  step: string;
  fromBody: string;
  reviewerBody: string;
  reasonCode: string;
  freeText: string | null;
  createdAt: string;
}

/** Query parameters for reading observations. */
export interface ObservationQuery {
  workflow?: string;
  step?: string;
  reasonCode?: ReasonCode;
  ticket?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export class ObservationStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ??
      path.join(
        process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
        "observations.db",
      );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket      TEXT    NOT NULL,
        workflow    TEXT    NOT NULL,
        step        TEXT    NOT NULL,
        from_body   TEXT    NOT NULL,
        reviewer_body TEXT  NOT NULL,
        reason_code TEXT    NOT NULL,
        free_text   TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_observations_workflow_step
        ON observations(workflow, step);
      CREATE INDEX IF NOT EXISTS idx_observations_reason_code
        ON observations(reason_code);
      CREATE INDEX IF NOT EXISTS idx_observations_workflow_step_reason
        ON observations(workflow, step, reason_code);
      CREATE INDEX IF NOT EXISTS idx_observations_ticket
        ON observations(ticket);
      CREATE INDEX IF NOT EXISTS idx_observations_created_at
        ON observations(created_at);
    `);
  }

  /**
   * Validate that a reason code string is a known enum value.
   * Returns the typed ReasonCode, or null if invalid.
   */
  static validateReasonCode(value: string): ReasonCode | null {
    if ((REASON_CODES as readonly string[]).includes(value)) {
      return value as ReasonCode;
    }
    return null;
  }

  /**
   * Append one observation row. Idempotent in the sense that duplicate
   * calls produce additional rows — this is intentional (append-only).
   * Returns the auto-incremented row ID.
   */
  append(input: ObservationInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO observations (ticket, workflow, step, from_body, reviewer_body, reason_code, free_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ticket,
        input.workflow,
        input.step,
        input.fromBody,
        input.reviewerBody,
        input.reasonCode,
        input.freeText ?? null,
        input.timestamp ?? new Date().toISOString(),
      );
    const id = Number(result.lastInsertRowid);
    log.info(
      `observation appended: id=${id} ticket=${input.ticket} workflow=${input.workflow} step=${input.step} reason=${input.reasonCode}`,
    );
    return id;
  }

  /**
   * Query observations with optional filters. Returns rows ordered by
   * creation time descending (newest first).
   */
  query(query: ObservationQuery = {}): Observation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.workflow) {
      clauses.push("workflow = ?");
      params.push(query.workflow);
    }
    if (query.step) {
      clauses.push("step = ?");
      params.push(query.step);
    }
    if (query.reasonCode) {
      clauses.push("reason_code = ?");
      params.push(query.reasonCode);
    }
    if (query.ticket) {
      clauses.push("ticket = ?");
      params.push(query.ticket);
    }
    if (query.since) {
      clauses.push("created_at >= ?");
      params.push(query.since);
    }
    if (query.until) {
      clauses.push("created_at <= ?");
      params.push(query.until);
    }

    const rawLimit = query.limit;
    const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 1000)
      : 100;
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT id, ticket, workflow, step, from_body, reviewer_body, reason_code, free_text, created_at
         FROM observations ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];

    return rows.map(rowToObservation);
  }

  /**
   * Count observations grouped by (workflow, step, reason_code).
   * Used by P4-2 metric aggregation.
   */
  counts(query: { workflow?: string; step?: string; since?: string; until?: string } = {}): Array<{
    workflow: string;
    step: string;
    reasonCode: string;
    count: number;
  }> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.workflow) {
      clauses.push("workflow = ?");
      params.push(query.workflow);
    }
    if (query.step) {
      clauses.push("step = ?");
      params.push(query.step);
    }
    if (query.since) {
      clauses.push("created_at >= ?");
      params.push(query.since);
    }
    if (query.until) {
      clauses.push("created_at <= ?");
      params.push(query.until);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT workflow, step, reason_code, COUNT(*) as cnt
         FROM observations ${where}
         GROUP BY workflow, step, reason_code
         ORDER BY cnt DESC`,
      )
      .all(...params) as Array<{
      workflow: string;
      step: string;
      reason_code: string;
      cnt: number;
    }>;

    return rows.map((r) => ({
      workflow: r.workflow,
      step: r.step,
      reasonCode: r.reason_code,
      count: r.cnt,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToObservation(row: Record<string, unknown>): Observation {
  return {
    id: Number(row.id),
    ticket: String(row.ticket),
    workflow: String(row.workflow),
    step: String(row.step),
    fromBody: String(row.from_body),
    reviewerBody: String(row.reviewer_body),
    reasonCode: String(row.reason_code),
    freeText: row.free_text === null || row.free_text === undefined ? null : String(row.free_text),
    createdAt: String(row.created_at),
  };
}
