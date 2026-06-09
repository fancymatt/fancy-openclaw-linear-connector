/**
 * Phase 6.5 / H-7 — Verbatim AC record store (AI-1482).
 *
 * Connector-side immutable record of the verbatim acceptance criteria
 * captured at intake time. When a Matt-via-Ai task is accepted, the
 * ticket's AC (from the description) are captured verbatim as the AC
 * of record — not Ai's restatement. Ai may annotate alongside, but
 * sign-off is judged against the verbatim original.
 *
 * Storage is persisted to a JSON file (AC_RECORDS_PATH env or
 * /tmp/ac-records.json by default). On startup, existing records are
 * loaded from disk. The store is keyed by ticket identifier (e.g. "AI-1482").
 *
 * Design: design.md §13b (Phase 6.5 hardening).
 */

import fs from "node:fs/promises";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "ac-record-store");

/** Default path for persisted AC records. Override via AC_RECORDS_PATH env. */
const DEFAULT_AC_RECORDS_PATH = "/tmp/ac-records.json";

function acRecordsPath(): string {
  return process.env.AC_RECORDS_PATH ?? DEFAULT_AC_RECORDS_PATH;
}

/** A verbatim AC record captured at intake. */
export interface AcRecord {
  /** The verbatim AC text from Matt (extracted from the issue description at accept time). */
  verbatimAc: string;
  /** ISO timestamp when the AC was captured. */
  capturedAt: string;
  /** The agent/body that captured (accepted) the AC. */
  capturedBy: string;
  /** The source field — indicates where the AC was extracted from (e.g. "description"). */
  source: string;
}

/** In-memory store: ticket identifier → AcRecord. */
const _store = new Map<string, AcRecord>();

/** Whether the initial load from disk has been attempted. */
let _loaded = false;

/**
 * Load persisted AC records from disk. Idempotent — only loads once.
 * Fail-open: if the file doesn't exist or is corrupt, we start with an empty store
 * and log a warning.
 */
async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(acRecordsPath(), "utf8");
    const data = JSON.parse(raw) as Record<string, AcRecord>;
    for (const [key, record] of Object.entries(data)) {
      _store.set(key, record);
    }
    log.info(`ac-record-store: loaded ${_store.size} record(s) from ${acRecordsPath()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`ac-record-store: no persisted records file at ${acRecordsPath()} — starting fresh`);
    } else {
      log.warn(`ac-record-store: failed to load persisted records from ${acRecordsPath()}: ${msg}`);
    }
  }
}

/**
 * Persist the current store to disk. Fail-open: logs errors but never throws.
 */
async function persist(): Promise<void> {
  try {
    const data: Record<string, AcRecord> = {};
    for (const [key, record] of _store) {
      data[key] = record;
    }
    await fs.writeFile(acRecordsPath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`ac-record-store: failed to persist records to ${acRecordsPath()}: ${msg}`);
  }
}

/**
 * Capture the verbatim AC for a ticket at accept time.
 * Overwrites any existing record (re-accept from intake).
 * Persists to disk after capture.
 */
export async function captureAc(ticketId: string, record: AcRecord): Promise<void> {
  await ensureLoaded();
  _store.set(ticketId, record);
  log.info(`ac-record-store: captured verbatim AC for ${ticketId} (by ${record.capturedBy}, ${record.verbatimAc.length} chars)`);
  await persist();
}

/**
 * Retrieve the verbatim AC record for a ticket.
 * Returns null if no AC has been captured (ad-hoc or pre-H-7 tickets).
 */
export async function getAcRecord(ticketId: string): Promise<AcRecord | null> {
  await ensureLoaded();
  return _store.get(ticketId) ?? null;
}

/**
 * Check whether a ticket has a captured verbatim AC record.
 */
export async function hasAcRecord(ticketId: string): Promise<boolean> {
  await ensureLoaded();
  return _store.has(ticketId);
}

/**
 * Remove the AC record for a ticket (cleanup on escape/demote).
 * Returns true if a record was removed, false if none existed.
 * Persists to disk after removal.
 */
export async function removeAcRecord(ticketId: string): Promise<boolean> {
  await ensureLoaded();
  const had = _store.delete(ticketId);
  if (had) {
    log.info(`ac-record-store: removed AC record for ${ticketId}`);
    await persist();
  }
  return had;
}

/** Clear all AC records. Used in tests. */
export function clearAcRecordStore(): void {
  _store.clear();
  _loaded = false;
}

/**
 * Extract acceptance criteria from an issue description.
 * Looks for "### Acceptance" or "## Acceptance" or "### AC" headers
 * and returns the text under that section.
 *
 * Returns null when no AC section header is found — a ticket without
 * an explicit Acceptance section should NOT have its full description
 * treated as the AC of record (the description includes scope, routing,
 * and context that are NOT acceptance criteria).
 */
export function extractAcFromDescription(description: string): string | null {
  if (!description) return null;

  // Try to find an "### Acceptance" or "### AC" or "## Acceptance" section
  const acPatterns = [
    /^#{1,3}\s*(?:Acceptance(?:\s+Criteria)?|AC)\s*$/mi,
  ];

  for (const pattern of acPatterns) {
    const match = pattern.exec(description);
    if (match) {
      const startIdx = match.index + match[0].length;
      // Extract until the next ## heading or end of string
      const remaining = description.slice(startIdx);
      const nextHeading = /^#{1,3}\s/m.exec(remaining);
      if (nextHeading) {
        return remaining.slice(0, nextHeading.index).trim();
      }
      return remaining.trim();
    }
  }

  // No AC section header found — return null rather than the full description.
  log.warn(`ac-record-store: extractAcFromDescription: no '### Acceptance' or '### AC' header found in description — returning null (full description will NOT be treated as AC of record)`);
  return null;
}
