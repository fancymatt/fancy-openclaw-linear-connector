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
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "nudges.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        // Drop old agent-only table if it exists and recreate with composite key
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS nudge_log (
        agent_id          TEXT NOT NULL,
        ticket_id         TEXT NOT NULL,
        last_nudge_at     TEXT NOT NULL DEFAULT (datetime('now')),
        nudge_count       INTEGER NOT NULL DEFAULT 0,
        coalesced_count   INTEGER NOT NULL DEFAULT 0,
        last_event_type   TEXT,
        last_event_action TEXT,
        PRIMARY KEY (agent_id, ticket_id)
      );
    `);
        // Migrate legacy schema — add coalescing columns if missing
        try {
            this.db.exec(`ALTER TABLE nudge_log ADD COLUMN coalesced_count INTEGER NOT NULL DEFAULT 0`);
        }
        catch { /* column already exists */ }
        try {
            this.db.exec(`ALTER TABLE nudge_log ADD COLUMN last_event_type TEXT`);
        }
        catch { /* column already exists */ }
        try {
            this.db.exec(`ALTER TABLE nudge_log ADD COLUMN last_event_action TEXT`);
        }
        catch { /* column already exists */ }
    }
    /**
     * Check if this agent+ticket is suppressed (nudged within the window).
     * Returns true if a nudge should be skipped.
     */
    isSuppressed(agentId, ticketId, windowMs) {
        return this.getCoalesceInfo(agentId, ticketId, windowMs).suppressed;
    }
    /**
     * Get coalescing info for an agent+ticket pair.
     * Returns suppression status and the count of coalesced events since last delivery.
     */
    getCoalesceInfo(agentId, ticketId, windowMs) {
        const row = this.db
            .prepare("SELECT last_nudge_at, coalesced_count FROM nudge_log WHERE agent_id = ? AND ticket_id = ?")
            .get(agentId, ticketId);
        if (!row)
            return { suppressed: false, coalescedCount: 0 };
        const lastNudge = new Date(row.last_nudge_at + "Z").getTime(); // Force UTC — SQLite datetime('now') is UTC but JS parses space-separated strings as local
        const isSuppressed = Date.now() - lastNudge < windowMs;
        return { suppressed: isSuppressed, coalescedCount: isSuppressed ? row.coalesced_count : 0 };
    }
    /**
     * Record a nudge for this agent+ticket, updating the timestamp and count.
     */
    recordNudge(agentId, ticketId) {
        this.db.prepare(`
      INSERT INTO nudge_log (agent_id, ticket_id, last_nudge_at, nudge_count, coalesced_count, last_event_type, last_event_action)
        VALUES (?, ?, datetime('now'), 1, 0, NULL, NULL)
      ON CONFLICT (agent_id, ticket_id) DO UPDATE SET
        last_nudge_at = datetime('now'),
        nudge_count = nudge_count + 1,
        coalesced_count = 0;
    `).run(agentId, ticketId);
    }
    /**
     * Record a coalesced (suppressed) event — increments the coalesced counter
     * and tracks the latest event type/action for context.
     */
    recordCoalesced(agentId, ticketId, eventType, eventAction) {
        this.db.prepare(`
      INSERT INTO nudge_log (agent_id, ticket_id, last_nudge_at, nudge_count, coalesced_count, last_event_type, last_event_action)
        VALUES (?, ?, datetime('now'), 0, 1, NULL, NULL)
      ON CONFLICT (agent_id, ticket_id) DO UPDATE SET
        coalesced_count = coalesced_count + 1,
        last_event_type = CASE WHEN excluded.last_event_type IS NOT NULL THEN excluded.last_event_type ELSE nudge_log.last_event_type END,
        last_event_action = CASE WHEN excluded.last_event_action IS NOT NULL THEN excluded.last_event_action ELSE nudge_log.last_event_action END;
    `).run(agentId, ticketId);
    }
    /**
     * Get the coalesced count and reset it (called right before delivery).
     */
    drainCoalescedCount(agentId, ticketId) {
        const row = this.db
            .prepare("SELECT coalesced_count FROM nudge_log WHERE agent_id = ? AND ticket_id = ?")
            .get(agentId, ticketId);
        if (!row || row.coalesced_count === 0)
            return 0;
        const count = row.coalesced_count;
        this.db.prepare("UPDATE nudge_log SET coalesced_count = 0 WHERE agent_id = ? AND ticket_id = ?")
            .run(agentId, ticketId);
        return count;
    }
    /**
     * Reset suppression for an agent (e.g., after they pull their queue).
     */
    resetSuppression(agentId) {
        this.db
            .prepare("DELETE FROM nudge_log WHERE agent_id = ?")
            .run(agentId);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=nudge-store.js.map