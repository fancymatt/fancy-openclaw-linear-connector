import Database from "better-sqlite3";
import path from "path";
/**
 * SQLite-backed per-agent serialized queue.
 *
 * Each agent gets at most one active task at a time. Additional tasks
 * are queued FIFO and promoted when the active task completes.
 */
export class AgentQueue {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "agent-queue.db");
        this.db = new Database(resolvedPath);
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
     * Enqueue or coalesce: if a queued task already exists for the same
     * agent+sessionKey (ticket), replace it with the newer payload instead
     * of stacking duplicates. Active tasks are never replaced.
     *
     * Returns 'deliver' if no active task (becomes active), 'queued' if
     * queued (new or replaced), 'coalesced' if an existing queued item was
     * replaced, or 'active-busy' if the active task is for the same ticket.
     */
    enqueueOrCoalesce(result) {
        const active = this.db
            .prepare("SELECT payload FROM agent_queue WHERE agent_id = ? AND status = 'active'")
            .get(result.agentId);
        // If active task exists for the SAME ticket, don't deliver or queue
        if (active) {
            const activePayload = JSON.parse(active.payload);
            if (activePayload.sessionKey === result.sessionKey) {
                return { action: "active-busy" };
            }
        }
        // Check for existing queued task with the same sessionKey (ticket)
        const existing = this.db
            .prepare("SELECT id FROM agent_queue WHERE agent_id = ? AND status = 'queued' AND json_extract(payload, '$.sessionKey') = ?")
            .get(result.agentId, result.sessionKey);
        if (existing) {
            // Replace the queued payload with the newer event (coalesce)
            this.db
                .prepare("UPDATE agent_queue SET payload = ?, updated_at = datetime('now') WHERE id = ?")
                .run(JSON.stringify(result), existing.id);
            return { action: "coalesced" };
        }
        // No existing queued item for this ticket — normal enqueue
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
    /**
     * Return distinct agent IDs that have any active or queued task.
     * Used by the startup drainer to recover backlog from prior process state.
     */
    agentsWithBacklog() {
        const rows = this.db
            .prepare("SELECT DISTINCT agent_id FROM agent_queue WHERE status IN ('active', 'queued')")
            .all();
        return rows.map((r) => r.agent_id);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=agent-queue.js.map