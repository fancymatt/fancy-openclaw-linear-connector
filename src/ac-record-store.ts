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
import { resolveBodiesForRole } from "./escalation-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "ac-record-store");

/** Default path for persisted AC records. Override via AC_RECORDS_PATH env. */
const DEFAULT_AC_RECORDS_PATH = "data/ac-records.json";

/** Linear GraphQL API endpoint (used by recaptureAc to fetch description / post comments). */
const LINEAR_API_URL = "https://api.linear.app/graphql";

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

  // Try to find an "### Acceptance" or "### AC" or "## Acceptance" section.
  // AI-1776 AC1: tolerate trailing decoration on the header line (e.g.
  // "## Acceptance criteria (draft — final at intake)", "### AC — final").
  // The word-boundary anchor (`\b`) after the keyword prevents matching
  // unrelated words while allowing trailing qualifier text.
  const acPatterns = [
    /^#{1,3}\s*(?:Acceptance(?:\s+Criteria)?|AC)\b.*$/mi,
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

/**
 * AI-1776 AC3: Steward-gated recapture of the AC of record.
 *
 * Allows a steward to (re)capture the verbatim AC from the ticket's current
 * description after the accept transition — for tickets that entered the spine
 * without a snapshot (e.g. capture failed at accept, or the description was
 * finalized after accept).
 *
 * Authorization: the caller must be a body that fills the `steward` role
 * (resolved via the capability policy). Non-steward callers are rejected.
 *
 * Overwrite semantics: if a record already exists, `force: true` is required.
 * A forced overwrite posts a Linear comment trail naming the steward and the
 * action, so the audit path is preserved. Fresh creates post no comment.
 *
 * @param ticketId      Linear ticket identifier (e.g. "AI-1776")
 * @param authToken     Linear auth token (Bearer ...) for API calls
 * @param callerBodyId  The body ID of the caller (must be a steward)
 * @param opts.force    When true, allows overwriting an existing record
 */
export async function recaptureAc(
  ticketId: string,
  authToken: string,
  callerBodyId: string,
  opts?: { force?: boolean },
): Promise<void> {
  // ── Authorization: steward-only ──────────────────────────────────────────
  const stewardBodies = await resolveBodiesForRole("steward");
  if (!stewardBodies.includes(callerBodyId)) {
    throw new Error(
      `recaptureAc: caller '${callerBodyId}' is not authorized — only steward bodies can recapture the AC of record`,
    );
  }

  const force = opts?.force === true;

  // ── Overwrite guard ────────────────────────────────────────────────────────
  const existing = await getAcRecord(ticketId);
  if (existing && !force) {
    throw new Error(
      `recaptureAc: an AC record already exists for ${ticketId} (captured by ${existing.capturedBy}). Use { force: true } to overwrite.`,
    );
  }

  // ── Fetch description ─────────────────────────────────────────────────────
  const descriptionQuery = `query IssueDescription($id: String!) { issue(id: $id) { description } }`;
  let description: string;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: descriptionQuery, variables: { id: ticketId } }),
    });
    type DescResp = { data?: { issue?: { description?: string | null } } };
    const data = (await res.json()) as DescResp;
    const desc = data.data?.issue?.description;
    if (desc === undefined || desc === null) {
      throw new Error("description fetch returned no description");
    }
    description = desc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`recaptureAc: could not fetch description for ${ticketId}: ${msg}`);
  }

  // ── Extract AC ─────────────────────────────────────────────────────────────
  const verbatimAc = extractAcFromDescription(description);
  if (!verbatimAc) {
    throw new Error(
      `recaptureAc: no acceptance criteria header found in the description for ${ticketId} — cannot create AC record`,
    );
  }

  // ── Store (capture) ─────────────────────────────────────────────────────────
  const capturedAt = new Date().toISOString();
  await captureAc(ticketId, {
    verbatimAc,
    capturedAt,
    capturedBy: callerBodyId,
    source: "description",
  });
  log.info(`recaptureAc: captured AC for ${ticketId} (by ${callerBodyId}, force=${force}, ${verbatimAc.length} chars)`);

  // ── Comment trail on forced overwrite ───────────────────────────────────────
  if (existing && force) {
    const commentMutation = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
      }
    `;
    const commentBody =
      `[AC Recapture] AC of record force-overwritten by steward **${callerBodyId}** at ${capturedAt}. ` +
      `The previous record (captured by ${existing.capturedBy}) has been replaced with the current description's acceptance criteria.`;
    try {
      await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authToken },
        body: JSON.stringify({
          query: commentMutation,
          variables: { issueId: ticketId, body: commentBody },
        }),
      });
      log.info(`recaptureAc: posted force-overwrite comment trail for ${ticketId}`);
    } catch (err) {
      log.warn(`recaptureAc: failed to post force-overwrite comment for ${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
