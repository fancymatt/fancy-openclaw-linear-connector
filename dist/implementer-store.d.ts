/**
 * AI-1493: Implementer tracking store.
 *
 * Records the implementer body when a ticket enters or leaves the
 * `implementation` state. Used by `reject` (deployment → implementation)
 * to deterministically route the delegate back to the prior implementer
 * without requiring human choice.
 *
 * Storage is persisted to a JSON file (IMPLEMENTER_STORE_PATH env or
 * /tmp/implementer-store.json by default). On startup, existing records
 * are loaded from disk. The store is keyed by Linear issue UUID.
 *
 * Fail-open: if the store is unavailable, reject falls back to requiring
 * an explicit --target (same as submit), which is safe but not automatic.
 */
/**
 * Record the implementer for a given ticket.
 * Persists to disk after recording.
 */
export declare function recordImplementer(issueId: string, bodyId: string, workflowId: string): Promise<void>;
/**
 * Get the recorded implementer for a given ticket.
 * Returns the body ID string, or null if not found.
 */
export declare function getImplementer(issueId: string): Promise<string | null>;
/**
 * Remove the implementer record for a given ticket (cleanup on escape/demote).
 * Persists to disk after removal.
 */
export declare function removeImplementer(issueId: string): Promise<void>;
/**
 * Clear all records (for testing).
 */
export declare function clearImplementerStore(): void;
//# sourceMappingURL=implementer-store.d.ts.map