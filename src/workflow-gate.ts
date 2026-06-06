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
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { bodyHasCapability } from "./escalation-gate.js";

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

/**
 * Fetch label names for a Linear issue using the caller's auth token.
 * Independent of escalation-gate's label fetch — the proxy resolves state
 * from its own query and never trusts agent-supplied values (§11).
 * Returns an empty array on any error — enforcement fails open.
 */
async function fetchTicketLabels(issueId: string, authToken: string): Promise<string[]> {
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
    type LabelResp = { data?: { issue?: { labels?: { nodes: Array<{ name: string }> } } } };
    const data = (await res.json()) as LabelResp;
    return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
  } catch (err) {
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
 */
export async function checkWorkflowRules(
  intent: string,
  issueId: string | null,
  authToken: string,
  bodyId: string
): Promise<string | null> {
  // TODO(AI-1347): fail-open on missing issueId is a Layer A carry-forward.
  // Harden by deriving issueId from the request body when headers are absent.
  if (!issueId) return null;

  const labels = await fetchTicketLabels(issueId, authToken);

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

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  // §4.4: break-glass escape is legal from every state — never block it.
  if (intent === breakGlassCommand) return null;

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

  return null;
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
export async function applyStateTransition(
  intent: string,
  issueId: string | null,
  authToken: string,
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

  if (intent === breakGlassCommand) {
    toStateName = def.break_glass?.to ?? "escape";
  } else {
    const stateNode = def.states.find((s) => s.id === currentStateName);
    const transition = stateNode?.transitions?.find((t) => t.command === intent);
    if (!transition) {
      // Should not happen — B1 already validated the command — but fail-open.
      log.warn(
        `workflow-gate: B2 apply: no transition for '${intent}' in state '${currentStateName}' on ${issueId} — skipping`,
      );
      return;
    }
    toStateName = transition.to;
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
