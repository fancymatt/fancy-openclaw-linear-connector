import Database from "better-sqlite3";
import path from "path";

/**
 * SQLite-backed operational event store for webhook deduplication and
 * restart safety.
 *
 * This is **operational state** — dedup bookkeeping, not business truth.
 * It can be safely deleted; the only consequence is that events already
 * processed may be re-processed once.
 */
export class EventStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "events.db");
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id   TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'processed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Returns `true` if the event ID has already been recorded.
   */
  isDuplicate(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM events WHERE event_id = ?")
      .get(eventId);
    return row !== undefined;
  }

  /**
   * Records a processed event. Silently ignores duplicates (INSERT OR IGNORE).
   */
  recordEvent(eventId: string, payload: object): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (event_id, payload) VALUES (?, ?)`
      )
      .run(eventId, JSON.stringify(payload));
  }

  /**
   * Retrieves processing metadata for a given event.
   */
  getEvent(eventId: string): { eventId: string; payload: object; status: string; createdAt: string } | undefined {
    const row = this.db
      .prepare("SELECT event_id, payload, status, created_at FROM events WHERE event_id = ?")
      .get(eventId) as { event_id: string; payload: string; status: string; created_at: string } | undefined;

    if (!row) return undefined;

    return {
      eventId: row.event_id,
      payload: JSON.parse(row.payload) as object,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
