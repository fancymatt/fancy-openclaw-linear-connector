/**
 * AI-1566 — Connector rescue sweep: detect + repair dormant/malformed wf:* tickets.
 *
 * Safety net that periodically enumerates all wf:* tickets and rescues any that
 * have slipped into a broken shape — no delegate, no state label, or drifted
 * ownership. Detection uses labels + delegate only (NOT native Linear status),
 * so it survives the Bug B native-status breakage.
 *
 * Classification rules (mutually exclusive, evaluated in order):
 *   terminal  — state:done or state:escape (ignored)
 *   malformed — has wf:* but no state:* label
 *   dormant   — non-terminal, has state:*, but delegate is null/absent
 *   drifted   — non-terminal, has state:*, but delegate body does not fill the
 *               state's owner_role (per capability policy)
 *   healthy   — everything lines up
 *
 * Design: AI-1566 description.
 */
export type TicketClassification = "healthy" | "dormant" | "malformed" | "drifted" | "terminal";
export interface SweepTicket {
    /** Linear internal UUID */
    id: string;
    /** Human-readable identifier, e.g. "AI-1566" */
    identifier: string;
    /** Label names on the ticket */
    labels: string[];
    /** Linear user UUID of the current delegate, or null if unset */
    delegateId: string | null;
    /** Display name of the current delegate (optional, for logging) */
    delegateName?: string | null;
}
export interface RescueAction {
    ticketId: string;
    identifier: string;
    classification: Exclude<TicketClassification, "healthy" | "terminal">;
    /** Human-readable description of what was done */
    action: string;
    outcome: "rescued" | "failed" | "ambiguous";
}
export interface RescueSweepResult {
    scanned: number;
    rescued: number;
    byClassification: Partial<Record<TicketClassification, number>>;
    rescues: RescueAction[];
    errors: string[];
}
export interface RescueSweepOptions {
    /** Linear auth token (Bearer ...) */
    authToken: string;
    /** Workflow registry: map of wf-id → WorkflowDef. Defaults to empty Map. */
    workflowRegistry?: Map<string, WorkflowDef>;
    /** Capability policy path override for tests */
    capabilityPolicyPath?: string;
    /** Operational event store for emitting rescue events (optional; skipped if absent) */
    operationalEventStore?: {
        record(event: {
            outcome: string;
            type?: string;
            detail?: unknown;
        }): unknown;
    };
    /** Report issue identifier (e.g. "AI-1234") to post summary comment to */
    reportIssueIdentifier?: string;
    /**
     * Resolver: given a label name (e.g. "state:intake"), returns the Linear UUID for that
     * label, or null if not found. When omitted, the sweep fetches team labels at startup
     * to build this mapping automatically. Inject in tests for isolation.
     */
    labelNameToId?: (name: string) => string | null;
}
type WorkflowDef = {
    id?: string;
    entry_state?: string;
    states: Array<{
        id: string;
        owner_role?: string;
    }>;
};
/**
 * Classify a single ticket from its labels and current delegate.
 *
 * @param labels            Label names on the ticket
 * @param delegateId        Current delegate Linear user ID, or null
 * @param workflowDef       The WorkflowDef for this ticket's wf:* workflow (already resolved)
 * @param roleBodiesForRole Resolver: given a role id, returns body ids that fill it
 */
export declare function classifyTicket(labels: string[], delegateId: string | null, workflowDef: {
    entry_state?: string;
    states: Array<{
        id: string;
        owner_role?: string;
    }>;
}, roleBodiesForRole: (roleId: string) => string[]): TicketClassification;
/**
 * Run a full rescue sweep against Linear.
 *
 * Enumerates all wf:* tickets, classifies each, and rescues broken ones.
 * Terminal tickets are silently skipped. Healthy tickets are never touched.
 * Idempotent: a ticket already in the correct shape is classified healthy
 * and left alone. Within a single sweep, a rescued ticket is not re-processed.
 */
export declare function runRescueSweep(options: RescueSweepOptions): Promise<RescueSweepResult>;
export {};
//# sourceMappingURL=rescue-sweep.d.ts.map