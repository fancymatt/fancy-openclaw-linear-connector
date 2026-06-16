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
    /** Phase 6.5 / H-7 (AI-1482): if true, capture verbatim AC from issue description at accept time. */
    capture_ac?: boolean;
    /** Phase 6.5 / H-7 (AI-1482): if true, requires human sign-off when stakes >= threshold. */
    requires_human_signoff_above_stakes?: boolean;
}
export interface WorkflowState {
    id: string;
    owner_role?: string;
    kind?: string;
    /** AI-1490: semantic native Linear state this workflow state projects to.
     *  Must be a key in the CLI's SEMANTIC_STATE_MAP (doing, thinking, done, invalid, etc.)
     *  or a literal Linear state name. Validated at connector startup. */
    native_state?: string;
    /** §5.5: per-state SLA as a duration string (e.g. "24h", "90m", "3600000").
     *  Time-in-state beyond this trips stall escalation (parsed to ms by barrier). */
    sla?: string;
    transitions?: WorkflowTransition[];
}
export interface StakesLevel {
    /** Map of stakes:* label names to numeric levels (e.g. stakes:low → 0, stakes:high → 2). */
    levels: Record<string, number>;
    /** Tickets at or above this level require human sign-off. */
    threshold: number;
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
    /**
     * AI-1579: recovery actor(s) — body id(s) (e.g. `ai`) permitted to re-establish
     * a delegate on a governed ticket whose delegate is currently EMPTY (orphaned),
     * at ANY state, even one whose owner_role they do not fill. This is the
     * authorization counterpart to the stale-session recovery machinery: when a
     * delegate's session dies without advancing the ticket, recovery clears the
     * delegate and must re-dispatch by writing a new delegateId — a raw write from
     * `ai`, which the role-based first-delegate check would otherwise block. Scoped
     * to the empty-delegate path only, so it can never steal a live delegate.
     */
    recovery_actor?: string | string[];
    /** Phase 6.5 / H-7 (AI-1482): stakes-threshold configuration for human sign-off gate. */
    stakes?: StakesLevel;
    states: WorkflowState[];
}
/**
 * Legacy single-def accessor. Returns the primary workflow def, derived from the
 * registry so its cache stays coherent with loadWorkflowRegistry().
 *   - Single-file mode (no WORKFLOW_DEFS_DIR): the registry holds exactly the
 *     WORKFLOW_DEF_PATH def — return it (preserving prior behavior and its
 *     fail-closed-on-load posture, which loadWorkflowRegistry rethrows).
 *   - Dir mode: return the def named by WORKFLOW_DEF_PATH if present in the
 *     registry, else the first registered def.
 */
export declare function loadWorkflowDef(): Promise<WorkflowDef>;
/**
 * AI-1530: Load ALL workflow defs into a registry keyed by def.id.
 *
 * This is the dispatch source for multi-workflow enforcement: the gate resolves
 * a ticket's def by its wf:<id> label via this registry, instead of comparing
 * against a single loaded def. After this lands, dev-impl, ux-audit and sprint
 * can all be enforced simultaneously by the same connector.
 *
 * Directory resolution:
 *   - If WORKFLOW_DEFS_DIR is set, load every *.yaml in that directory.
 *   - Otherwise (backwards-compat), load the single WORKFLOW_DEF_PATH file as a
 *     1-entry registry — preserving the current single-def deploy exactly (AC6).
 *
 * Per-def fail-closed (AC2): a def that fails native_state validation (or fails
 * to parse) is excluded from the registry and surfaced via logs + config-health,
 * while every other valid def still loads. In single-file mode a load failure
 * rethrows, preserving the existing fail-closed posture for the primary deploy.
 *
 * The result is cached; resetWorkflowCache() clears it (AC5) so a vault edit is
 * picked up on the next load without a code rebuild.
 */
export declare function loadWorkflowRegistry(): Promise<Map<string, WorkflowDef>>;
/** Invalidate the in-process workflow registry cache (used in tests & live-reload). */
export declare function resetWorkflowCache(): void;
/**
 * AI-1490 / AI-1498: Validate that every workflow state has a valid native_state field.
 * AI-1498 hardens this from warn → hard-fail for non-terminal states: a missing or
 * invalid native_state means the proxy cannot compute the native Linear stateId,
 * making desync structurally impossible. Returns an array of diagnostic errors.
 * The caller should throw when errors is non-empty for governed workflows.
 */
export declare function validateNativeStateMappings(def: WorkflowDef): string[];
/** Reset the native-state cache (used in tests). */
export declare function resetNativeStateCache(): void;
/**
 * AI-1498: Resolve a semantic native_state name (e.g. "doing", "done") to the actual
 * Linear workflow state UUID for the given team. Uses the same SEMANTIC_STATE_MAP
 * candidate-order resolution as the CLI so the proxy and CLI always agree.
 * Returns null if the state cannot be resolved.
 */
export declare function resolveNativeStateId(teamId: string, semanticName: string, authToken: string): Promise<string | null>;
/**
 * Resolve the set of `state:*` label IDs in the team that owns the given issue.
 *
 * AI-1612: the proxy is the sole writer of the workflow state label. To enforce
 * that, it strips `state:*` label deltas from the forwarded CLI mutation before
 * `applyStateTransition` runs — so a fail-closed transition is a true no-op
 * rather than a half-applied label move with a stranded delegate. Identifying
 * which delta IDs are state labels needs the team's full label set (the added
 * destination label is not yet on the issue), so this queries team labels, not
 * just the issue's current labels.
 *
 * Returns an empty set on any error — the proxy then fails open (strips nothing),
 * preserving prior behavior rather than risk dropping legitimate non-state labels.
 */
