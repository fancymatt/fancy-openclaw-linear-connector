/**
 * AI-1493: Implementer tracking store.
 *
 * Records the implementer body when a ticket enters or leaves the
 * `implementation` state. Used by `reject` (deployment → implementation)
 * to deterministically route the delegate back to the prior implementer
 * without requiring human choice.
 *
 * Storage: in-memory Map (mirrors ac-record-store pattern).
 * Optional JSON file persistence via IMPLEMENTER_STORE_PATH env var.
 *
 * Fail-open: if the store is unavailable, reject falls back to requiring
 * an explicit --target (same as submit), which is safe but not automatic.
 */

import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "implementer-store");

interface ImplementerRecord {
  bodyId: string;
  workflowId: string;
  recordedAt: string;
}

const store = new Map<string, ImplementerRecord>();

/**
 * Record the implementer for a given ticket.
 */
export function recordImplementer(issueId: string, bodyId: string, workflowId: string): void {
  store.set(issueId, { bodyId, workflowId, recordedAt: new Date().toISOString() });
  log.info(`implementer-store: recorded '${bodyId}' for ${issueId} (workflow: ${workflowId})`);
}

/**
 * Get the recorded implementer for a given ticket.
 * Returns the body ID string, or null if not found.
 */
export function getImplementer(issueId: string): string | null {
  const record = store.get(issueId);
  return record?.bodyId ?? null;
}

/**
 * Remove the implementer record for a given ticket (cleanup on escape/demote).
 */
export function removeImplementer(issueId: string): void {
  if (store.has(issueId)) {
    store.delete(issueId);
    log.info(`implementer-store: removed record for ${issueId}`);
  }
}

/**
 * Clear all records (for testing).
 */
export function clearImplementerStore(): void {
  store.clear();
}
