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
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { bodyHasCapability, resolveBodiesForRole } from "./escalation-gate.js";
import { ObservationStore } from "./store/observation-store.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-gate");
const LINEAR_API_URL = "https://api.linear.app/graphql";
/**
 * Path to the dev-impl workflow definition YAML. Override via env for tests.
 * Canonical source lives in the vault; this default is absolute so the path is
 * stable regardless of process cwd.
 */
const DEFAULT_WORKFLOW_DEF_PATH = "/home/fancymatt/obsidian-vault/ai-systems/projects/fleet-orchestration-redesign/workflows/dev-impl.yaml";
/** Resolve the workflow def path dynamically (reads env each call so test beforeAll works). */
function workflowDefPath() {
    return process.env.WORKFLOW_DEF_PATH ?? DEFAULT_WORKFLOW_DEF_PATH;
}
// ── Workflow def cache ─────────────────────────────────────────────────────
let _workflowCache = null;
export async function loadWorkflowDef() {
    if (_workflowCache)
        return _workflowCache;
    const raw = await fs.readFile(workflowDefPath(), "utf8");
    const def = yaml.load(raw);
    if (def.break_glass && !def.break_glass.command) {
        log.warn(`workflow-gate: break_glass block in ${workflowDefPath()} has no 'command' field — falling back to hardcoded "escape". Canonicalize the YAML to add command: escape.`);
    }
    _workflowCache = def;
    return _workflowCache;
}
/** Invalidate the in-process workflow def cache (used in tests). */
export function resetWorkflowCache() {
    _workflowCache = null;
}
/**
 * Fetch label names for a Linear issue using the caller's auth token.
 * Independent of escalation-gate's label fetch — the proxy resolves state
 * from its own query and never trusts agent-supplied values (§11).
 * Returns an empty array on any error — enforcement fails open.
 */
async function fetchTicketLabels(issueId, authToken) {
    const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: authToken,
            },
            body: JSON.stringify({ query, variables: { id: issueId } }),
        });
        const data = (await res.json());
        return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: label fetch failed for ${issueId}: ${msg} — failing open`);
        return [];
    }
}
/**
 * Fetch label nodes with IDs plus the team ID for a Linear issue.
 * Used by B2 to build the label set for the atomic state swap mutation.
 * Returns null on any error — caller fails open.
 */
async function fetchIssueWithLabels(issueId, authToken) {
    const query = `
    query IssueWithLabels($id: String!) {
      issue(id: $id) {
        id
        team { id }
        labels { nodes { id name } }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: issueId } }),
        });
        const data = (await res.json());
        const issue = data.data?.issue;
        if (!issue)
            return null;
        return { internalId: issue.id, teamId: issue.team.id, labels: issue.labels.nodes };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: issue fetch failed for ${issueId}: ${msg}`);
        return null;
    }
}
/**
 * Find an existing label by name in the team, or create it if absent.
 * Returns the label ID, or null if both lookup and creation fail.
 */
async function findOrCreateLabel(teamId, labelName, authToken) {
    const lookupQuery = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { id name } }
      }
    }
  `;
    try {
        const lookupRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: lookupQuery, variables: { teamId } }),
        });
        const lookupData = (await lookupRes.json());
        const existing = (lookupData.data?.team?.labels?.nodes ?? []).find((n) => n.name === labelName);
        if (existing)
            return existing.id;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: team label lookup failed for team=${teamId}: ${msg}`);
        return null;
    }
    // Label does not yet exist — create it with a neutral grey color.
    const createMutation = `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
        success
        issueLabel { id }
      }
    }
  `;
    try {
        const createRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({
                query: createMutation,
                variables: { teamId, name: labelName, color: "#94a3b8" },
            }),
        });
        const createData = (await createRes.json());
        const result = createData.data?.issueLabelCreate;
        if (result?.success && result.issueLabel) {
            log.info(`workflow-gate: created label '${labelName}' in team ${teamId}`);
            return result.issueLabel.id;
        }
        log.warn(`workflow-gate: label creation returned non-success for '${labelName}'`);
        return null;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: label creation failed for '${labelName}': ${msg}`);
        return null;
    }
}
/**
 * Derive legal assignment targets for a transition based on destination state's owner_role.
 * Returns mode=none for terminal states or roles with no bodies.
 * mode=auto when singleton, mode=required when multiple bodies fill the role.
 */
export async function resolveTransitionTargets(transition, def) {
    const destState = def.states.find((s) => s.id === transition.to);
    const ownerRole = destState?.owner_role;
    if (!ownerRole || destState?.kind === 'terminal') {
        return { bodies: [], mode: 'none' };
    }
    const bodies = await resolveBodiesForRole(ownerRole);
    if (bodies.length === 0)
        return { bodies: [], mode: 'none' };
    if (bodies.length === 1)
        return { bodies, mode: 'auto' };
    return { bodies, mode: 'required' };
}
export function getWorkflowId(labels) {
    const label = labels.find((l) => /^wf:/i.test(l));
    return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
}
export function getCurrentState(labels) {
    const label = labels.find((l) => /^state:/i.test(l));
    return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
}
/**
 * Fetch label names for a Linear issue.
 * Used by the outbound delivery path (B3) to detect workflow/state labels.
 * Returns an empty array on any error — callers fail open.
 */