export declare function fetchTeamStateLabelIds(issueId: string, authToken: string): Promise<Set<string>>;
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
 * Resolve a ticket's numeric stakes level from its labels.
 * The stakes label namespace is whatever the def's `stakes.levels` map keys on
 * (currently `risk:*` — `risk:low`/`risk:medium`/`risk:high`; historically
 * `stakes:*`). Resolution is namespace-agnostic: a label counts as the stakes
 * label iff it is a key in `stakesConfig.levels`. This avoids the AI-1539 class
 * of bug where a hardcoded prefix (`/^stakes:/`) silently fails to match the
 * configured namespace and forces every ticket to fail closed.
 *
 * Fails OPEN (AI-1539, Matt directive 2026-06-11): when the ticket carries none
 * of the configured level labels, returns 0 (lowest stakes) — a *missing* tag
 * must not hold a task up for human review. Only an EXPLICIT high-stakes label
 * (e.g. risk:high mapping to >= threshold) trips the human sign-off gate.
 * Tradeoff accepted by the owner: a genuinely high-stakes task left untagged
 * will deploy without sign-off; tag it risk:high to gate it.
 */
export declare function resolveStakesLevel(labels: string[], stakesConfig: StakesLevel): number;
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
export declare function checkWorkflowRules(intent: string, issueId: string | null, authToken: string, bodyId: string, target?: string | null, callerLinearUserId?: string | null, artifactRef?: string | null, breakGlassOverride?: boolean): Promise<string | null>;
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
} | null, issueId: string | null, authToken: string, bodyId?: string, callerLinearUserId?: string | null): Promise<string | null>;
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
    /**
     * AI-1498 fix: the workflow state the ticket was in BEFORE the CLI's forwarded
     * mutation ran. Because the CLI advances the `state:*` label inside its own
     * forwarded `issueUpdate`, by the time this post-forward pass reads the ticket
     * the label is already at the destination — making an intent-based transition
     * lookup from the (post-move) current state miss and skip the native write.
     * Passing the captured pre-forward state lets the proxy compute the transition
     * from the true source so the atomic label+delegate+native write still fires.
     * Falls back to the ticket's current state:* label when undefined.
     */
    sourceStateOverride?: string;
}
export declare function applyStateTransition(intent: string, issueId: string | null, authToken: string, options?: ApplyStateTransitionOptions): Promise<void>;
/**
 * AI-1575: First-class atomic enrollment — enroll a ticket onto a workflow spine
 * in a single mutation (wf:* + state:intake + risk:* labels, steward delegate,
 * and native stateId). This eliminates the orphaned-delegate window that caused
 * the AI-1571 collision.
 *
 * Unlike the internal `handleEnrollment` (which operates on an already-forwarded
 * CLI command), this is a standalone public entry point that:
 *   - Accepts enrollment params (workflow, risk level) directly
 *   - Builds the label set from scratch (not from existing labels) — AC2 requires
 *     that old/stale labels are excluded from the enrollment write
 *   - Returns { success, mutationCount } so callers can assert atomicity
 *
 * Fail-closed: returns { success: false, mutationCount: 0 } if any prerequisite
 * (issue fetch, workflow def, label resolution, native state) cannot be resolved.
 */
export declare function applyEnrollment(opts: {
    issueIdentifier: string;
    workflow: string;
    risk: "low" | "medium" | "high";
    authToken: string;
    /** Optional: provide directly to skip the Linear user lookup. */
    stewardLinearUserId?: string;
}): Promise<{
    success: boolean;
    mutationCount: number;
}>;
/**
 * AI-1584: Enrollment gap repair.
 *
 * Detects and heals the dead-on-arrival condition where a ticket carries a `wf:*`
 * label but no `state:*` label — a gap that occurs when tickets are created via
 * bulk scripts or the raw Linear API and the entry-state stamp is never applied.
 *
 * This function is idempotent: it is a no-op when the ticket already has a
 * `state:*` label or when no `wf:*` label is present (ad-hoc ticket).
 *
 * Called from the webhook inbound path on every Issue event so gaps are healed
 * within one reconciliation cycle (i.e. the next webhook fire after creation).
 *
 * Fail-open: any API or registry failure logs a warning and returns
 * `{ enrolled: false }` — the inbound path is never blocked by enrollment.
 */
export interface EnrollHealInfo {
    /** Display identifier or UUID the caller passed in. */
    issueId: string;
    /** Linear internal issue UUID the label write was applied to. */
    internalId: string;
    /** Resolved workflow id (e.g. "dev-impl"). */
    workflowId: string;
    /** Entry state stamped (e.g. "intake"). */
    entryState: string;
}
export declare function enrollIfMissing(issueId: string, authToken: string, onHeal?: (info: EnrollHealInfo) => void): Promise<{
    enrolled: boolean;
    entryState?: string;
}>;
export interface SetStateAtomicResult {
    ok: boolean;
    ticketId: string;
    from: string | null;
    to: string;
    error?: string;
}
/**
 * Atomically re-establish the full workflow triple (state:* label, native Linear
 * state, delegate) on any governed ticket, including tickets in a terminal state.
 * No legal-move validation — the caller is the steward and has already been
 * authenticated at the HTTP layer.
 *
 * AC1: atomically sets label + native + delegate; consistency asserted after.
 * AC3: works from any source state including terminal states.
 * AC4: issueUpdateAtomic is a single issueUpdate mutation; Linear applies all
 *      fields atomically or none — no partial state possible on failure.
 */
export declare function setStateAtomic(ticketIdentifier: string, targetState: string, delegate: string | null | undefined, authToken: string): Promise<SetStateAtomicResult>;
//# sourceMappingURL=workflow-gate.d.ts.map