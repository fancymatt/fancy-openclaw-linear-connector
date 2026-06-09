/**
 * Phase 3 / B1 — Workflow-def-driven inbound command validation (AI-1352).
 * Phase 3 / B2 — Atomic state-label transition application (AI-1353).
 * Layer 2 — Raw status/assignee mutation interception (AI-1387).
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
import { ObservationStore, type ReasonCode } from "./store/observation-store.js";
export interface WorkflowTransition {
    command: string;
    to: string;
    requires_capability?: string;
    /** §5.7 item 1: if true, this transition requires a bound artifact ref (e.g. sprint-plan doc). */
    requires_artifact?: boolean;
    feedback?: {
        required?: boolean;
        category_enum?: string[];
    };
    assign?: {
        mode?: 'required' | 'auto' | 'none';
        constraint?: string;
        default?: string;
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
/**
 * Derive legal assignment targets for a transition based on destination state's owner_role.
 * Returns mode=none for terminal states or roles with no bodies.
 * mode=auto when singleton, mode=required when multiple bodies fill the role.
 */
export declare function resolveTransitionTargets(transition: WorkflowTransition, def: WorkflowDef): Promise<{
    bodies: string[];
    mode: 'auto' | 'required' | 'none';
}>;
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
 *
 * @param callerLinearUserId - Linear user ID of the requesting agent (from agents.ts);
 *   used for delegate-only enforcement (AI-1397). Null/undefined → fail-open.
 */
export declare function checkWorkflowRules(intent: string, issueId: string | null, authToken: string, bodyId: string, target?: string | null, callerLinearUserId?: string | null, artifactRef?: string | null): Promise<string | null>;
/**
 * Detect raw mutations on workflow tickets (AI-1387, expanded in AI-1402).
 *
 * When an agent sends an `issueUpdate` with `stateId`, `assigneeId`, or `labelIds`
 * in the input but WITHOUT the `x-openclaw-linear-intent` header, they're bypassing
 * the workflow CLI commands. This function intercepts those raw mutations,
 * resolves the ticket's current state from its labels, and returns a rejection
 * that includes the legal verb set for that state.
 *
 * AI-1402 expansion: also blocks `labelIds` mutations (label manipulation is as
 * capable as state changes for bypassing workflow state) and adds fail-closed
 * enforcement for unknown callers on workflow tickets.
 *
 * Returns null to allow the request through (non-workflow ticket, non-mutation,
 * or no workflow-affecting fields in input). Returns a rejection string otherwise.
 * Fail-open on any error — missing issueId, label fetch failure, etc.
 */
export declare function checkRawMutationInterception(body: {
    query?: string;
    variables?: Record<string, unknown>;
    operationName?: string;
} | null, issueId: string | null, authToken: string, bodyId?: string): Promise<string | null>;
/**
 * Generate a legal-verb reminder for the NEW state after a successful transition.
 *
 * Layer 1 (AI-1387): re-surfaces the legal command set at the completion/decision
 * moment, so agents don't need to rely on the stale delegation-time injection.
 *
 * Returns null when not applicable (ad-hoc ticket, unknown state, terminal state).
 * Returns a formatted string with the legal commands for the NEW state.
 * Fail-open on any error.
 */
export declare function buildStateTransitionReminder(intent: string, issueId: string | null, authToken: string): Promise<string | null>;
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
export interface TransitionFeedback {
    /** The body (agent) that was the implementer / from-state owner. */
    fromBody?: string | null;
    /** The reason code from X-Openclaw-Feedback-Category header. */
    reasonCode: ReasonCode;
    /** Free-text feedback from the comment body. */
    freeText?: string | null;
}
export interface ApplyStateTransitionOptions {
    /** Agent/body issuing the transition (the reviewer). */
    bodyId?: string;
    /** Optional observation store for recording feedback observations. */
    observationStore?: ObservationStore;
    /** Structured feedback data for transitions with feedback.required. */
    feedback?: TransitionFeedback;
    /** §5.7 item 1 / C-2: artifact ref to bind at intake.accept (sprint-plan doc path). */
    artifactRef?: string | null;
}
export declare function applyStateTransition(intent: string, issueId: string | null, authToken: string, options?: ApplyStateTransitionOptions): Promise<void>;
//# sourceMappingURL=workflow-gate.d.ts.map