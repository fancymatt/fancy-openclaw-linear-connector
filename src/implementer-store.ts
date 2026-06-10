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

import fs from "node:fs/promises";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "implementer-store");

/** Default path for persisted implementer records. Override via IMPLEMENTER_STORE_PATH env. */
const DEFAULT_IMPLEMENTER_STORE_PATH = "/tmp/implementer-store.json";

function implementerStorePath(): string {
  return process.env.IMPLEMENTER_STORE_PATH ?? DEFAULT_IMPLEMENTER_STORE_PATH;
}

interface ImplementerRecord {
  bodyId: string;
  workflowId: string;
  recordedAt: string;
}

/** In-memory store: Linear issue UUID → ImplementerRecord. */
const _store = new Map<string, ImplementerRecord>();

/** Whether the initial load from disk has been attempted. */
let _loaded = false;

/**
 * Load persisted implementer records from disk. Idempotent — only loads once.
 * Fail-open: if the file doesn't exist or is corrupt, we start with an empty store
 * and log a warning.
 */
async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(implementerStorePath(), "utf8");
    const data = JSON.parse(raw) as Record<string, ImplementerRecord>;
    for (const [key, record] of Object.entries(data)) {
      _store.set(key, record);
    }
    log.info(`implementer-store: loaded ${_store.size} record(s) from ${implementerStorePath()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`implementer-store: no persisted records file at ${implementerStorePath()} — starting fresh`);
    } else {
      log.warn(`implementer-store: failed to load persisted records from ${implementerStorePath()}: ${msg}`);
    }
  }
}

/**
 * Persist the current store to disk. Fail-open: logs errors but never throws.
 */
async function persist(): Promise<void> {
  try {
    const data: Record<string, ImplementerRecord> = {};
    for (const [key, record] of _store) {
      data[key] = record;
    }
    await fs.writeFile(implementerStorePath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`implementer-store: failed to persist records to ${implementerStorePath()}: ${msg}`);
  }
}

/**
 * Record the implementer for a given ticket.
 * Persists to disk after recording.
 */
export async function recordImplementer(issueId: string, bodyId: string, workflowId: string): Promise<void> {
  await ensureLoaded();
  _store.set(issueId, { bodyId, workflowId, recordedAt: new Date().toISOString() });
  log.info(`implementer-store: recorded '${bodyId}' for ${issueId} (workflow: ${workflowId})`);
  await persist();
}

/**
 * Get the recorded implementer for a given ticket.
 * Returns the body ID string, or null if not found.
 */
export async function getImplementer(issueId: string): Promise<string | null> {
  await ensureLoaded();
  const record = _store.get(issueId);
  return record?.bodyId ?? null;
}

/**
 * Remove the implementer record for a given ticket (cleanup on escape/demote).
 * Persists to disk after removal.
 */
export async function removeImplementer(issueId: string): Promise<void> {
  await ensureLoaded();
  if (_store.has(issueId)) {
    _store.delete(issueId);
    log.info(`implementer-store: removed record for ${issueId}`);
    await persist();
  }
}

/**
 * Clear all records (for testing).
 */
export function clearImplementerStore(): void {
  _store.clear();
  _loaded = false;
}
