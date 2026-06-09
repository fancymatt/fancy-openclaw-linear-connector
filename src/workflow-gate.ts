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

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { bodyHasCapability, resolveBodiesForRole } from "./escalation-gate.js";
import { ObservationStore, type ReasonCode } from "./store/observation-store.js";
import { isBodyKnown } from "./escalation-gate.js";
import { getAgent } from "./agents.js";
import { executeFanout, shouldTriggerFanout } from "./fanout.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-gate");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Path to the dev-impl workflow definition YAML. Override via env for tests.
 * Canonical source lives in the vault; this default is absolute so the path is
 * stable regardless of process cwd.
 */
const DEFAULT_WORKFLOW_DEF_PATH =
  "/home/fancymatt/obsidian-vault/ai-systems/projects/fleet-orchestration-redesign/workflows/dev-impl.yaml";

/** Resolve the workflow def path dynamically (reads env each call so test beforeAll works). */
function workflowDefPath(): string {
  return process.env.WORKFLOW_DEF_PATH ?? DEFAULT_WORKFLOW_DEF_PATH;
}

// ── YAML schema types ──────────────────────────────────────────────────────

export interface WorkflowTransition {
  command: string;
  to: string;
  requires_capability?: string;
  feedback?: { required?: boolean; category_enum?: string[] };
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
  break_glass?: { command: string; to?: string; owner_role?: string };
  states: WorkflowState[];
}

// ── Workflow def cache ─────────────────────────────────────────────────────

let _workflowCache: WorkflowDef | null = null;

export async function loadWorkflowDef(): Promise<WorkflowDef> {
  if (_workflowCache) return _workflowCache;
  const raw = await fs.readFile(workflowDefPath(), "utf8");
  const def = yaml.load(raw) as WorkflowDef;
  if (def.break_glass && !def.break_glass.command) {
    log.warn(`workflow-gate: break_glass block in ${workflowDefPath()} has no 'command' field — falling back to hardcoded "escape". Canonicalize the YAML to add command: escape.`);
  }
  _workflowCache = def;
  return _workflowCache;
}

/** Invalidate the in-process workflow def cache (used in tests). */
export function resetWorkflowCache(): void {
  _workflowCache = null;
}

// ── Label fetch ────────────────────────────────────────────────────────────

interface LabelNode {
  id: string;
  name: string;
}

interface TicketContext {
  labels: string[];
  /** Linear user ID of the current delegate, or null if unset. */
  delegateId: string | null;
}

/**
 * Fetch label names and delegate for a Linear issue using the caller's auth token.
 * Independent of escalation-gate's label fetch — the proxy resolves state
 * from its own query and never trusts agent-supplied values (§11).
 * Returns empty labels and null delegate on any error — enforcement fails open.
 */
async function fetchTicketContext(issueId: string, authToken: string): Promise<TicketContext> {
  const query = `query IssueContext($id: String!) { issue(id: $id) { labels { nodes { name } } delegate { id } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type ContextResp = {
      data?: {
        issue?: {
          labels?: { nodes: Array<{ name: string }> };
          delegate?: { id: string } | null;
        };
      };
    };
    const data = (await res.json()) as ContextResp;
    const issue = data.data?.issue;
    return {
      labels: (issue?.labels?.nodes ?? []).map((n) => n.name),
      delegateId: issue?.delegate?.id ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: context fetch failed for ${issueId}: ${msg} — failing open`);
    return { labels: [], delegateId: null };
  }
}

/**
 * Fetch label nodes with IDs plus the team ID for a Linear issue.
 * Used by B2 to build the label set for the atomic state swap mutation.
 * Returns null on any error — caller fails open.
 */
