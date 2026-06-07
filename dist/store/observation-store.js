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
];
export class ObservationStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ??
            path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "observations.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
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
    static validateReasonCode(value) {
        if (REASON_CODES.includes(value)) {
            return value;
        }
        return null;
    }
    /**
     * Append one observation row. Idempotent in the sense that duplicate
     * calls produce additional rows — this is intentional (append-only).
     * Returns the auto-incremented row ID.
     */
    append(input) {
        const result = this.db
            .prepare(`INSERT INTO observations (ticket, workflow, step, from_body, reviewer_body, reason_code, free_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.ticket, input.workflow, input.step, input.fromBody, input.reviewerBody, input.reasonCode, input.freeText ?? null, input.timestamp ?? new Date().toISOString());
        const id = Number(result.lastInsertRowid);
        log.info(`observation appended: id=${id} ticket=${input.ticket} workflow=${input.workflow} step=${input.step} reason=${input.reasonCode}`);
        return id;
    }
    /**
     * Query observations with optional filters. Returns rows ordered by
     * creation time descending (newest first).
     */
    query(query = {}) {
        const clauses = [];
        const params = [];
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
            .prepare(`SELECT id, ticket, workflow, step, from_body, reviewer_body, reason_code, free_text, created_at
         FROM observations ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`)
            .all(...params, limit);
        return rows.map(rowToObservation);
    }
    /**
     * Count observations grouped by (workflow, step, reason_code).
     * Used by P4-2 metric aggregation.
     */
    counts(query = {}) {
        const clauses = [];
        const params = [];
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
            .prepare(`SELECT workflow, step, reason_code, COUNT(*) as cnt
         FROM observations ${where}
         GROUP BY workflow, step, reason_code
         ORDER BY cnt DESC`)
            .all(...params);
        return rows.map((r) => ({
            workflow: r.workflow,
            step: r.step,
            reasonCode: r.reason_code,
            count: r.cnt,
        }));
    }
    close() {
        this.db.close();
    }
}
function rowToObservation(row) {
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
//# sourceMappingURL=observation-store.js.map