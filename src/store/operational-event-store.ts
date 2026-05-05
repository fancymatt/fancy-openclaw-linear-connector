import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const OPERATIONAL_EVENT_OUTCOMES = ["received", "signature-rejected", "duplicate", "normalized", "terminal-pruned", "no-route", "routed", "dedup-suppressed", "bag-added", "delivered", "queued", "delivery-failed", "session-ended", "stale-resignaled"] as const;
export type OperationalEventOutcome = typeof OPERATIONAL_EVENT_OUTCOMES[number];

export interface OperationalEventInput {
  outcome: OperationalEventOutcome;
  type?: string | null;
  agent?: string | null;
  key?: string | null;
  deliveryMode?: string | null;
  attemptCount?: number | null;
  runId?: string | null;
  sessionKey?: string | null;
  errorSummary?: string | null;
  detail?: unknown;
  occurredAt?: string;
}
export interface OperationalEvent extends Omit<Required<OperationalEventInput>, "detail" | "occurredAt"> { id: number; occurredAt: string; detail: unknown; }
export interface OperationalEventQuery { agent?: string; key?: string; outcome?: OperationalEventOutcome; type?: string; since?: string; until?: string; limit?: number; }
export interface OperationalSnapshot { key?: string; agent?: string; lastSuccess?: OperationalEvent; lastError?: OperationalEvent; lifecycle: OperationalEvent[]; }

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

const PRUNE_EVERY_N_WRITES = 100;

const SECRET_KEY_PATTERN = /(token|secret|password|authorization|signature|cookie|api[-_]?key|x[-_]?api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|linear[-_]?signature)/i;
const MAX_DETAIL_BYTES = 4096;
const MAX_ERROR_BYTES = 512;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\b((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/ig, "$1[REDACTED]"],
  [/\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/ig, "$1[REDACTED]"],
  [/\b((?:api[-_ ]?key|x[-_ ]?api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/ig, "$1[REDACTED]"],
  [/\b((?:linear[-_ ]?signature|signature)\s*[:=]\s*)[^\s,;]+/ig, "$1[REDACTED]"],
  [/\bsk_(?:live|test|proj)?_[A-Za-z0-9_-]+\b/ig, "[REDACTED]"],
  [/\blin_wh_[A-Za-z0-9_-]+\b/ig, "[REDACTED]"],
  [/\b[^\s,;]*?(?:token|secret|password|authorization|api[-_]?key)[^\s,;]*\b/ig, "[REDACTED]"],
];
const SUCCESS_OUTCOMES = new Set<OperationalEventOutcome>(["received", "normalized", "routed", "bag-added", "delivered", "queued", "session-ended", "stale-resignaled"]);
const ERROR_OUTCOMES = new Set<OperationalEventOutcome>(["signature-rejected", "delivery-failed", "no-route"]);

function redactText(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((output, [pattern, replacement]) => output.replace(pattern, replacement), value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    if (Buffer.byteLength(`${output}${char}…`, "utf8") > maxBytes) break;
    output += char;
  }
  return `${output}…`;
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateUtf8(redactText(value), MAX_DETAIL_BYTES);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: truncateUtf8(redactText(value.message), MAX_ERROR_BYTES) };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeValue(child, seen);
    }
    return output;
  }
  return String(value);
}

export function redactOperationalDetail(detail: unknown): unknown {
  const sanitized = sanitizeValue(detail);
  let json = JSON.stringify(sanitized ?? {});
  if (Buffer.byteLength(json, "utf8") <= MAX_DETAIL_BYTES) return sanitized ?? {};
  json = truncateUtf8(json, MAX_DETAIL_BYTES);
  return { truncated: true, json };
}

function parseDetail(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return { parseError: "Stored detail was invalid JSON" }; }
}

