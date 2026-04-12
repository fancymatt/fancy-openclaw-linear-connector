/**
 * SQLite-backed operational event store for webhook deduplication and
 * restart safety.
 *
 * This is **operational state** — dedup bookkeeping, not business truth.
 * It can be safely deleted; the only consequence is that events already
 * processed may be re-processed once.
 */
export declare class EventStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /**
     * Returns `true` if the event ID has already been recorded.
     */
    isDuplicate(eventId: string): boolean;
    /**
     * Records a processed event. Silently ignores duplicates (INSERT OR IGNORE).
     */
    recordEvent(eventId: string, payload: object): void;
    /**
     * Retrieves processing metadata for a given event.
     */
    getEvent(eventId: string): {
        eventId: string;
        payload: object;
        status: string;
        createdAt: string;
    } | undefined;
    close(): void;
}
//# sourceMappingURL=event-store.d.ts.map