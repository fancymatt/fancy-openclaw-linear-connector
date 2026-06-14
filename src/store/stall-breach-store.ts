import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite-backed dedup store for stall breach signals (AC3, G-12).
 *
 * Tracks (childId, stateEnteredAt) pairs that have already been signaled to
 * the steward, so a recurring cron tick does not flood on the same breach.
 * A new stall after recovery is a different stateEnteredAt epoch → new breach.
 */
export class StallBreachStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "stall-breaches.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stall_breaches (
        child_id TEXT NOT NULL,
        state_entered_at INTEGER NOT NULL,
        signaled_at INTEGER NOT NULL,
        PRIMARY KEY (child_id, state_entered_at)
      )
    `);
  }

  isAlreadySignaled(childId: string, stateEnteredAt: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM stall_breaches WHERE child_id = ? AND state_entered_at = ?")
      .get(childId, stateEnteredAt);
    return row !== undefined;
  }

  recordSignal(childId: string, stateEnteredAt: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO stall_breaches (child_id, state_entered_at, signaled_at) VALUES (?, ?, ?)",
      )
      .run(childId, stateEnteredAt, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
