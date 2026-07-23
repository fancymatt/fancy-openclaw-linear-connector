/**
 * Dead-Letter Queue — persisted storage for dispatches whose target agent
 * is not in the roster.
 *
 * When routeEvent returns null (no registered agent for the target), the
 * dispatch is written to this queue with a structured log entry and an
 * observable operational event, rather than being silently dropped.
 *
 * Each entry carries:
 *   - ticketId    — the Linear ticket identifier (e.g., "AI-1234")
 *   - intendedAgent — the agent name that was targeted
 *   - reason      — why the dispatch failed (e.g., "not in roster")
 *   - occurredAt  — when the dead-letter entry was created
 *   - eventPayload — optional snapshot of the original event data
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface DeadLetterEntry {
  id: number;
  ticketId: string;
  intendedAgent: string;
  reason: string;
  occurredAt: string;
  eventPayload: unknown | null;
}

export interface DeadLetterInput {
  ticketId: string;
  intendedAgent: string;
  reason: string;
  eventPayload?: unknown;
}

export interface DeadLetterQuery {
  agent?: string;
  ticketId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

const PRUNE_EVERY_N_WRITES = 100;

export class DeadLetterQueueStore {
  private db: Database.Database;
  private writeCount = 0;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "dead-letter-queue.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dead_letter_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        intended_agent TEXT NOT NULL,
        reason TEXT NOT NULL,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dlq_ticket ON dead_letter_entries(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_dlq_agent ON dead_letter_entries(intended_agent);
      CREATE INDEX IF NOT EXISTS idx_dlq_time ON dead_letter_entries(occurred_at DESC);
    `);
  }

  /** Append a dead-letter entry. Returns the entry id. */
  append(input: DeadLetterInput): number {
    const result = this.db.prepare(`
      INSERT INTO dead_letter_entries (ticket_id, intended_agent, reason, event_payload)
      VALUES (?, ?, ?, ?)
    `).run(
      input.ticketId,
      input.intendedAgent,
      input.reason,
      input.eventPayload ? JSON.stringify(input.eventPayload) : null,
    );
    this.writeCount++;
    if (this.writeCount % PRUNE_EVERY_N_WRITES === 0) this.prune();
    return Number(result.lastInsertRowid);
  }

  /** Query dead-letter entries with optional filters. */
  query(query: DeadLetterQuery = {}): DeadLetterEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.agent) { clauses.push("intended_agent = ?"); params.push(query.agent); }
    if (query.ticketId) { clauses.push("ticket_id = ?"); params.push(query.ticketId); }
    if (query.since) { clauses.push("occurred_at >= ?"); params.push(query.since); }
    if (query.until) { clauses.push("occurred_at <= ?"); params.push(query.until); }

    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT id, ticket_id, intended_agent, reason, occurred_at, event_payload FROM dead_letter_entries ${where} ORDER BY id ASC LIMIT ?`
    ).all(...params, limit) as Record<string, unknown>[];

    return rows.map(this.rowToEntry);
  }

  /** Return all entries for a specific agent, newest first. */
  getByAgent(agent: string, limit = 50): DeadLetterEntry[] {
    const rows = this.db.prepare(
      "SELECT id, ticket_id, intended_agent, reason, occurred_at, event_payload FROM dead_letter_entries WHERE intended_agent = ? ORDER BY id DESC LIMIT ?"
    ).all(agent, limit) as Record<string, unknown>[];
    return rows.map(this.rowToEntry);
  }

  /** Return all entries for a specific ticket, oldest first. */
  getByTicket(ticketId: string, limit = 50): DeadLetterEntry[] {
    const rows = this.db.prepare(
      "SELECT id, ticket_id, intended_agent, reason, occurred_at, event_payload FROM dead_letter_entries WHERE ticket_id = ? ORDER BY id ASC LIMIT ?"
    ).all(ticketId, limit) as Record<string, unknown>[];
    return rows.map(this.rowToEntry);
  }

  /** Count of all dead-letter entries. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM dead_letter_entries").get() as { cnt: number };
    return row.cnt;
  }

  /** Remove entries older than the given number of days. Returns number removed. */
  prune(maxAgeDays = 30): number {
    const result = this.db.prepare(
      "DELETE FROM dead_letter_entries WHERE occurred_at < datetime('now', ?)"
    ).run(`-${maxAgeDays} days`);
    const removed = result.changes;
    if (removed > 0) {
      console.info(`[dead-letter-queue] pruned ${removed} entr${removed === 1 ? "y" : "ies"}`);
    }
    return removed;
  }

  close(): void {
    this.db.close();
  }

  private rowToEntry(row: Record<string, unknown>): DeadLetterEntry {
    return {
      id: Number(row.id),
      ticketId: String(row.ticket_id),
      intendedAgent: String(row.intended_agent),
      reason: String(row.reason),
      occurredAt: String(row.occurred_at),
      eventPayload: row.event_payload ? this.parsePayload(String(row.event_payload)) : null,
    };
  }

  private parsePayload(value: string): unknown {
    try { return JSON.parse(value); } catch { return value; }
  }
}
