"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStore = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
/**
 * SQLite-backed operational event store for webhook deduplication and
 * restart safety.
 *
 * This is **operational state** — dedup bookkeeping, not business truth.
 * It can be safely deleted; the only consequence is that events already
 * processed may be re-processed once.
 */
class EventStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path_1.default.join(process.cwd(), "data", "events.db");
        // Ensure directory exists
        const dir = path_1.default.dirname(resolvedPath);
        const fs = require("fs");
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new better_sqlite3_1.default(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
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
    isDuplicate(eventId) {
        const row = this.db
            .prepare("SELECT 1 FROM events WHERE event_id = ?")
            .get(eventId);
        return row !== undefined;
    }
    /**
     * Records a processed event. Silently ignores duplicates (INSERT OR IGNORE).
     */
    recordEvent(eventId, payload) {
        this.db
            .prepare(`INSERT OR IGNORE INTO events (event_id, payload) VALUES (?, ?)`)
            .run(eventId, JSON.stringify(payload));
    }
    /**
     * Retrieves processing metadata for a given event.
     */
    getEvent(eventId) {
        const row = this.db
            .prepare("SELECT event_id, payload, status, created_at FROM events WHERE event_id = ?")
            .get(eventId);
        if (!row)
            return undefined;
        return {
            eventId: row.event_id,
            payload: JSON.parse(row.payload),
            status: row.status,
            createdAt: row.created_at,
        };
    }
    close() {
        this.db.close();
    }
}
exports.EventStore = EventStore;
//# sourceMappingURL=event-store.js.map