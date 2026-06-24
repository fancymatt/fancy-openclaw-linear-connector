/**
 * SQLite-backed nudge suppression store.
 *
 * Tracks the last time each agent+ticket combination was sent a nudge.
 * Suppresses rapid-fire duplicate events on the SAME ticket, but always
 * allows different tickets through.
 */
export declare class NudgeStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /**
     * Check if this agent+ticket is suppressed (nudged within the window).
     * Returns true if a nudge should be skipped.
     */
    isSuppressed(agentId: string, ticketId: string, windowMs: number): boolean;
    /**
     * Get coalescing info for an agent+ticket pair.
     * Returns suppression status and the count of coalesced events since last delivery.
     */
    getCoalesceInfo(agentId: string, ticketId: string, windowMs: number): {
        suppressed: boolean;
        coalescedCount: number;
    };
    /**
     * Record a nudge for this agent+ticket, updating the timestamp and count.
     */
    recordNudge(agentId: string, ticketId: string): void;
    /**
     * Record a coalesced (suppressed) event — increments the coalesced counter
     * and tracks the latest event type/action for context.
     */
    recordCoalesced(agentId: string, ticketId: string, eventType?: string, eventAction?: string): void;
    /**
     * Get the coalesced count and reset it (called right before delivery).
     */
    drainCoalescedCount(agentId: string, ticketId: string): number;
    /**
     * Clear the dedup entry for a single agent+ticket pair.
     *
     * Called when a dispatch is aborted before any delivery is sent (e.g. the
     * routing-guard blocks it or the agent is unreachable). A blocked attempt
     * must not "reserve" the dedup window, otherwise the next genuine dispatch to
     * the same agent+ticket inside the window is wrongly swallowed (AI-1538).
     */
    clearNudge(agentId: string, ticketId: string): void;
    /**
     * Return ticket IDs that have coalesced (suppressed) events waiting for this
     * agent. Used by session-end to re-signal work that was swallowed inside the
     * dedup window when the previous session ended before the window expired.
     */
    getCoalescedTickets(agentId: string): string[];
    /**
     * Reset suppression for an agent (e.g., after they pull their queue).
     */
    resetSuppression(agentId: string): void;
    close(): void;
}
//# sourceMappingURL=nudge-store.d.ts.map