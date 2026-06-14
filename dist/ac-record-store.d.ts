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
/**
 * Capture the verbatim AC for a ticket at accept time.
 * Overwrites any existing record (re-accept from intake).
 * Persists to disk after capture.
 */
export declare function captureAc(ticketId: string, record: AcRecord): Promise<void>;
/**
 * Retrieve the verbatim AC record for a ticket.
 * Returns null if no AC has been captured (ad-hoc or pre-H-7 tickets).
 */
export declare function getAcRecord(ticketId: string): Promise<AcRecord | null>;
/**
 * Check whether a ticket has a captured verbatim AC record.
 */
export declare function hasAcRecord(ticketId: string): Promise<boolean>;
/**
 * Remove the AC record for a ticket (cleanup on escape/demote).
 * Returns true if a record was removed, false if none existed.
 * Persists to disk after removal.
 */
export declare function removeAcRecord(ticketId: string): Promise<boolean>;
/** Clear all AC records. Used in tests. */
export declare function clearAcRecordStore(): void;
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
export declare function extractAcFromDescription(description: string): string | null;
//# sourceMappingURL=ac-record-store.d.ts.map