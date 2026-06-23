/**
 * DispatchAckTracker — per-ticket dispatch acknowledgment state for the watchdog.
 *
 * Tracks every successful wake-up dispatch (agent, ticket). The watchdog queries
 * this store to find dispatches that have not been acknowledged within a timeout
 * window, then re-signals or escalates them.
 *
 * Acknowledgment sources:
 *   - /session-end callback fires → agent ran, work was picked up
 *   - Watchdog auto-acknowledges a ticket that disappears from the pending bag
 *     (implies the agent pulled it via linear queue)
 *
 * Schema note: UNIQUE(agent_id, ticket_id) means repeated dispatches to the same
 * agent+ticket update last_signal_at and increment attempt_count rather than
 * creating a new row. This keeps the table small and preserves the original
 * dispatched_at for age calculations.
 */
export type AckStatus = "pending" | "acknowledged" | "unconfirmed" | "escalated" | "deferred";
export interface DispatchAckEntry {
    id: number;
    agentId: string;
    ticketId: string;
    dispatchedAt: string;
    lastSignalAt: string;
    ackStatus: AckStatus;
    attemptCount: number;
}
export declare class DispatchAckTracker {
    private db;
    private ttlMs;
    constructor(dbPath?: string, ttlMs?: number);
    private migrate;
    /**
     * Record a successful dispatch for a (agent, ticket) pair.
     *
     * If an entry already exists and is still pending/unconfirmed, updates
     * last_signal_at and increments attempt_count (idempotent re-signal tracking).
     * If it was previously acknowledged, resets to pending (re-delegation case).
     */
    recordDispatch(agentId: string, ticketId: string): void;
    /**
     * Register a pending dispatch expectation for a (agent, ticket) pair when the
     * connector commits to delivering to a newly-assigned delegate, BEFORE the
     * wake-up is actually sent.
     *
     * If a real dispatch follows, recordDispatch bumps this row (0 → 1) so the
     * happy-path attempt_count is unchanged. If the delivery is instead swallowed
     * (e.g. by nudge-dedup coalescing) or delivered through a path that records no
     * ack, this placeholder remains 'pending' and the watchdog re-signals it —
     * so a swallowed delivery self-heals instead of stalling indefinitely (AI-1538).
     *
     * Inserted with attempt_count=0 and ON CONFLICT DO NOTHING: it never bumps the
     * counter, never resets last_signal_at, and never resurrects an acknowledged
     * entry.
     */
    ensurePending(agentId: string, ticketId: string): void;
    /**
     * Acknowledge dispatches for an agent — called when /session-end fires.
     *
     * If ticketId is provided, acknowledges only that specific ticket.
     * If omitted, acknowledges all pending/unconfirmed tickets for the agent
     * (backward-compat path: session-end without per-ticket detail).
     *
     * Returns the number of rows updated.
     */
    acknowledge(agentId: string, ticketId?: string): number;
    /**
     * Return dispatches that are still pending/unconfirmed and whose last_signal_at
     * is older than timeoutMs milliseconds. The watchdog calls this each cycle.
     *
     * When timeoutMs <= 0, all pending/unconfirmed entries are returned immediately
     * (useful for testing and for a "check everything now" flush).
     */
    getPendingTimedOut(timeoutMs: number): DispatchAckEntry[];
    /**
     * Update a dispatch record after a watchdog re-signal attempt.
     * Sets status to 'unconfirmed', bumps attempt_count, resets last_signal_at.
     */
    markResignaled(agentId: string, ticketId: string): void;
    /**
     * Mark a dispatch as escalated — max re-signals exhausted, admin action required.
     */
    markEscalated(agentId: string, ticketId: string): void;
    /**
     * Mark a dispatch as deferred — agent is alive but at capacity.
     * Does NOT increment attempt_count; this is not a retry, just a hold.
     * The entry will be rescued when a session-end fires or by the stale-deferred sweep.
     */
    markDeferred(agentId: string, ticketId: string): void;
    /**
     * Return deferred entries whose last_signal_at is older than staleMs.
     * Used by the no-activity detector to rescue entries that were never
     * re-dispatched by a session-end signal.
     */
    getDeferredStale(staleMs: number): DispatchAckEntry[];
    /**
     * Return true if there is a pending/unconfirmed dispatch for (agentId, ticketId)
     * whose dispatched_at is within the last withinMs milliseconds.
     *
     * Used by StuckDelegateDetector (AI-1650) to guard against re-dispatching a
     * session that is still actively running after a connector restart. The in-memory
     * SessionTracker is reset on restart, so this persisted check is the only way to
     * know a session was recently dispatched and may still be in progress.
     */
    hasRecentPending(agentId: string, ticketId: string, withinMs: number): boolean;
    /**
     * Prune acknowledged and escalated records older than ttlMs.
     * Called automatically at the end of each watchdog cycle.
     */
    cleanup(): number;
    close(): void;
}
//# sourceMappingURL=dispatch-ack-tracker.d.ts.map