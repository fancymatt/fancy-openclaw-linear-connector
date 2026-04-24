import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

/**
 * SQLite-backed nudge suppression store.
 *
 * Tracks the last time each agent+ticket combination was sent a nudge.
 * Suppresses rapid-fire duplicate events on the SAME ticket, but always
 * allows different tickets through.
 */
export class NudgeStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "nudges.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    // Drop old agent-only table if it exists and recreate with composite key
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nudge_log (
        agent_id      TEXT NOT NULL,
        ticket_id     TEXT NOT NULL,
        last_nudge_at TEXT NOT NULL DEFAULT (datetime('now')),
        nudge_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, ticket_id)
      );
    `);
  }

  /**
   * Check if this agent+ticket is suppressed (nudged within the window).
   * Returns true if a nudge should be skipped.
   */
  isSuppressed(agentId: string, ticketId: string, windowMs: number): boolean {
    const row = this.db
      .prepare("SELECT last_nudge_at FROM nudge_log WHERE agent_id = ? AND ticket_id = ?")
      .get(agentId, ticketId) as { last_nudge_at: string } | undefined;

    if (!row) return false;

    const lastNudge = new Date(row.last_nudge_at).getTime();
    return Date.now() - lastNudge < windowMs;
  }

  /**
   * Record a nudge for this agent+ticket, updating the timestamp and count.
   */
  recordNudge(agentId: string, ticketId: string): void {
    this.db.prepare(`
      INSERT INTO nudge_log (agent_id, ticket_id, last_nudge_at, nudge_count)
        VALUES (?, ?, datetime('now'), 1)
      ON CONFLICT (agent_id, ticket_id) DO UPDATE SET
        last_nudge_at = datetime('now'),
        nudge_count = nudge_count + 1;
    `).run(agentId, ticketId);
  }

  /**
   * Reset suppression for an agent (e.g., after they pull their queue).
   */
  resetSuppression(agentId: string): void {
    this.db
      .prepare("DELETE FROM nudge_log WHERE agent_id = ?")
      .run(agentId);
  }

  close(): void {
    this.db.close();
  }
}