function rowToEvent(row: Record<string, unknown>): OperationalEvent {
  return {
    id: Number(row.id),
    occurredAt: String(row.occurred_at),
    outcome: row.outcome as OperationalEventOutcome,
    type: (row.event_type as string | null) ?? null,
    agent: (row.agent as string | null) ?? null,
    key: (row.subject_key as string | null) ?? null,
    deliveryMode: (row.delivery_mode as string | null) ?? null,
    attemptCount: row.attempt_count === null || row.attempt_count === undefined ? null : Number(row.attempt_count),
    runId: (row.run_id as string | null) ?? null,
    sessionKey: (row.session_key as string | null) ?? null,
    errorSummary: (row.error_summary as string | null) ?? null,
    detail: parseDetail(String(row.detail_json ?? "{}")),
  };
}

export class OperationalEventStore {
  private db: Database.Database;
  private writeCount = 0;
  private readonly maxAgeDays: number;
  private readonly maxRows: number;
  constructor(dbPath?: string) {
    this.maxAgeDays = parseEnvInt("OPERATIONAL_EVENT_MAX_AGE_DAYS", 30);
    this.maxRows = parseEnvInt("OPERATIONAL_EVENT_MAX_ROWS", 10_000);
    const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "operational-events.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.prune();
  }
  private migrate(): void {
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
  prune(): number {
    const ageResult = this.db.prepare(
      `DELETE FROM operational_events WHERE occurred_at < datetime('now', ?)`
    ).run(`-${this.maxAgeDays} days`);
    const capResult = this.db.prepare(
      `DELETE FROM operational_events WHERE id NOT IN (SELECT id FROM operational_events ORDER BY occurred_at DESC, id DESC LIMIT ?)`
    ).run(this.maxRows);
    const removed = ageResult.changes + capResult.changes;
    if (removed > 0) {
      console.info(`[operational-event-store] pruned ${removed} row(s) (age: ${ageResult.changes}, cap: ${capResult.changes})`);
    }
    return removed;
  }
  append(input: OperationalEventInput): number {
    if (!OPERATIONAL_EVENT_OUTCOMES.includes(input.outcome)) throw new Error(`Unsupported operational event outcome: ${input.outcome}`);
    const result = this.db.prepare(`
      INSERT INTO operational_events (occurred_at, outcome, event_type, agent, subject_key, delivery_mode, attempt_count, run_id, session_key, error_summary, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.occurredAt ?? new Date().toISOString(), input.outcome, input.type ?? null, input.agent ?? null, input.key ?? input.sessionKey ?? null,
      input.deliveryMode ?? null, input.attemptCount ?? null, input.runId ?? null, input.sessionKey ?? input.key ?? null,
      input.errorSummary ? truncateUtf8(redactText(input.errorSummary), MAX_ERROR_BYTES) : null, JSON.stringify(redactOperationalDetail(input.detail)),
    );
    this.writeCount++;
    if (this.writeCount % PRUNE_EVERY_N_WRITES === 0) this.prune();
    return Number(result.lastInsertRowid);
  }
  query(query: OperationalEventQuery = {}): OperationalEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.agent) { clauses.push("agent = ?"); params.push(query.agent); }
    if (query.key) { clauses.push("subject_key = ?"); params.push(query.key); }
    if (query.outcome) { clauses.push("outcome = ?"); params.push(query.outcome); }
    if (query.type) { clauses.push("event_type = ?"); params.push(query.type); }
    if (query.since) { clauses.push("occurred_at >= ?"); params.push(query.since); }
    if (query.until) { clauses.push("occurred_at <= ?"); params.push(query.until); }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT id, occurred_at, outcome, event_type, agent, subject_key, delivery_mode, attempt_count, run_id, session_key, error_summary, detail_json FROM operational_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }
  snapshot(query: { key?: string; agent?: string; limit?: number }): OperationalSnapshot {
    const lifecycle = this.query({ key: query.key, agent: query.agent, limit: query.limit ?? 50 });
    return { key: query.key, agent: query.agent, lastSuccess: lifecycle.find((event) => SUCCESS_OUTCOMES.has(event.outcome)), lastError: lifecycle.find((event) => ERROR_OUTCOMES.has(event.outcome) || event.errorSummary), lifecycle };
  }
  close(): void { this.db.close(); }
}
