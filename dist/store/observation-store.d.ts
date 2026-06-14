/**
 * Phase 4 / P4-1 — Append-only observation store for categorized reject feedback.
 *
 * Design: design.md §8 (learning loop), §9 (Observations tier), §10 (micro layer).
 *
 * Every `request-changes` and `reject` transition that carries a validated
 * `category_enum` value writes exactly one observation row. The store is
 * append-only — rows are never updated or deleted. Cheap, auditable,
 * machine-aggregatable.
 *
 * The store lives connector-side (§4.2 / §12 resolved), not in Linear labels.
 * Ad-hoc tickets (no wf:* label) produce no observations.
 */
/** The validated reason codes from the workflow definition.
 *
 *  §16.1: 'other' is the catch-all category — it REQUIRES accompanying free_text
 *  so the periodic mining pass (§8.2) can surface recurring reasons that warrant
 *  promotion to a first-class category.
 */
export declare const REASON_CODES: readonly ["missing-tests", "style", "scope-creep", "correctness", "ac-mismatch", "other"];
export type ReasonCode = (typeof REASON_CODES)[number];
/** Input for a new observation row. */
export interface ObservationInput {
    /** Ticket identifier (e.g. "AI-1378"). */
    ticket: string;
    /** Workflow ID (e.g. "dev-impl"). */
    workflow: string;
    /** Workflow step/state where the feedback was given (e.g. "code-review"). */
    step: string;
    /** The body (agent) that triggered the feedback transition. */
    fromBody: string;
    /** The body (agent) that gave the feedback (reviewer). */
    reviewerBody: string;
    /** Validated category_enum value. */
    reasonCode: ReasonCode;
    /** Optional free-text feedback from the reviewer. */
    freeText?: string | null;
    /** ISO-8601 timestamp; defaults to now. */
    timestamp?: string;
}
/** A persisted observation row. */
export interface Observation {
    id: number;
    ticket: string;
    workflow: string;
    step: string;
    fromBody: string;
    reviewerBody: string;
    reasonCode: string;
    freeText: string | null;
    createdAt: string;
}
/** Query parameters for reading observations. */
export interface ObservationQuery {
    workflow?: string;
    step?: string;
    reasonCode?: ReasonCode;
    ticket?: string;
    since?: string;
    until?: string;
    limit?: number;
}
/** A single metric row in the rollup. */
export interface MetricRow {
    workflow: string;
    step: string;
    reasonCode: string;
    count: number;
    fromBody?: string;
    exceedsThreshold: boolean;
}
/** Summary statistics for the metric rollup. */
export interface MetricSummary {
    totalObservations: number;
    uniqueWorkflows: number;
    uniqueSteps: number;
    stepsAboveThreshold: Array<{
        workflow: string;
        step: string;
        total: number;
    }>;
}
/** The full metric rollup response. */
export interface MetricRollup {
    items: MetricRow[];
    summary: MetricSummary;
    query: Record<string, unknown>;
}
export declare class ObservationStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /**
     * Validate that a reason code string is a known enum value.
     * Returns the typed ReasonCode, or null if invalid.
     */
    static validateReasonCode(value: string): ReasonCode | null;
    /**
     * §16.1: Check whether a reason code is 'other', which REQUIRES free text.
     * Used by the proxy to enforce the other-requires-free-text rule at write time.
     */
    static isOtherCategory(code: ReasonCode | string): boolean;
    /**
     * §16.1: Validate that 'other'-category feedback includes free text.
     * Returns true when the feedback is valid (either not 'other', or 'other' with non-empty freeText).
     * Returns false when 'other' is used without free text.
     */
    static validateOtherHasFreeText(reasonCode: ReasonCode | string, freeText?: string | null): boolean;
    /**
     * Append one observation row. Idempotent in the sense that duplicate
     * calls produce additional rows — this is intentional (append-only).
     * Returns the auto-incremented row ID.
     */
    append(input: ObservationInput): number;
    /**
     * Query observations with optional filters. Returns rows ordered by
     * creation time descending (newest first).
     */
    query(query?: ObservationQuery): Observation[];
    /**
     * Count observations grouped by (workflow, step, reason_code).
     * Used by P4-2 metric aggregation.
     */
    counts(query?: {
        workflow?: string;
        step?: string;
        reasonCode?: ReasonCode;
        since?: string;
        until?: string;
    }): Array<{
        workflow: string;
        step: string;
        reasonCode: string;
        count: number;
    }>;
    /**
     * Count observations grouped by (workflow, step, reason_code, from_body).
     * The P4-2 "macro" layer — where a step everyone fails becomes visible.
     * Optionally includes a body dimension for per-implementer breakdowns.
     */
    countsByBody(query?: {
        workflow?: string;
        step?: string;
        reasonCode?: ReasonCode;
        since?: string;
        until?: string;
    }): Array<{
        workflow: string;
        step: string;
        reasonCode: string;
        fromBody: string;
        count: number;
    }>;
    /**
     * Compute metrics: the ranked reason-code counts per step.
     * This is the "missing-tests ×14 this month" view.
     * Returns results sorted by count descending, grouped by (workflow, step, reason_code).
     * If includeBody is true, also breaks down by from_body.
     * Returns empty cleanly when no observations exist.
     */
    metrics(query?: {
        workflow?: string;
        step?: string;
        reasonCode?: ReasonCode;
        since?: string;
        until?: string;
        includeBody?: boolean;
        threshold?: number;
    }): MetricRollup;
    close(): void;
}
//# sourceMappingURL=observation-store.d.ts.map