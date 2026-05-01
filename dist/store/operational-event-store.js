import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export const OPERATIONAL_EVENT_OUTCOMES = ["received", "signature-rejected", "duplicate", "normalized", "terminal-pruned", "no-route", "routed", "dedup-suppressed", "bag-added", "delivered", "queued", "delivery-failed", "session-ended", "stale-resignaled"];
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|signature|cookie|apikey|api_key|clientsecret|client_secret|accesstoken|access_token|refreshtoken|refresh_token)/i;
const MAX_DETAIL_BYTES = 4096;
const MAX_ERROR_BYTES = 512;
const SECRET_VALUE_PATTERN = /\b[^\s,;]*?(?:token|secret|password|authorization|apikey|api_key)[^\s,;]*\b/ig;
const SUCCESS_OUTCOMES = new Set(["received", "normalized", "routed", "bag-added", "delivered", "queued", "session-ended", "stale-resignaled"]);
const ERROR_OUTCOMES = new Set(["signature-rejected", "delivery-failed", "no-route"]);
function redactText(value) {
    return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}
function truncateUtf8(value, maxBytes) {
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    let output = "";
    for (const char of value) {
        if (Buffer.byteLength(`${output}${char}…`, "utf8") > maxBytes)
            break;
        output += char;
    }
    return `${output}…`;
}
function sanitizeValue(value, seen = new WeakSet()) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return truncateUtf8(redactText(value), MAX_DETAIL_BYTES);
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (value instanceof Error)
        return { name: value.name, message: truncateUtf8(value.message, MAX_ERROR_BYTES) };
    if (Array.isArray(value))
        return value.slice(0, 50).map((item) => sanitizeValue(item, seen));
    if (typeof value === "object") {
        if (seen.has(value))
            return "[Circular]";
        seen.add(value);
        const output = {};
        for (const [key, child] of Object.entries(value)) {
            output[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeValue(child, seen);
        }
        return output;
    }
    return String(value);
}
export function redactOperationalDetail(detail) {
    const sanitized = sanitizeValue(detail);
    let json = JSON.stringify(sanitized ?? {});
    if (Buffer.byteLength(json, "utf8") <= MAX_DETAIL_BYTES)
        return sanitized ?? {};
    json = truncateUtf8(json, MAX_DETAIL_BYTES);
    return { truncated: true, json };
}
function parseDetail(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return { parseError: "Stored detail was invalid JSON" };
    }
}
function rowToEvent(row) {
    return {
        id: Number(row.id),
        occurredAt: String(row.occurred_at),
        outcome: row.outcome,
        type: row.event_type ?? null,
        agent: row.agent ?? null,
        key: row.subject_key ?? null,
        deliveryMode: row.delivery_mode ?? null,
        attemptCount: row.attempt_count === null || row.attempt_count === undefined ? null : Number(row.attempt_count),
        runId: row.run_id ?? null,
        sessionKey: row.session_key ?? null,
        errorSummary: row.error_summary ?? null,
        detail: parseDetail(String(row.detail_json ?? "{}")),
    };
}
export class OperationalEventStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "operational-events.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS operational_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        outcome TEXT NOT NULL,
        event_type TEXT,
        agent TEXT,
        subject_key TEXT,
        delivery_mode TEXT,
        attempt_count INTEGER,
        run_id TEXT,
        session_key TEXT,
        error_summary TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_operational_events_agent_time ON operational_events(agent, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operational_events_key_time ON operational_events(subject_key, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operational_events_outcome_time ON operational_events(outcome, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operational_events_type_time ON operational_events(event_type, occurred_at DESC);
    `);
    }
    append(input) {
        if (!OPERATIONAL_EVENT_OUTCOMES.includes(input.outcome))
            throw new Error(`Unsupported operational event outcome: ${input.outcome}`);
        const result = this.db.prepare(`
      INSERT INTO operational_events (occurred_at, outcome, event_type, agent, subject_key, delivery_mode, attempt_count, run_id, session_key, error_summary, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.occurredAt ?? new Date().toISOString(), input.outcome, input.type ?? null, input.agent ?? null, input.key ?? input.sessionKey ?? null, input.deliveryMode ?? null, input.attemptCount ?? null, input.runId ?? null, input.sessionKey ?? input.key ?? null, input.errorSummary ? truncateUtf8(redactText(input.errorSummary), MAX_ERROR_BYTES) : null, JSON.stringify(redactOperationalDetail(input.detail)));
        return Number(result.lastInsertRowid);
    }
    query(query = {}) {
        const clauses = [];
        const params = [];
        if (query.agent) {
            clauses.push("agent = ?");
            params.push(query.agent);
        }
        if (query.key) {
            clauses.push("subject_key = ?");
            params.push(query.key);
        }
        if (query.outcome) {
            clauses.push("outcome = ?");
            params.push(query.outcome);
        }
        if (query.type) {
            clauses.push("event_type = ?");
            params.push(query.type);
        }
        if (query.since) {
            clauses.push("occurred_at >= ?");
            params.push(query.since);
        }
        if (query.until) {
            clauses.push("occurred_at <= ?");
            params.push(query.until);
        }
        const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db.prepare(`SELECT id, occurred_at, outcome, event_type, agent, subject_key, delivery_mode, attempt_count, run_id, session_key, error_summary, detail_json FROM operational_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(...params, limit);
        return rows.map(rowToEvent);
    }
    snapshot(query) {
        const lifecycle = this.query({ key: query.key, agent: query.agent, limit: query.limit ?? 50 });
        return { key: query.key, agent: query.agent, lastSuccess: lifecycle.find((event) => SUCCESS_OUTCOMES.has(event.outcome)), lastError: lifecycle.find((event) => ERROR_OUTCOMES.has(event.outcome) || event.errorSummary), lifecycle };
    }
    close() { this.db.close(); }
}
//# sourceMappingURL=operational-event-store.js.map