"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentQueue = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
/**
 * SQLite-backed per-agent serialized queue.
 *
 * Each agent gets at most one active task at a time. Additional tasks
 * are queued FIFO and promoted when the active task completes.
 */
class AgentQueue {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path_1.default.join(process.cwd(), "data", "agent-queue.db");
        this.db = new better_sqlite3_1.default(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_queue_agent_status
        ON agent_queue (agent_id, status);
    `);
    }
    /**
     * Enqueue a routed event for an agent. If the agent has no active task,
     * the task becomes active immediately and 'deliver' is returned.
     * Otherwise it is queued and 'queued' is returned.
     */
    enqueue(result) {
        const active = this.db
            .prepare("SELECT 1 FROM agent_queue WHERE agent_id = ? AND status = 'active'")
            .get(result.agentId);
        if (active) {
            this.db
                .prepare("INSERT INTO agent_queue (agent_id, payload, status) VALUES (?, ?, 'queued')")
                .run(result.agentId, JSON.stringify(result));
            return { action: "queued" };
        }
        this.db
            .prepare("INSERT INTO agent_queue (agent_id, payload, status) VALUES (?, ?, 'active')")
            .run(result.agentId, JSON.stringify(result));
        return { action: "deliver" };
    }
    /**
     * Mark the active task for an agent as completed. Promote the next
     * queued task (FIFO by created_at) to active and return it, or null
     * if the queue is empty.
     */
    complete(agentId) {
        this.db
            .prepare("UPDATE agent_queue SET status = 'completed', updated_at = datetime('now') WHERE agent_id = ? AND status = 'active'")
            .run(agentId);
        const next = this.db
            .prepare("SELECT id, payload FROM agent_queue WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1")
            .get(agentId);
        if (!next)
            return null;
        this.db
            .prepare("UPDATE agent_queue SET status = 'active', updated_at = datetime('now') WHERE id = ?")
            .run(next.id);
        return JSON.parse(next.payload);
    }
    /**
     * Return the currently active task for an agent, or null.
     */
    getActive(agentId) {
        const row = this.db
            .prepare("SELECT payload FROM agent_queue WHERE agent_id = ? AND status = 'active'")
            .get(agentId);
        return row ? JSON.parse(row.payload) : null;
    }
    /**
     * Return all queued (not active, not completed) tasks for an agent, FIFO order.
     */
    getQueued(agentId) {
        const rows = this.db
            .prepare("SELECT payload FROM agent_queue WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC, id ASC")
            .all(agentId);
        return rows.map((r) => JSON.parse(r.payload));
    }
    /**
     * Operational visibility: per-agent active status and queue depth.
     */
    getStats() {
        const rows = this.db
            .prepare(`SELECT agent_id,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
                SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queue_depth
         FROM agent_queue
         WHERE status IN ('active', 'queued')
         GROUP BY agent_id`)
            .all();
        return rows.map((r) => ({
            agentId: r.agent_id,
            active: r.active_count > 0,
            queueDepth: r.queue_depth,
        }));
    }
    close() {
        this.db.close();
    }
}
exports.AgentQueue = AgentQueue;
//# sourceMappingURL=agent-queue.js.map