async function fetchIssueWithLabels(
  issueId: string,
  authToken: string,
): Promise<{ internalId: string; teamId: string; labels: LabelNode[] } | null> {
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
    type Resp = {
      data?: {
        issue?: {
          id: string;
          team: { id: string };
          labels: { nodes: LabelNode[] };
        };
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return { internalId: issue.id, teamId: issue.team.id, labels: issue.labels.nodes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: issue fetch failed for ${issueId}: ${msg}`);
    return null;
  }
}

/**
 * Find an existing label by name in the team, or create it if absent.
 * Returns the label ID, or null if both lookup and creation fail.
 */
async function findOrCreateLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
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
    type LookupResp = { data?: { team?: { labels: { nodes: LabelNode[] } } } };
    const lookupData = (await lookupRes.json()) as LookupResp;
    const existing = (lookupData.data?.team?.labels?.nodes ?? []).find(
      (n) => n.name === labelName,
    );
    if (existing) return existing.id;
  } catch (err) {
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
    type CreateResp = {
      data?: { issueLabelCreate?: { success: boolean; issueLabel?: { id: string } } };
    };
    const createData = (await createRes.json()) as CreateResp;
    const result = createData.data?.issueLabelCreate;
    if (result?.success && result.issueLabel) {
      log.info(`workflow-gate: created label '${labelName}' in team ${teamId}`);
      return result.issueLabel.id;
    }
    log.warn(`workflow-gate: label creation returned non-success for '${labelName}'`);
    return null;
  } catch (err) {
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
export async function resolveTransitionTargets(
  transition: WorkflowTransition,
  def: WorkflowDef,
): Promise<{ bodies: string[]; mode: 'auto' | 'required' | 'none' }> {
  const destState = def.states.find((s) => s.id === transition.to);
  const ownerRole = destState?.owner_role;
  if (!ownerRole || destState?.kind === 'terminal') {
    return { bodies: [], mode: 'none' };
  }
  const bodies = await resolveBodiesForRole(ownerRole);
  if (bodies.length === 0) return { bodies: [], mode: 'none' };
  if (bodies.length === 1) return { bodies, mode: 'auto' };
  return { bodies, mode: 'required' };
}

export function getWorkflowId(labels: string[]): string | null {
  const label = labels.find((l) => /^wf:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
}

export function getCurrentState(labels: string[]): string | null {
  const label = labels.find((l) => /^state:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
}

/**
 * Fetch label names for a Linear issue.
 * Used by the outbound delivery path (B3) to detect workflow/state labels.
 * Returns an empty array on any error — callers fail open.
 */
export async function fetchWorkflowLabels(issueId: string, authToken: string): Promise<string[]> {
  const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type LabelResp = { data?: { issue?: { labels?: { nodes: Array<{ name: string }> } } } };
    const data = (await res.json()) as LabelResp;
    return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
  } catch (err) {
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
 *
 * @param callerLinearUserId - Linear user ID of the requesting agent (from agents.ts);
 *   used for delegate-only enforcement (AI-1397). Null/undefined → fail-open.
 */
export async function checkWorkflowRules(
  intent: string,
  issueId: string | null,
  authToken: string,
  bodyId: string,
  target: string | null = null,
  callerLinearUserId?: string | null
): Promise<string | null> {
  // TODO(AI-1347): fail-open on missing issueId is a Layer A carry-forward.
  // Harden by deriving issueId from the request body when headers are absent.
  if (!issueId) return null;

  const { labels, delegateId } = await fetchTicketContext(issueId, authToken);

  // §4.6 mode switch: ad-hoc tickets (no wf:* label) are full pass-through.
  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null;

  let def: WorkflowDef;
  try {
    def = await loadWorkflowDef();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: failed to load workflow def: ${msg} — failing open`);
    return null;
  }

  // Only enforce for the workflow whose def is loaded; others fail open.
  if (workflowId !== def.id) return null;

  // AI-1402: Fail-closed on unknown caller. When the caller's body is not in the
  // capability policy and the ticket is a governed workflow ticket, block the mutation.
  // This is consistent with AI-1400 B2: unknown caller + known delegate = block.
  if (!(await isBodyKnown(bodyId))) {
    log.warn(`workflow-gate: unknown caller '${bodyId}' on wf:${workflowId} ticket ${issueId} — blocking`);
    return (
      `[Proxy] Unknown caller '${bodyId}' blocked on workflow ticket. ` +
      `Ensure this agent is registered in the capability policy.`
    );
  }

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  // §4.4: break-glass escape is legal from every state — never block it.
  if (intent === breakGlassCommand) return null;

  // AI-1460: refuse-work is a meta-command (ownership/routing gesture), not a
  // workflow transition. A wrongly-dispatched agent must always be able to
  // decline work regardless of workflow state. Bypasses both state validation
  // and delegate-only enforcement (the refusal itself clears the delegate).
  // Still requires a known caller — unknown agents cannot refuse.
  if (intent === "refuse-work") return null;

  // AI-1397: delegate-only enforcement at proxy (CLI-version-agnostic).
  // If both the caller's Linear user ID and the ticket's delegate ID are known,
  // block any agent that is not the current delegate. Fails open when either is
  // unknown (delegate not set, agent config missing linearUserId, fetch error).
  // AI-1400 B2: additionally fail-closed when the caller identity is unknown
  // (no linearUserId in agents.json) but the ticket has a known delegate — an
  // unverifiable caller must not be allowed to mutate a delegated ticket.
  if (!callerLinearUserId && delegateId) {
    log.warn(`workflow-gate: unknown-caller block agent=${bodyId} intent=${intent} ticket=${issueId}`);
    return (
      `[Proxy] '${intent}' blocked: caller '${bodyId}' cannot be verified and the ticket has a known delegate. ` +
      `Register the agent in agents.json with a linearUserId to proceed.`
    );
  }
  if (callerLinearUserId && delegateId && callerLinearUserId !== delegateId) {
    log.warn(`workflow-gate: delegate-only block agent=${bodyId} intent=${intent} ticket=${issueId}`);
    return (
      `[Proxy] '${intent}' blocked: ${bodyId} is not the current delegate for ${issueId}. ` +
      `Only the ticket delegate may mutate its state.`
    );
  }

  const currentState = getCurrentState(labels);
  if (!currentState) {
    // AI-1402: For needs-human, fail-closed even without a state label.
    // We cannot determine if there is a forward path, so treat the ticket as actionable.
    // Agents must use 'escape' (break-glass) to exit the workflow.
    if (intent === "needs-human") {
      const legalMoves = `${breakGlassCommand} (break-glass)`;
      return (
        `[Proxy] 'needs-human' is blocked on this workflow ticket (state unknown — treated as actionable). ` +
        `Use '${breakGlassCommand}' to exit the workflow. Legal moves: ${legalMoves}.`
      );
    }
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
    return (
      `[Proxy] '${intent}' is not a legal command in state '${currentState}'. ` +
      `Legal moves: ${legalMoves}.`
    );
  }

  // Capability gate — e.g. deploy:execute is Hanzo-only (§16.2).
  if (match.requires_capability) {
    const allowed = await bodyHasCapability(bodyId, match.requires_capability);
    if (!allowed) {
      return (
        `[Proxy] '${intent}' requires the '${match.requires_capability}' capability; ` +
        `handoff to the deployment body to proceed.`
      );
    }
  }

  // Assignment target validation (§4.3, §16.1)
  const destStateNode = def.states.find((s) => s.id === match.to);
  const ownerRole = destStateNode?.owner_role;
  if (ownerRole && destStateNode?.kind !== 'terminal') {
    let legalBodies: string[];
    try {
      legalBodies = await resolveBodiesForRole(ownerRole);
    } catch {
      legalBodies = []; // fail-open
    }

    if (legalBodies.length > 1) {
      if (!target) {
        return `[Proxy] '${intent}' requires an assignment target. Legal targets for role '${ownerRole}': ${legalBodies.join(', ')}.`;
      }
      if (!legalBodies.includes(target)) {
        return `[Proxy] '${target}' is not a legal assignment target for '${intent}'. Legal targets for role '${ownerRole}': ${legalBodies.join(', ')}.`;
      }
    } else if (legalBodies.length === 1) {
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

// ── Layer 2: Raw status/assignee mutation interception (AI-1387) ──────────

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
export async function checkRawMutationInterception(
  body: { query?: string; variables?: Record<string, unknown>; operationName?: string } | null,
  issueId: string | null,
  authToken: string,
  bodyId?: string,
): Promise<string | null> {
  if (!body || !issueId) return null;

  // Only intercept issueUpdate mutations.
  const q = body.query ?? "";
  if (!q.includes("issueUpdate")) return null;

  // Check if the mutation input contains any workflow-affecting fields.
  // Blocked: stateId (status), assigneeId (assignee), labelIds (label manipulation).
  // Allowed: title, description, priority, dueDate, and other non-workflow fields.
  const vars = body.variables ?? {};
  const input = (vars as Record<string, unknown>).input;
  const inputObj = input && typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : null;

  const hasStateChange = inputObj && typeof inputObj.stateId === "string";
  const hasAssigneeChange = inputObj && ("assigneeId" in (inputObj as object));
  const hasLabelChange = inputObj && ("labelIds" in (inputObj as object));

  if (!hasStateChange && !hasAssigneeChange && !hasLabelChange) return null;

  // This is a raw workflow-affecting mutation — check if the ticket is on a workflow.
  const { labels } = await fetchTicketContext(issueId, authToken);
  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null; // ad-hoc ticket — pass-through

  // AI-1402: Fail-closed on unknown caller on governed workflow tickets.
  // If the caller body is not registered in the capability policy, block the mutation.
  if (bodyId && !(await isBodyKnown(bodyId))) {
    log.warn(`workflow-gate: unknown caller '${bodyId}' raw mutation on wf:${workflowId} ticket ${issueId} — blocking`);
    return (
      `[Proxy] Unknown caller '${bodyId}' blocked on workflow ticket. ` +
      `Ensure this agent is registered in the capability policy.`
    );
  }

  let def: WorkflowDef;
  try {
    def = await loadWorkflowDef();
  } catch {
    return null; // fail-open
  }

  if (workflowId !== def.id) return null; // unknown workflow — pass-through

  const breakGlassCommand = def.break_glass?.command ?? "escape";
  const currentState = getCurrentState(labels);

  if (!currentState) {
    // No state label — can't determine legal moves, but still block with a generic message.
    const allCommands = new Set<string>();
    for (const s of def.states) {
      for (const t of s.transitions ?? []) allCommands.add(t.command);
    }
    allCommands.add(breakGlassCommand);
    return (
      `[Proxy] Direct mutation blocked on this workflow ticket (state unknown). ` +
      `Use workflow commands: ${[...allCommands].join(", ")}.`
    );
  }

  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) return null; // unknown state — fail-open

  // Build per-command help strings with assignment info.
  const helpLines = await Promise.all(
    (stateNode.transitions ?? []).map(async (t) => {
      const { bodies, mode } = await resolveTransitionTargets(t, def);
      let cmd = `linear ${t.command} ${issueId}`;
      if (mode === "required") {
        cmd += ` <${bodies.join("|")}>`;
      }
      return `  - \`${cmd}\` (→ ${t.to})`;
    }),
  );
  helpLines.push(`  - \`linear ${breakGlassCommand} ${issueId}\` (break glass → ${def.break_glass?.to ?? "escape"}, legal from any state)`);

  const changedFields: string[] = [];
  if (hasStateChange) changedFields.push("status");
  if (hasAssigneeChange) changedFields.push("assignee");
  if (hasLabelChange) changedFields.push("labels");

  return (
    `[Proxy] Direct ${changedFields.join("/")} changes are blocked on this workflow ticket ` +
    `(state: **${currentState}**). Use workflow commands instead:\n\n` +
    helpLines.join("\n")
  );
}

// ── Layer 1: Proactive legal-verb re-injection at completion (AI-1387) ────

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
export async function buildStateTransitionReminder(
  intent: string,
  issueId: string | null,
  authToken: string,
): Promise<string | null> {
  if (!issueId) return null;

  let def: WorkflowDef;
  try {
    def = await loadWorkflowDef();
  } catch {
    return null;
  }

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  // Determine the destination state from the intent.
  let destStateName: string;
  if (intent === breakGlassCommand) {
    destStateName = def.break_glass?.to ?? "escape";
  } else {
    // Find which transition this intent triggers by scanning all states.
    // We don't know the current state here, so we look for any transition
    // matching this intent. Since commands are unique per state in dev-impl,
    // this works. For ambiguous workflows, the label-based approach below
    // would be needed.
    let found = false;
    for (const s of def.states) {
      const t = (s.transitions ?? []).find((tr) => tr.command === intent);
      if (t) {
        destStateName = t.to;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }

  // destStateName is set above in both branches
  const destState = def.states.find((s) => s.id === (destStateName as string));
  if (!destState) return null;

  // Terminal states have no transitions — no reminder needed.
  if (destState.kind === "terminal" || !destState.transitions?.length) return null;

  const transitions = destState.transitions;
  const helpLines = await Promise.all(
    transitions.map(async (t) => {
      const { bodies, mode } = await resolveTransitionTargets(t, def);
      let cmd = `linear ${t.command} ${issueId}`;
      if (mode === "required") {
        cmd += ` <${bodies.join("|")}>`;
      }
      return `  - \`${cmd}\` (→ ${t.to})`;
    }),
  );
  helpLines.push(`  - \`linear ${breakGlassCommand} ${issueId}\` (break glass, legal from any state)`);

  return (
    `[Workflow] You are now in state: **${destState.id}**. Your legal action(s):\n` +
    helpLines.join("\n")
  );
}

// ── B2: Atomic state-label transition application ─────────────────────────

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
}

export async function applyStateTransition(
  intent: string,
  issueId: string | null,
  authToken: string,
  options?: ApplyStateTransitionOptions,
): Promise<void> {
  // TODO(AI-1347): no-op on missing issueId carries the same fail-open posture as B1.
  if (!issueId) return;

  const issue = await fetchIssueWithLabels(issueId, authToken);
  if (!issue) {
    log.warn(`workflow-gate: B2 apply: could not fetch labels for ${issueId} — skipping`);
    return;
  }

  const labelNames = issue.labels.map((l) => l.name);
  const workflowId = getWorkflowId(labelNames);
  if (!workflowId) return; // ad-hoc ticket — no-op

  let def: WorkflowDef;
  try {
    def = await loadWorkflowDef();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: B2 apply: failed to load workflow def: ${msg} — skipping`);
    return;
  }

  if (workflowId !== def.id) return; // unknown workflow — no-op

  const currentStateName = getCurrentState(labelNames);
  if (!currentStateName) {
    log.warn(`workflow-gate: B2 apply: no state:* label on ${issueId} — skipping`);
    return;
  }

  const breakGlassCommand = def.break_glass?.command ?? "escape";
  let toStateName: string;
  let matchedTransition: WorkflowTransition | undefined;

  if (intent === breakGlassCommand) {
    toStateName = def.break_glass?.to ?? "escape";
  } else {
    const stateNode = def.states.find((s) => s.id === currentStateName);
    matchedTransition = stateNode?.transitions?.find((t) => t.command === intent);
    if (!matchedTransition) {
      // Should not happen — B1 already validated the command — but fail-open.
      log.warn(
        `workflow-gate: B2 apply: no transition for '${intent}' in state '${currentStateName}' on ${issueId} — skipping`,
      );
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
    log.info(
      `workflow-gate: B2 apply: ${issueId} demoted to __ad_hoc__ — removed state:* and wf:* labels`,
    );
    return;
  }

  // ── Idempotency check ──────────────────────────────────────────────────
  if (currentStateName === toStateName) {
    log.info(
      `workflow-gate: B2 apply: ${issueId} already in state '${toStateName}' — no-op`,
    );
    return;
  }

  // ── Atomic label swap ──────────────────────────────────────────────────
  const oldLabel = issue.labels.find((l) => l.name === `state:${currentStateName}`);
  if (!oldLabel) {
    log.warn(
      `workflow-gate: B2 apply: could not find label id for state:${currentStateName} on ${issueId} — skipping`,
    );
    return;
  }

  const newLabelId = await findOrCreateLabel(
    issue.teamId,
    `state:${toStateName}`,
    authToken,
  );
  if (!newLabelId) {
    log.warn(
      `workflow-gate: B2 apply: could not resolve label id for state:${toStateName} — skipping`,
    );
    return;
  }

  const newLabelIds = [
    ...issue.labels.filter((l) => l.id !== oldLabel.id).map((l) => l.id),
    newLabelId,
  ];

  const applied = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
  if (applied) {
    log.info(
      `workflow-gate: B2 apply: ${issueId} state:${currentStateName} → state:${toStateName}`,
    );
  }

  // ── Auto-delegate assignment (AI-1463) ─────────────────────────────────
  // After a successful state transition, if the destination state has a
  // singleton owner_role (exactly one body fills it), automatically update
  // the ticket delegate to that body's linearUserId. This prevents the
  // reviewer from being stuck as delegate in a state they cannot act on.
  // Fail-open: errors are logged and never block the already-succeeded label transition.
  const destStateNode = def.states.find((s) => s.id === toStateName);
  const destOwnerRole = destStateNode?.owner_role;
  if (destOwnerRole && destStateNode?.kind !== 'terminal') {
    try {
      const roleBodies = await resolveBodiesForRole(destOwnerRole);
      if (roleBodies.length === 1) {
        const agent = getAgent(roleBodies[0]);
        if (agent?.linearUserId) {
          const delegateUpdated = await issueUpdateDelegate(
            issue.internalId,
            agent.linearUserId,
            authToken,
          );
          if (delegateUpdated) {
            log.info(
              `workflow-gate: B2 apply: ${issueId} auto-delegate → ${roleBodies[0]} (linearUserId=${agent.linearUserId})`,
            );
          }
        } else {
          log.warn(
            `workflow-gate: B2 apply: singleton body '${roleBodies[0]}' for role '${destOwnerRole}' has no linearUserId — skipping auto-delegate`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B2 apply: auto-delegate failed for ${issueId}: ${msg}`);
    }
  }

  // ── Phase 5 / B-2: Fan-out edge (spawning 1→N) ──────────────────────
  // After a successful state transition to `managing` via the `spawn` command
  // on a ux-audit ticket, execute the fan-out to create N dev-impl children.
  // Fail-open: fan-out errors are logged and never block the transition.
  // AC3: parent auto-transitions to managing once children are minted (the
  // state transition to `managing` has already been applied above; the fan-out
  // creates the children and links them to the parent).
  if (applied && shouldTriggerFanout(workflowId, currentStateName, intent)) {
    try {
      log.info(`workflow-gate: B-2 fan-out: triggering fan-out for ${issueId} (spawning → managing)`);
      const fanoutResult = await executeFanout(issueId, authToken);
      if (fanoutResult.created > 0) {
        log.info(
          `workflow-gate: B-2 fan-out: ${fanoutResult.created} child(ren) created for ${issueId}: ${fanoutResult.childIdentifiers.join(", ")}`,
        );
      } else {
        log.warn(`workflow-gate: B-2 fan-out: no children created for ${issueId} — ${fanoutResult.errors.map((e) => e.message).join(";")}`);
      }
      // Post a summary comment on the parent ticket with the fan-out result.
      if (fanoutResult.created > 0) {
        await postFanoutSummaryComment(issue.internalId, fanoutResult, authToken);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-2 fan-out: fan-out failed for ${issueId}: ${msg}`);
    }
  }

  // ── Phase 4 / P4-1: Record feedback observation ──────────────────────
  // After a successful state transition, if the transition has a feedback
  // block and feedback data was provided, write one append-only observation.
  // Fail-open: observation errors are logged and never block the transition.
  if (matchedTransition?.feedback?.required && options?.observationStore && options?.feedback) {
    try {
      const validatedReason = ObservationStore.validateReasonCode(options.feedback.reasonCode);
      if (!validatedReason) {
        log.warn(
          `workflow-gate: P4-1: invalid reason code '${options.feedback.reasonCode}' — observation skipped for ${issueId}`,
        );
      } else if (!options.feedback.fromBody) {
        // The implementer body ID must be provided (via X-Openclaw-From-Body header from
        // the CLI). Without it, from_body == reviewer_body, which produces useless data
        // for P4-2/3/4 aggregation. Skip the row rather than write garbage.
        log.warn(
          `workflow-gate: P4-1: fromBody not provided (X-Openclaw-From-Body header absent) — observation skipped for ${issueId}`,
        );
      } else {
        options.observationStore.append({
          ticket: issueId,
          workflow: workflowId,
          step: currentStateName,
          fromBody: options.feedback.fromBody,
          reviewerBody: options.bodyId ?? "unknown",
          reasonCode: validatedReason,
          freeText: options.feedback.freeText ?? null,
        });
        log.info(
          `workflow-gate: P4-1: observation recorded for ${issueId} reason=${validatedReason}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: P4-1: observation write failed for ${issueId}: ${msg}`);
    }
  }
}

/**
 * Post a summary comment on the parent ticket after a fan-out, listing
 * the created child issues.
 */
async function postFanoutSummaryComment(
  issueInternalId: string,
  result: import("./fanout.js").FanoutResult,
  authToken: string,
): Promise<void> {
  const childLinks = result.childIdentifiers.map((id) => `- ${id}`).join("\n");
  const body =
    `[Fan-out] Spawned ${result.created} child issue(s):\n${childLinks}` +
    (result.errors.length > 0
      ? `\n\n⚠️ ${result.errors.length} error(s): ${result.errors.map((e) => e.message).join("; ")}`
      : "");

  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
    });
    log.info(`workflow-gate: B-2 fan-out: summary comment posted on ${issueInternalId}`);
  } catch (err) {
    log.warn(`workflow-gate: B-2 fan-out: failed to post summary comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function issueUpdateLabels(
  internalId: string,
  labelIds: string[],
  authToken: string,
): Promise<boolean> {
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
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`workflow-gate: B2 apply: issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: B2 apply: issueUpdate failed for ${internalId}: ${msg}`);
    return false;
  }
}

/**
 * Update the delegate (assignee) of a Linear issue via a delegateId mutation.
 * Used by the auto-delegate assignment logic (AI-1463) after a state transition
 * to ensure the new state's owner body becomes the delegate.
 * Fail-open: returns false on any error, never throws.
 */
async function issueUpdateDelegate(
  internalId: string,
  delegateLinearUserId: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalId, delegateId: delegateLinearUserId } }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`workflow-gate: auto-delegate: issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: auto-delegate: issueUpdate failed for ${internalId}: ${msg}`);
    return false;
  }
}
