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
export interface BagEntry {
    ticketId: string;
    agentId: string;
    eventType: string;
    routingReason?: string;
    createdAt: string;
    updatedAt: string;
}
export interface BagStats {
    eventsReceived: number;
    bagSize: number;
    signalsSent: number;
}
export declare class PendingWorkBag {
    private db;
    private ttlMs;
    private metrics;
    private pruneTimer?;
    constructor(dbPath?: string, ttlMs?: number);
    private migrate;
    /**
     * Add a ticket to the bag (or update its timestamp if already present).
     * Returns true if this is a new entry, false if it was an update (coalesced).
     */
    add(agentId: string, ticketId: string, eventType: string, routingReason?: string): boolean;
    /**
     * Get all pending ticket IDs for an agent (after pruning expired entries).
     * Returns an empty array if the bag is empty.
     */
    getPendingTickets(agentId: string): BagEntry[];
    /**
     * Return the routing reason stored for a specific pending ticket, or undefined
     * if the ticket is not in the bag or was stored before routing reasons were tracked.
     */
    getTicketRoutingReason(agentId: string, ticketId: string): string | undefined;
    /**
     * Clear all entries for an agent (called after agent picks up the bag).
     */
    clearAgent(agentId: string): number;
    /**
     * Remove a specific ticket from the bag (called after agent processes it).
     */
    removeTicket(agentId: string, ticketId: string): boolean;
    /**
     * Remove a ticket from every agent bag. Used when Linear tells us an issue is
     * terminal; stale pending delegations for completed/canceled work should not
     * wake anyone later.
     */
    removeTicketForAllAgents(ticketId: string): number;
    /**
     * Remove a ticket from every agent bag EXCEPT the specified agent. Used when
     * a ticket is re-delegated: the new delegate keeps their entry, all previous
     * holders are cleared so they don't receive spurious wake-up signals.
     */
    removeTicketForOtherAgents(agentId: string, ticketId: string): number;
    /**
     * Check if any agent has pending work. Returns array of agent IDs.
     */
    agentsWithPendingWork(): string[];
    /**
     * Track a signal sent to an agent.
     */
    recordSignal(): void;
    /** Get current metrics. */
    getStats(): BagStats;
    /** Get per-agent stats. */
    getAgentStats(): {
        agentId: string;
        pendingCount: number;
    }[];
    /** Prune expired entries for a specific agent. */
    private pruneAgent;
    /** Prune all expired entries. */
    private prune;
    private ttlCutoff;
    close(): void;
}
//# sourceMappingURL=pending-work-bag.d.ts.map