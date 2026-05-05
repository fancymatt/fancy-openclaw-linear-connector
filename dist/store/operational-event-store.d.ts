export declare const OPERATIONAL_EVENT_OUTCOMES: readonly ["received", "signature-rejected", "duplicate", "normalized", "terminal-pruned", "no-route", "routed", "dedup-suppressed", "bag-added", "delivered", "queued", "delivery-failed", "session-ended", "stale-resignaled"];
export type OperationalEventOutcome = typeof OPERATIONAL_EVENT_OUTCOMES[number];
export interface OperationalEventInput {
    outcome: OperationalEventOutcome;
    type?: string | null;
    agent?: string | null;
    key?: string | null;
    deliveryMode?: string | null;
    attemptCount?: number | null;
    runId?: string | null;
    sessionKey?: string | null;
    errorSummary?: string | null;
    detail?: unknown;
    occurredAt?: string;
}
export interface OperationalEvent extends Omit<Required<OperationalEventInput>, "detail" | "occurredAt"> {
    id: number;
    occurredAt: string;
    detail: unknown;
}
export interface OperationalEventQuery {
    agent?: string;
    key?: string;
    outcome?: OperationalEventOutcome;
    type?: string;
    since?: string;
    until?: string;
    limit?: number;
}
export interface OperationalSnapshot {
    key?: string;
    agent?: string;
    lastSuccess?: OperationalEvent;
    lastError?: OperationalEvent;
    lifecycle: OperationalEvent[];
}
export declare function redactOperationalDetail(detail: unknown): unknown;
export declare class OperationalEventStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    append(input: OperationalEventInput): number;
    query(query?: OperationalEventQuery): OperationalEvent[];
    snapshot(query: {
        key?: string;
        agent?: string;
        limit?: number;
    }): OperationalSnapshot;
    close(): void;
}
//# sourceMappingURL=operational-event-store.d.ts.map