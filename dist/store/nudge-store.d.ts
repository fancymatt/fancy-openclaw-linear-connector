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
     * Reset suppression for an agent (e.g., after they pull their queue).
     */
    resetSuppression(agentId: string): void;
    close(): void;
}
//# sourceMappingURL=nudge-store.d.ts.map