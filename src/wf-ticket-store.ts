/**
 * AI-1488: Workflow-ticket store.
 *
 * Tracks which Linear issue UUIDs are governed workflow tickets.
 * This store is authoritative — the source of truth is the store,
 * not the wf:* labels on the ticket. If a label is stripped (e.g.
 * via `unlabel wf:dev-impl`), the store still flags the ticket as
 * governed and enforcement continues.
 *
 * Storage is persisted to a JSON file (WF_TICKET_STORE_PATH env or
 * /tmp/wf-ticket-store.json by default). On startup, existing records
 * are loaded from disk. The store is keyed by Linear issue UUID.
 *
 * Fail-open: if the store is unavailable, callers fall back to label-
 * based detection (same behavior as before AI-1488, safe posture).
 */

import fs from "node:fs/promises";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "wf-ticket-store");

/** Default path for persisted wf-ticket records. Override via WF_TICKET_STORE_PATH env. */
const DEFAULT_WF_TICKET_STORE_PATH = "/tmp/wf-ticket-store.json";

function wfTicketStorePath(): string {
  return process.env.WF_TICKET_STORE_PATH ?? DEFAULT_WF_TICKET_STORE_PATH;
}

interface WfTicketRecord {
  workflowId: string;
  enrolledAt: string;
}

/** In-memory store: Linear issue UUID → WfTicketRecord. */
const _store = new Map<string, WfTicketRecord>();

/** Whether the initial load from disk has been attempted. */
let _loaded = false;

/**
 * Load persisted wf-ticket records from disk. Idempotent — only loads once.
 * Fail-open: if the file doesn't exist or is corrupt, we start with an empty store
 * and log a warning.
 */
async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(wfTicketStorePath(), "utf8");
    const data = JSON.parse(raw) as Record<string, WfTicketRecord>;
    for (const [key, record] of Object.entries(data)) {
      _store.set(key, record);
    }
    log.info(`wf-ticket-store: loaded ${_store.size} record(s) from ${wfTicketStorePath()}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`wf-ticket-store: no persisted records file at ${wfTicketStorePath()} — starting fresh`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`wf-ticket-store: failed to load persisted records from ${wfTicketStorePath()}: ${msg}`);
    }
  }
}

/**
 * Persist the current store to disk. Fail-open: logs errors but never throws.
 */
async function persist(): Promise<void> {
  try {
    const data: Record<string, WfTicketRecord> = {};
    for (const [key, record] of _store) {
      data[key] = record;
    }
    await fs.writeFile(wfTicketStorePath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`wf-ticket-store: failed to persist records to ${wfTicketStorePath()}: ${msg}`);
  }
}

/**
 * Record a ticket as a governed workflow ticket.
 * Persists to disk after recording.
 */
export async function recordWfTicket(issueId: string, workflowId: string): Promise<void> {
  await ensureLoaded();
  _store.set(issueId, { workflowId, enrolledAt: new Date().toISOString() });
  log.info(`wf-ticket-store: recorded ${issueId} as wf:${workflowId} ticket`);
  await persist();
}

/**
 * Check whether a ticket is a governed workflow ticket.
 * Returns true if found in the store.
 */
export async function isWfTicket(issueId: string): Promise<boolean> {
  await ensureLoaded();
  return _store.has(issueId);
}

/**
 * Remove the wf-ticket record for a given ticket (cleanup on escape/demote/terminal).
 * Persists to disk after removal.
 */
export async function removeWfTicket(issueId: string): Promise<void> {
  await ensureLoaded();
  if (_store.has(issueId)) {
    _store.delete(issueId);
    log.info(`wf-ticket-store: removed record for ${issueId}`);
    await persist();
  }
}

/**
 * Clear all records (for testing).
 */
export function clearWfTicketStore(): void {
  _store.clear();
  _loaded = false;
}