export async function fetchWorkflowLabels(issueId, authToken) {
    const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: issueId } }),
        });
        const data = (await res.json());
        return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: outbound label fetch failed for ${issueId}: ${msg} — failing open`);
        return [];
    }
}
// ── Public enforcement API ─────────────────────────────────────────────────
/**
 * Evaluate full workflow-def-driven command validation for an inbound proxied request.
 *
 * Returns a rejection message when the command should be blocked, or null to forward.
 * Fails open on missing issueId, missing state label, unknown workflow, or label-fetch
 * failure — enforcement only blocks with affirmative evidence of a violation.
 */
export async function checkWorkflowRules(intent, issueId, authToken, bodyId, target = null) {
    // TODO(AI-1347): fail-open on missing issueId is a Layer A carry-forward.
    // Harden by deriving issueId from the request body when headers are absent.
    if (!issueId)
        return null;
    const labels = await fetchTicketLabels(issueId, authToken);
    // §4.6 mode switch: ad-hoc tickets (no wf:* label) are full pass-through.
    const workflowId = getWorkflowId(labels);
    if (!workflowId)
        return null;
    let def;
    try {
        def = await loadWorkflowDef();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: failed to load workflow def: ${msg} — failing open`);
        return null;
    }
    // Only enforce for the workflow whose def is loaded; others fail open.
    if (workflowId !== def.id)
        return null;
    const breakGlassCommand = def.break_glass?.command ?? "escape";
    // §4.4: break-glass escape is legal from every state — never block it.
    if (intent === breakGlassCommand)
        return null;
    const currentState = getCurrentState(labels);
    if (!currentState) {
        log.warn(`workflow-gate: no state:* label on ${issueId} — failing open`);
        return null;
    }
    const stateNode = def.states.find((s) => s.id === currentState);
    if (!stateNode) {
        log.warn(`workflow-gate: unknown state '${currentState}' on ${issueId} — failing open`);
        return null;
    }
    const transitions = stateNode.transitions ?? [];
    const match = transitions.find((t) => t.command === intent);
    if (!match) {
        const legalMoves = [...transitions.map((t) => t.command), breakGlassCommand].join(", ");
        return (`[Proxy] '${intent}' is not a legal command in state '${currentState}'. ` +
            `Legal moves: ${legalMoves}.`);
    }
    // Capability gate — e.g. deploy:execute is Hanzo-only (§16.2).
    if (match.requires_capability) {
        const allowed = await bodyHasCapability(bodyId, match.requires_capability);
        if (!allowed) {
            return (`[Proxy] '${intent}' requires the '${match.requires_capability}' capability; ` +
                `handoff to the deployment body to proceed.`);
        }
    }
    // Assignment target validation (§4.3, §16.1)
    const destStateNode = def.states.find((s) => s.id === match.to);
    const ownerRole = destStateNode?.owner_role;
    if (ownerRole && destStateNode?.kind !== 'terminal') {
        let legalBodies;
        try {
            legalBodies = await resolveBodiesForRole(ownerRole);
        }
        catch {
            legalBodies = []; // fail-open
        }
        if (legalBodies.length > 1) {
            if (!target) {
                return `[Proxy] '${intent}' requires an assignment target. Legal targets for role '${ownerRole}': ${legalBodies.join(', ')}.`;
            }
            if (!legalBodies.includes(target)) {
                return `[Proxy] '${target}' is not a legal assignment target for '${intent}'. Legal targets for role '${ownerRole}': ${legalBodies.join(', ')}.`;
            }
        }
        else if (legalBodies.length === 1) {
            if (target && target !== legalBodies[0]) {
                return `[Proxy] '${intent}' auto-assigns to '${legalBodies[0]}' (singleton role); target '${target}' rejected.`;
            }
        }
    }
    // not-implementer constraint (self-review prevention §4.3)
    if (match.assign?.constraint === 'not-implementer' && target && target === bodyId) {
        return `[Proxy] Self-review blocked: reviewer must differ from implementer ('${bodyId}').`;
    }
    return null;
}
export async function applyStateTransition(intent, issueId, authToken, options) {
    // TODO(AI-1347): no-op on missing issueId carries the same fail-open posture as B1.
    if (!issueId)
        return;
    const issue = await fetchIssueWithLabels(issueId, authToken);
    if (!issue) {
        log.warn(`workflow-gate: B2 apply: could not fetch labels for ${issueId} — skipping`);
        return;
    }
    const labelNames = issue.labels.map((l) => l.name);
    const workflowId = getWorkflowId(labelNames);
    if (!workflowId)
        return; // ad-hoc ticket — no-op
    let def;
    try {
        def = await loadWorkflowDef();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: B2 apply: failed to load workflow def: ${msg} — skipping`);
        return;
    }
    if (workflowId !== def.id)
        return; // unknown workflow — no-op
    const currentStateName = getCurrentState(labelNames);
    if (!currentStateName) {
        log.warn(`workflow-gate: B2 apply: no state:* label on ${issueId} — skipping`);
        return;
    }
    const breakGlassCommand = def.break_glass?.command ?? "escape";
    let toStateName;
    let matchedTransition;
    if (intent === breakGlassCommand) {
        toStateName = def.break_glass?.to ?? "escape";
    }
    else {
        const stateNode = def.states.find((s) => s.id === currentStateName);
        matchedTransition = stateNode?.transitions?.find((t) => t.command === intent);
        if (!matchedTransition) {
            // Should not happen — B1 already validated the command — but fail-open.
            log.warn(`workflow-gate: B2 apply: no transition for '${intent}' in state '${currentStateName}' on ${issueId} — skipping`);
            return;
        }
        toStateName = matchedTransition.to;
    }
    // ── Special target: __ad_hoc__ ─────────────────────────────────────────
    // Ticket is demoted out of the workflow — remove state:* and wf:* labels.
    if (toStateName === "__ad_hoc__") {
        const keepIds = issue.labels
            .filter((l) => !l.name.startsWith("state:") && !l.name.startsWith("wf:"))
            .map((l) => l.id);
        await issueUpdateLabels(issue.internalId, keepIds, authToken);
        log.info(`workflow-gate: B2 apply: ${issueId} demoted to __ad_hoc__ — removed state:* and wf:* labels`);
        return;
    }
    // ── Idempotency check ──────────────────────────────────────────────────
    if (currentStateName === toStateName) {
        log.info(`workflow-gate: B2 apply: ${issueId} already in state '${toStateName}' — no-op`);
        return;
    }
    // ── Atomic label swap ──────────────────────────────────────────────────
    const oldLabel = issue.labels.find((l) => l.name === `state:${currentStateName}`);
    if (!oldLabel) {
        log.warn(`workflow-gate: B2 apply: could not find label id for state:${currentStateName} on ${issueId} — skipping`);
        return;
    }
    const newLabelId = await findOrCreateLabel(issue.teamId, `state:${toStateName}`, authToken);
    if (!newLabelId) {
        log.warn(`workflow-gate: B2 apply: could not resolve label id for state:${toStateName} — skipping`);
        return;
    }
    const newLabelIds = [
        ...issue.labels.filter((l) => l.id !== oldLabel.id).map((l) => l.id),
        newLabelId,
    ];
    const applied = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
    if (applied) {
        log.info(`workflow-gate: B2 apply: ${issueId} state:${currentStateName} → state:${toStateName}`);
    }
    // ── Phase 4 / P4-1: Record feedback observation ──────────────────────
    // After a successful state transition, if the transition has a feedback
    // block and feedback data was provided, write one append-only observation.
    // Fail-open: observation errors are logged and never block the transition.
    if (matchedTransition?.feedback?.required && options?.observationStore && options?.feedback) {
        try {
            const validatedReason = ObservationStore.validateReasonCode(options.feedback.reasonCode);
            if (!validatedReason) {
                log.warn(`workflow-gate: P4-1: invalid reason code '${options.feedback.reasonCode}' — observation skipped for ${issueId}`);
            }
            else if (!options.feedback.fromBody) {
                // The implementer body ID must be provided (via X-Openclaw-From-Body header from
                // the CLI). Without it, from_body == reviewer_body, which produces useless data
                // for P4-2/3/4 aggregation. Skip the row rather than write garbage.
                log.warn(`workflow-gate: P4-1: fromBody not provided (X-Openclaw-From-Body header absent) — observation skipped for ${issueId}`);
            }
            else {
                options.observationStore.append({
                    ticket: issueId,
                    workflow: workflowId,
                    step: currentStateName,
                    fromBody: options.feedback.fromBody,
                    reviewerBody: options.bodyId ?? "unknown",
                    reasonCode: validatedReason,
                    freeText: options.feedback.freeText ?? null,
                });
                log.info(`workflow-gate: P4-1: observation recorded for ${issueId} reason=${validatedReason}`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`workflow-gate: P4-1: observation write failed for ${issueId}: ${msg}`);
        }
    }
}
async function issueUpdateLabels(internalId, labelIds, authToken) {
    const mutation = `
    mutation ApplyStateTransition($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: mutation, variables: { issueId: internalId, labelIds } }),
        });
        const data = (await res.json());
        if (!data.data?.issueUpdate?.success) {
            log.warn(`workflow-gate: B2 apply: issueUpdate returned non-success for ${internalId}`);
            return false;
        }
        return true;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: B2 apply: issueUpdate failed for ${internalId}: ${msg}`);
        return false;
    }
}
//# sourceMappingURL=workflow-gate.js.map