/**
 * Phase 6.5 / H-8 — Sprint oscillation cycle counter (§14b).
 *
 * For Archetype-C (sprint) workflows, the `validating → spawning` rework loop
 * carries a cycle counter that increments each time validation kicks work back
 * for another spawn round. It does not block the loop (genuine multi-round
 * sprints exist) — it is a metric; a high count flags a sprint that keeps
 * failing its own integrated AC.
 *
 * Storage is persisted to a JSON file (CYCLE_COUNTER_PATH env or
 * /tmp/cycle-counter.json by default). On startup, existing records are
 * loaded from disk. The store is keyed by ticket identifier (e.g. "AI-1483").
 *
 * Design: design.md §14b.
 */
/** A cycle counter record for a single sprint ticket. */
export interface CycleCounterRecord {
    /** Current oscillation cycle count. */
    cycles: number;
    /** ISO timestamp of the first cycle (initial spawn). */
    firstCycleAt: string;
    /** ISO timestamp of the most recent cycle increment. */
    lastCycleAt: string;
    /** The workflow ID (should be "sprint"). */
    workflowId: string;
}
/**
 * §14b: Increment the oscillation cycle counter for a sprint ticket.
 *
 * Called when the sprint workflow transitions from `validating` back to
 * `spawning` (a rework cycle). The first spawn sets the counter to 1;
 * each subsequent re-spawn increments it.
 *
 * Returns the new cycle count.
 */
export declare function incrementCycle(ticketId: string, workflowId: string): Promise<number>;
/**
 * Get the current cycle count for a sprint ticket.
 * Returns 0 if no record exists (ticket has not entered the spawning loop).
 */
export declare function getCycleCount(ticketId: string): Promise<number>;
/**
 * Get the full cycle counter record for a sprint ticket.
 * Returns null if no record exists.
 */
export declare function getCycleRecord(ticketId: string): Promise<CycleCounterRecord | null>;
/**
 * Remove the cycle counter record for a ticket (cleanup on terminal state / escape).
 * Returns true if a record was removed, false if none existed.
 * Persists to disk after removal.
 */
export declare function removeCycleRecord(ticketId: string): Promise<boolean>;
/**
 * Clear all records (for testing).
 */
export declare function clearCycleCounterStore(): void;
//# sourceMappingURL=cycle-counter.d.ts.map