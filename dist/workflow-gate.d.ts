/**
 * Phase 3 / B1 — Workflow-def-driven inbound command validation (AI-1352).
 * Phase 3 / B2 — Atomic state-label transition application (AI-1353).
 *
 * B1: Generalizes the Phase 2 single-rule escalation-gate (escalation-gate.ts) into
 * a full legal-move validator driven by the workflow definition YAML. The rule
 * table in the escalation-gate is superseded by this data-driven approach for
 * workflow tickets; both checks run in proxy.ts (defense in depth).
 *
 * B2: After a legal command is forwarded upstream, the proxy applies the state
 * transition by atomically swapping the old state:* label for the new one via a
 * single issueUpdate mutation. The proxy owns the transition (not the CLI) so
 * the state change is coupled to the validated forward — an agent cannot skip it.
 * State is derived independently via a fresh label fetch; agent-supplied state is
 * never trusted (§11). Fails open on any API error — label update failures are
 * logged but do not fail the proxied request.
 *
 * For workflow tickets (wf:*):
 *   1. Resolves the ticket's current state from its state:* label via an independent
 *      Linear query — the proxy NEVER trusts agent-supplied state (§11).
 *   2. Rejects any command not in the legal set for that state, naming the legal moves.
 *   3. Break-glass (escape) is always legal from every state (§4.4).
 *   4. Deploy requires deploy:execute capability; only the deployment body (Hanzo) holds it.
 *   5. On a forwarded legal command, swaps state:old → state:new in one mutation.
 *
 * Ad-hoc tickets (no wf:* label) are full pass-through — §4.6 mode switch.
 *
 * Fail-open posture (slice-1 carry-forward, AI-1347): fails open on missing
 * issueId / intent / label-fetch error. Phase 3 hardening to derive intent/issue
 * from the request body itself is a separate follow-up — do not block on it here.
 * TODO(AI-1347): derive intent/issue from request body when headers are absent.
 *
 * Design: design.md §4.2, §4.4, §4.6, §11, §13, §16.1, §16.2.
 */
export interface WorkflowTransition {
    command: string;
    to: string;
    requires_capability?: string;
    feedback?: {
        required?: boolean;
        category_enum?: string[];
    };
}
export interface WorkflowState {
    id: string;
    owner_role?: string;
    kind?: string;
    transitions?: WorkflowTransition[];
}
export interface WorkflowDef {
    id: string;
    version?: number;
    archetype?: string;
    entry_state?: string;
    /** §4.4: break_glass.command is the x-openclaw-linear-intent value for escape. */
    break_glass?: {
        command: string;
        to?: string;
        owner_role?: string;
    };
    states: WorkflowState[];
}
export declare function loadWorkflowDef(): Promise<WorkflowDef>;
/** Invalidate the in-process workflow def cache (used in tests). */
export declare function resetWorkflowCache(): void;
export declare function getWorkflowId(labels: string[]): string | null;
export declare function getCurrentState(labels: string[]): string | null;
/**
 * Fetch label names for a Linear issue.
 * Used by the outbound delivery path (B3) to detect workflow/state labels.
 * Returns an empty array on any error — callers fail open.
 */
export declare function fetchWorkflowLabels(issueId: string, authToken: string): Promise<string[]>;
/**
 * Evaluate full workflow-def-driven command validation for an inbound proxied request.
 *
 * Returns a rejection message when the command should be blocked, or null to forward.
 * Fails open on missing issueId, missing state label, unknown workflow, or label-fetch
 * failure — enforcement only blocks with affirmative evidence of a violation.
 */
export declare function checkWorkflowRules(intent: string, issueId: string | null, authToken: string, bodyId: string): Promise<string | null>;
/**
 * Apply the state-label transition triggered by a legal command (AI-1353 / §4.2).
 *
 * Called by proxy.ts after a validated command is successfully forwarded to Linear.
 * Re-derives the ticket's current state via an independent label fetch (never trusts
 * the caller's state snapshot — §11). Applies the transition by swapping state:old →
 * state:new in a single issueUpdate mutation so the ticket never carries zero or two
 * state:* labels.
 *
 * Seam decision (documented per ticket): the proxy applies the transition, not the
 * CLI. This couples the state change to the validated forward — an agent cannot issue
 * a raw GraphQL mutation and skip the transition. The CLI only needs to send the
 * x-openclaw-linear-intent header; the connector handles the bookkeeping.
 *
 * Idempotent: if the ticket is already in the target state, no mutation is issued.
 * Fail-open: any API error is logged; the caller's response is not affected.
 *
 * Special targets:
 *   __ad_hoc__ — ticket leaves the workflow; removes state:* and wf:* labels entirely.
 *   escape     — terminal break-glass state; transitions to state:escape normally.
 */
export declare function applyStateTransition(intent: string, issueId: string | null, authToken: string): Promise<void>;
//# sourceMappingURL=workflow-gate.d.ts.map