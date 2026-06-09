/**
 * PendingWorkBag — per-agent deduped ticket bag for pull-based wake-up signals.
 *
 * Replaces the AgentQueue's per-event-push model. Webhook arrivals add entries
 * to the bag (deduped by ticket ID). A thin wake-up signal is emitted only
 * when the agent has no active session, collapsing bursts of 100 events into
 * 1 signal.
 *
 * Storage: separate SQLite file (data/pending-bag.db) — does not migrate
 * AgentQueue's agent_queue table, allowing v1.0 and v1.1 binaries to coexist.
 *
 * TTL: entries older than `ttlMs` (default 60 min, configurable via
 * BAG_ENTRY_TTL_MS env) are pruned on read and periodically.
 */
import Database from "better-sqlite3";
import path from "path";
import { createLogger, componentLogger } from "../logger.js";
import { normalizeSessionKey } from "../session-key.js";
const log = componentLogger(createLogger(), "bag");
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export class PendingWorkBag {
    constructor(dbPath, ttlMs) {
        this.metrics = {
            eventsReceived: 0,
            signalsSent: 0,
        };
        const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "pending-bag.db");
        this.ttlMs =
            ttlMs ?? parseInt(process.env.BAG_ENTRY_TTL_MS ?? `${DEFAULT_TTL_MS}`, 10);
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
        // Start periodic prune
        this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
        this.pruneTimer.unref();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_bag (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id       TEXT NOT NULL,
        ticket_id      TEXT NOT NULL,
        event_type     TEXT NOT NULL DEFAULT '',
        routing_reason TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_bag_agent_ticket
        ON pending_bag (agent_id, ticket_id);
      CREATE INDEX IF NOT EXISTS idx_pending_bag_agent
        ON pending_bag (agent_id);
    `);
        // Add routing_reason to pre-existing databases that lack it.
        const cols = this.db.prepare("PRAGMA table_info(pending_bag)").all();
        if (!cols.some((c) => c.name === "routing_reason")) {
            this.db.exec("ALTER TABLE pending_bag ADD COLUMN routing_reason TEXT");
        }
    }
    /**
     * Add a ticket to the bag (or update its timestamp if already present).
     * Returns true if this is a new entry, false if it was an update (coalesced).
     */
    add(agentId, ticketId, eventType, routingReason) {
        this.metrics.eventsReceived++;
        const normalizedTicketId = normalizeSessionKey(ticketId);
        try {
            // Check if the row already exists before UPSERT to detect coalescing.
            const existing = this.db
                .prepare("SELECT 1 FROM pending_bag WHERE agent_id = ? AND ticket_id = ?")
                .get(agentId, normalizedTicketId);
            this.db
                .prepare(`INSERT INTO pending_bag (agent_id, ticket_id, event_type, routing_reason, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(agent_id, ticket_id) DO UPDATE SET
             event_type = excluded.event_type,
             routing_reason = excluded.routing_reason,
             updated_at = datetime('now')`)
                .run(agentId, normalizedTicketId, eventType, routingReason ?? null);
            // Return true if it was a new entry, false if it was an update
            return !existing;
        }
        catch (err) {
            log.error(`Failed to add to bag: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    /**
     * Get all pending ticket IDs for an agent (after pruning expired entries).
     * Returns an empty array if the bag is empty.
     */
    getPendingTickets(agentId) {
        this.pruneAgent(agentId);
        const rows = this.db
            .prepare(`SELECT ticket_id, agent_id, event_type, routing_reason, created_at, updated_at
         FROM pending_bag
         WHERE agent_id = ?
         ORDER BY updated_at DESC`)
            .all(agentId);
        return rows.map((r) => ({
            ticketId: r.ticket_id,
            agentId: r.agent_id,
            eventType: r.event_type,
            routingReason: r.routing_reason ?? undefined,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }
    /**
     * Return the routing reason stored for a specific pending ticket, or undefined
     * if the ticket is not in the bag or was stored before routing reasons were tracked.
     */
    getTicketRoutingReason(agentId, ticketId) {
        const normalizedTicketId = normalizeSessionKey(ticketId);
        const row = this.db
            .prepare("SELECT routing_reason FROM pending_bag WHERE agent_id = ? AND ticket_id = ?")
            .get(agentId, normalizedTicketId);
        return row?.routing_reason ?? undefined;
    }
    /**
     * Clear all entries for an agent (called after agent picks up the bag).
     */
    clearAgent(agentId) {
        const result = this.db
            .prepare("DELETE FROM pending_bag WHERE agent_id = ?")
            .run(agentId);
        return result.changes;
    }
    /**
     * Remove a specific ticket from the bag (called after agent processes it).
     */
    removeTicket(agentId, ticketId) {
        const result = this.db
            .prepare("DELETE FROM pending_bag WHERE agent_id = ? AND ticket_id = ?")
            .run(agentId, normalizeSessionKey(ticketId));
        return result.changes > 0;
    }
    /**
     * Remove a ticket from every agent bag. Used when Linear tells us an issue is
     * terminal; stale pending delegations for completed/canceled work should not
     * wake anyone later.
     */
    removeTicketForAllAgents(ticketId) {
        const result = this.db
            .prepare("DELETE FROM pending_bag WHERE ticket_id = ?")
            .run(normalizeSessionKey(ticketId));
        return result.changes;
    }
    /**
     * Remove a ticket from every agent bag EXCEPT the specified agent. Used when
     * a ticket is re-delegated: the new delegate keeps their entry, all previous
     * holders are cleared so they don't receive spurious wake-up signals.
     */
    removeTicketForOtherAgents(agentId, ticketId) {
        const result = this.db
            .prepare("DELETE FROM pending_bag WHERE ticket_id = ? AND agent_id != ?")
            .run(normalizeSessionKey(ticketId), agentId);
        return result.changes;
    }
    /**
     * Check if any agent has pending work. Returns array of agent IDs.
     */
    agentsWithPendingWork() {
        this.prune();
        const rows = this.db
            .prepare("SELECT DISTINCT agent_id FROM pending_bag")
            .all();
        return rows.map((r) => r.agent_id);
    }
    /**
     * Track a signal sent to an agent.
     */
    recordSignal() {
        this.metrics.signalsSent++;
    }
    /** Get current metrics. */
    getStats() {
        const bagSize = this.db
            .prepare("SELECT COUNT(*) as cnt FROM pending_bag")
            .get();
        return {
            eventsReceived: this.metrics.eventsReceived,
            bagSize: bagSize.cnt,
            signalsSent: this.metrics.signalsSent,
        };
    }
    /** Get per-agent stats. */
    getAgentStats() {
        this.prune();
        const rows = this.db
            .prepare("SELECT agent_id, COUNT(*) as cnt FROM pending_bag GROUP BY agent_id")
            .all();
        return rows.map((r) => ({ agentId: r.agent_id, pendingCount: r.cnt }));
    }
    /** Prune expired entries for a specific agent. */
    pruneAgent(agentId) {
        const cutoff = this.ttlCutoff();
        this.db
            .prepare("DELETE FROM pending_bag WHERE agent_id = ? AND updated_at < ?")
            .run(agentId, cutoff);
    }
    /** Prune all expired entries. */
    prune() {
        const cutoff = this.ttlCutoff();
        const result = this.db
            .prepare("DELETE FROM pending_bag WHERE updated_at < ?")
            .run(cutoff);
        if (result.changes > 0) {
            log.info(`Pruned ${result.changes} expired bag entries (TTL=${this.ttlMs}ms)`);
        }
    }
    ttlCutoff() {
        // SQLite datetime: subtract ttlMs milliseconds
        const cutoff = new Date(Date.now() - this.ttlMs);
        return cutoff.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
    close() {
        if (this.pruneTimer)
            clearInterval(this.pruneTimer);
        this.db.close();
    }
}
//# sourceMappingURL=pending-work-bag.js.map