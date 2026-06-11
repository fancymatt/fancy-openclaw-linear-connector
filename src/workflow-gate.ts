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
import { getAgent, getAgents } from "./agents.js";
import { executeFanout, shouldTriggerFanout } from "./fanout.js";
import { onChildTerminal, isTerminalState } from "./barrier.js";
import { resolveDisposition, dispositionToDone, dispositionToSpawning } from "./review.js";
import { bindArtifact, getBoundArtifact, removeArtifact } from "./artifact-store.js";
import { recordSuccess, recordFailure, isHealthy as isConfigHealthy } from "./config-health.js";
import { captureAc, extractAcFromDescription, removeAcRecord } from "./ac-record-store.js";
import { recordImplementer, getImplementer, removeImplementer } from "./implementer-store.js";
import { recordProjection, getProjection, getAllProjections, removeProjection } from "./label-projection-store.js";

/**
 * Phase 6.5 / H-6: Label read-only projection + override path + drift reconciliation.
 *
 * **Store is the sole writer of truth.** Labels (`wf:*`, `state:*`) are a read-only projection
 * re-derived as the ticket advances; nothing in the engine reads state back out of labels.
 *
 * **Override = steward-issued proxy command.** A human who wants to move a ticket out-of-band
 * does so through a steward proxy command that updates the store and re-projects the labels
 * — a first-class transition, not a hand-edit.
 *
 * **Drift reconciliation.** A label that diverges from the store (e.g. hand-edited in the
 * Linear UI) is overwritten on the next reconcile pass and an alert is emitted. The label
 * never wins.
 *
 * **Atomic projection.** On advance, remove old `state:` and add new in one op; never two
 * `state:` labels at once.
 *
 * Design: design.md §4.2, §4.4, §4.6, §11, §13, §16.1, §16.2, and H-6.
 */

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
  /** §5.7 item 1: if true, this transition requires a bound artifact ref (e.g. sprint-plan doc). */
  requires_artifact?: boolean;
  feedback?: { required?: boolean; category_enum?: string[] };
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
  break_glass?: { command: string; to?: string; owner_role?: string };
  /** Phase 6.5 / H-7 (AI-1482): stakes-threshold configuration for human sign-off gate. */
  stakes?: StakesLevel;
  states: WorkflowState[];
}

// ── Workflow def cache ─────────────────────────────────────────────────────

let _workflowCache: WorkflowDef | null = null;

export async function loadWorkflowDef(): Promise<WorkflowDef> {
  if (_workflowCache) return _workflowCache;
  try {
    const raw = await fs.readFile(workflowDefPath(), "utf8");
    const def = yaml.load(raw) as WorkflowDef;
    if (def.break_glass && !def.break_glass.command) {
      log.warn(`workflow-gate: break_glass block in ${workflowDefPath()} has no 'command' field — falling back to hardcoded "escape". Canonicalize the YAML to add command: escape.`);
    }
    _workflowCache = def;
    recordSuccess("workflow-def");
    // AI-1490 / AI-1498: validate native_state mappings on load — hard-fail if any state
    // lacks a valid native_state (the proxy must be able to write native stateId for every
    // transition; a missing mapping is what made deployment fall through to native Invalid).
    const warnings = validateNativeStateMappings(def);
    for (const w of warnings) {
      log.error(`workflow-gate: native_state validation FAILURE: ${w}`);
    }
    if (warnings.length > 0) {
      const msg = `Workflow definition has ${warnings.length} invalid native_state mapping(s): ${warnings.join("; ")}`;
      recordFailure("workflow-def", msg);
      throw new Error(msg);
    }
    return _workflowCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure("workflow-def", msg);
    throw err;
  }
}

/** Invalidate the in-process workflow def cache (used in tests). */
export function resetWorkflowCache(): void {
  _workflowCache = null;
}

/**
 * AI-1498: Semantic-to-native mapping — mirrors the CLI's SEMANTIC_STATE_MAP
 * so the proxy can resolve native Linear stateId UUIDs without depending on the CLI.
 * Each semantic state maps to an ordered list of candidate Linear workflow state names;
 * the first match found in the team's actual states wins.
 * Keep in sync with the CLI's SEMANTIC_STATE_MAP when new semantic names are added.
 */
const SEMANTIC_STATE_MAP: Record<string, string[]> = {
  backlog: ["Backlog"],
  todo: ["Todo", "To Do", "To Develop"],
  thinking: ["Thinking", "In Progress"],
  doing: ["Doing", "In Progress", "Developing"],
  managing: ["Managing"],
  done: ["Done"],
  invalid: ["Invalid", "Canceled", "Cancelled"],
};

/**
 * Valid semantic state names that the CLI's SEMANTIC_STATE_MAP recognizes.
 * AI-1490: used to validate that every workflow state's native_state field
 * maps to a real CLI semantic state (which in turn resolves to an actual
 * Linear workflow state per team).
 */
const VALID_SEMANTIC_STATES = new Set(Object.keys(SEMANTIC_STATE_MAP));

/**
 * AI-1490 / AI-1498: Validate that every workflow state has a valid native_state field.
 * AI-1498 hardens this from warn → hard-fail for non-terminal states: a missing or
 * invalid native_state means the proxy cannot compute the native Linear stateId,
 * making desync structurally impossible. Returns an array of diagnostic errors.
 * The caller should throw when errors is non-empty for governed workflows.
 */
export function validateNativeStateMappings(def: WorkflowDef): string[] {
  const warnings: string[] = [];
  for (const state of def.states) {
    if (!state.native_state) {
      // AI-1498: hard-fail for ALL states (terminal and non-terminal).
      // A terminal state without native_state means done/escape tickets land
      // in an undefined native column — exactly the projection bugs this ticket fixes.
      warnings.push(
        `Workflow state '${state.id}' has no native_state field — its native Linear state projection is undefined. ` +
        `Add a native_state field (e.g. 'doing', 'thinking', 'todo', 'done', 'invalid').`,
      );
      continue;
    }
    if (!VALID_SEMANTIC_STATES.has(state.native_state)) {
      warnings.push(
        `Workflow state '${state.id}' has native_state '${state.native_state}' which is not a recognized semantic state. ` +
        `Valid options: ${[...VALID_SEMANTIC_STATES].join(", ")}.`,
      );
    }
  }
  return warnings;
}

// ── AI-1498: Native state resolution cache ────────────────────────────────
// Maps (teamId, semanticName) → Linear workflow state UUID.
// Resolved once per team, cached indefinitely. Invalidated on cache reset.

/** Cache: teamId → array of team workflow states from Linear API. */
let _teamStateCache: Map<string, Array<{ id: string; name: string; type: string }>> = new Map();

/** Reset the native-state cache (used in tests). */
export function resetNativeStateCache(): void {
  _teamStateCache.clear();
}

/**
 * Fetch a team's workflow states from Linear (with caching).
 * Returns the raw state nodes for the team.
 */
async function fetchTeamWorkflowStates(
  teamId: string,
  authToken: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const cached = _teamStateCache.get(teamId);
  if (cached) return cached;

  const query = `
    query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { teamId } }),
    });
    type Resp = { data?: { team?: { states?: { nodes: Array<{ id: string; name: string; type: string }> } } } };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.team?.states?.nodes ?? [];
    _teamStateCache.set(teamId, nodes);
    return nodes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: team state fetch failed for team=${teamId}: ${msg}`);
    return [];
  }
}

/**
 * AI-1498: Resolve a semantic native_state name (e.g. "doing", "done") to the actual
 * Linear workflow state UUID for the given team. Uses the same SEMANTIC_STATE_MAP
 * candidate-order resolution as the CLI so the proxy and CLI always agree.
 * Returns null if the state cannot be resolved.
 */
export async function resolveNativeStateId(
  teamId: string,
  semanticName: string,
  authToken: string,
): Promise<string | null> {
  const candidates = SEMANTIC_STATE_MAP[semanticName.toLowerCase()];
  if (!candidates) {
    log.warn(`workflow-gate: resolveNativeStateId: unknown semantic name '${semanticName}'`);
    return null;
  }
  const states = await fetchTeamWorkflowStates(teamId, authToken);
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  for (const candidate of candidates) {
    const match = states.find((s) => normalize(s.name) === normalize(candidate));
    if (match) return match.id;
  }
  log.warn(
    `workflow-gate: resolveNativeStateId: no match for '${semanticName}' (tried: ${candidates.join(", ")}) in team ${teamId}`,
  );
  return null;
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
  /** True when the context fetch itself failed (network error, API error, etc.). */
  fetchFailed: boolean;
}

/**
 * Fetch label names and delegate for a Linear issue using the caller's auth token.
 * Independent of escalation-gate's label fetch — the proxy resolves state
 * from its own query and never trusts agent-supplied values (§11).
 *
 * Phase 6.5 / H-1: Returns fetchFailed=true on error so callers can
 * decide fail-open vs fail-closed. When the fetch fails, we cannot determine
 * whether the ticket is a workflow ticket, so the caller must apply the
 * configured posture.
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
    if (!issue) {
      log.warn(`workflow-gate: issue ${issueId} not found in context fetch — returning fetchFailed`);
      return { labels: [], delegateId: null, fetchFailed: true };
    }
    return {
      labels: (issue?.labels?.nodes ?? []).map((n) => n.name),
      delegateId: issue?.delegate?.id ?? null,
      fetchFailed: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: context fetch failed for ${issueId}: ${msg}`);
    return { labels: [], delegateId: null, fetchFailed: true };
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

// ── Done gate: branch/PR verification (AI-1475 Defect 1) ─────────────────

interface BranchAndPRStatus {
  /** True when the issue has a branch that has been pushed to origin. */
  hasBranch: boolean;
  /** True when the issue has at least one associated pull request. */
  hasPR: boolean;
  /** True when the issue has at least one merged pull request. */
  hasMergedPR: boolean;
}

/**
 * Query Linear for the issue's branch and pull request status.
 * Used by the done gate (§5.6) to verify that implementation was actually
 * pushed and reviewed before allowing the terminal done transition.
 * Returns null on any error — caller decides fail-open vs fail-closed.
 */
async function fetchBranchAndPRStatus(
  issueId: string,
  authToken: string,
): Promise<BranchAndPRStatus | null> {
  const query = `
    query IssueBranchAndPR($id: String!) {
      issue(id: $id) {
        branch {
          id
          name
          updatedAt
        }
        pullRequests {
          nodes {
            id
            state
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type PRResp = {
      data?: {
        issue?: {
          branch?: { id: string; name: string; updatedAt: string } | null;
          pullRequests?: { nodes: Array<{ id: string; state: string }> };
        };
      };
    };
    const data = (await res.json()) as PRResp;
    const issue = data.data?.issue;
    if (!issue) return null;
    const prs = issue.pullRequests?.nodes ?? [];
    return {
      hasBranch: !!issue.branch?.id,
      hasPR: prs.length > 0,
      hasMergedPR: prs.some((pr) => pr.state === "merged"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: branch/PR fetch failed for ${issueId}: ${msg}`);
    return null;
  }
}

// ── Issue description fetch (AI-1482) ─────────────────────────────────────

/**
 * Fetch the description of a Linear issue.
 * Used by the verbatim AC capture to extract the AC from the description at accept time.
 * Returns an empty string on any error.
 */
async function fetchIssueDescription(issueId: string, authToken: string): Promise<{ description: string; fetchFailed: boolean }> {
  const query = `query IssueDescription($id: String!) { issue(id: $id) { description } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type DescResp = { data?: { issue?: { description?: string | null } } };
    const data = (await res.json()) as DescResp;
    const desc = data.data?.issue?.description;
    if (desc === undefined || desc === null) {
      log.warn(`workflow-gate: description fetch returned no description for ${issueId} — AC capture may be incomplete`);
      return { description: "", fetchFailed: true };
    }
    return { description: desc, fetchFailed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: description fetch failed for ${issueId}: ${msg} — AC capture will be incomplete`);
    return { description: "", fetchFailed: true };
  }
}

// ── Stakes-level resolution (AI-1482) ───────────────────────────────────────

/**
 * Resolve a ticket's numeric stakes level from its labels.
 * Checks for stakes:* labels (e.g. stakes:low, stakes:medium, stakes:high)
 * and maps them to numeric values via the workflow's stakes configuration.
 *
 * Fails closed: when no stakes label is present, returns the threshold
 * value itself — unlabeled tickets are treated as high-stakes to prevent
 * a missing label from silently bypassing the human sign-off gate.
 * When the label is present but maps to an unknown level, also returns
 * the threshold (fail-closed on unknown metadata).
 */
export function resolveStakesLevel(labels: string[], stakesConfig: StakesLevel): number {
  const stakesLabel = labels.find((l) => /^stakes:/i.test(l));
  if (!stakesLabel) {
    log.warn(`workflow-gate: resolveStakesLevel: no stakes:* label found — failing closed (defaulting to threshold ${stakesConfig.threshold})`);
    return stakesConfig.threshold; // fail closed: unlabeled = high stakes
  }
  const level = stakesConfig.levels[stakesLabel];
  if (level === undefined) {
    log.warn(`workflow-gate: resolveStakesLevel: unknown stakes label '${stakesLabel}' — failing closed (defaulting to threshold ${stakesConfig.threshold})`);
    return stakesConfig.threshold; // fail closed: unknown level = high stakes
  }
  return level;
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
  callerLinearUserId?: string | null,
  artifactRef?: string | null,
  breakGlassOverride: boolean = false,
): Promise<string | null> {
  // TODO(AI-1347): fail-open on missing issueId is a Layer A carry-forward.
  // Harden by deriving issueId from the request body when headers are absent.
  if (!issueId) return null;

  const { labels, delegateId, fetchFailed } = await fetchTicketContext(issueId, authToken);

  // Phase 6.5 / H-1: Fail-closed on context-fetch failure.
  // When we can't fetch the ticket's labels, we cannot determine whether
  // it's a workflow ticket. If the caller explicitly set an intent header
  // (signaling they believe this is a workflow command), fail closed.
  // Break-glass override bypasses this check.
  if (fetchFailed && !breakGlassOverride) {
    // Safety: begin-work and note pass through even on fetch failure because:
    //   - begin-work on an ad-hoc ticket is harmless (labels are empty → getWorkflowId
    //     returns null → pass-through below), and it's the only way to add a wf:*
    //     label to start workflowing a ticket.
    //   - note is informational-only and never mutates state, so allowing it through
    //     is safe even if we can't verify workflow membership.
    // All other intents are rejected because they would mutate workflow state without
    //     being able to validate the move.
    const looksLikeWorkflowCommand = intent !== "begin-work" && intent !== "note";
    if (looksLikeWorkflowCommand) {
      log.error(`workflow-gate: FAIL-CLOSED — context fetch failed for ${issueId}, cannot determine if workflow ticket — rejecting '${intent}'`);
      return (
        `[Proxy] '${intent}' blocked: unable to fetch ticket context for ${issueId}. ` +
        `Cannot determine workflow state — failing closed for safety. ` +
        `A steward can use break-glass to bypass this check.`
      );
    }
  }

  // §4.6 mode switch: ad-hoc tickets (no wf:* label) are full pass-through.
  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null;

  // ── Phase 6.5 / H-1: Fail-closed on config-load failure (§16.0) ──────
  if (!breakGlassOverride && !isConfigHealthy()) {
    log.error(`workflow-gate: config-health FAIL-CLOSED — rejecting '${intent}' on wf:${workflowId} ticket ${issueId} because config is degraded`);
    return (
      `[Proxy] '${intent}' blocked: config artifacts are degraded and enforcement cannot be trusted. ` +
      `A steward can use break-glass (--break-glass flag or X-Openclaw-Break-Glass header) to bypass this check.`
    );
  }

  let def: WorkflowDef;
  try {
    def = await loadWorkflowDef();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Phase 6.5 / H-1: FAIL CLOSED on workflow def load failure (§16.0).
    if (breakGlassOverride) {
      log.warn(`workflow-gate: workflow def load failed but break-glass override active — allowing through: ${msg}`);
      return null;
    }
    log.error(`workflow-gate: FAIL-CLOSED — workflow def load failed, rejecting '${intent}' on wf:${workflowId} ticket ${issueId}: ${msg}`);
    return (
      `[Proxy] '${intent}' blocked: workflow definition could not be loaded (${msg}). ` +
      `A steward can use break-glass to bypass this check.`
    );
  }

  // Only enforce for the workflow whose def is loaded; others fail open.
  if (workflowId !== def.id) return null;

  // §5.3 Asymmetry enforcement: children running wf:dev-impl have no legal
  // command to address the parent's ux-audit workflow. This is structural:
  //   - The dev-impl workflow def has no 'address-parent' or 'barrier-signal' command.
  //   - Layer 2 (checkRawMutationInterception) blocks raw label/state mutations.
  //   - The proxy only validates against the loaded workflow def.
  // AC3 (B-3): Children cannot address the parent — enforced by the absence of
  // any upward-directed command in the dev-impl state machine.

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

  // Phase 6.5 / H-6: Read authoritative state from the connector-side store.
  // The store is the sole writer of truth; labels are a read-only projection.
  // Falls back to label-based state for tickets not yet in the store
  // (bootstrapping: tickets created before H-6 deployment).
  let currentState: string | null;
  const storedProjection = await getProjection(issueId);
  if (storedProjection && storedProjection.workflowId === workflowId) {
    const labelState = getCurrentState(labels);
    if (labelState && labelState !== storedProjection.stateName) {
      log.warn(
        `workflow-gate: H-6 drift on ${issueId}: store='${storedProjection.stateName}', label='${labelState}' — store wins; reconciler will repair label`,
      );
    }
    currentState = storedProjection.stateName;
  } else {
    currentState = getCurrentState(labels);
  }

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
    // A governed wf:dev-impl ticket enters at entry_state with a state:* label applied
    // atomically; a missing label means the projection was corrupted (e.g. a label-stripping
    // CLI verb ran). Previously this failed OPEN — allowing ANY intent, including a deploy
    // that bypasses the Done gate (§5.6). That is exactly how a ticket reached terminal without
    // a pushed branch/PR. Fail CLOSED for all state-advancing intents: the only legal moves on a
    // state-corrupted ticket are the recovery hatches already handled above — 'escape'
    // (break-glass, line ~467), 'refuse-work' (line ~474), and 'needs-human'. The steward must
    // re-establish state (re-accept) to resume the workflow.
    log.warn(`workflow-gate: no state:* label on ${issueId} — blocking '${intent}' (state corrupted; use escape/needs-human or re-accept)`);
    return (
      `[Proxy] '${intent}' blocked: ${issueId} has no 'state:*' workflow label — its workflow state cannot be determined ` +
      `(the projection was likely stripped by a raw mutation or a label-stripping command). ` +
      `Re-establish state via the steward ('accept'), or use '${breakGlassCommand}' to exit the workflow.`
    );
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

  // §5.7 item 1 / C-2: Artifact-binding gate.
  // If the transition requires an artifact (requires_artifact: true), the caller
  // must supply an artifact ref via the X-Openclaw-Artifact-Ref header.
  // The engine refuses the transition if no artifact is bound — freehand scope
  // has no command (this is the F1 structural kill at the source for Archetype C).
  if (match.requires_artifact && !artifactRef) {
    log.warn(`workflow-gate: artifact gate: ${intent} on ${issueId} requires a bound artifact — none provided`);
    return (
      `[Proxy] '${intent}' requires a bound sprint-plan artifact. ` +
      `Provide a sprint-plan doc reference via the --artifact-ref flag (or X-Openclaw-Artifact-Ref header). ` +
      `Example: ai-systems/projects/<project>/sprints/<sprint-plan>.md`
    );
  }

  // Phase 6.5 / H-7 (AI-1482): Stakes-threshold sign-off gate.
  // If the transition has requires_human_signoff_above_stakes: true and the
  // ticket's stakes level meets or exceeds the workflow's threshold, the deploy
  // must come from a human (Matt), not an AI agent. An AI agent cannot both
  // author the spec and bless its fulfillment on consequential work.
  // A body is considered an AI agent if it is registered in the capability
  // policy (known body = AI agent). Unknown bodies are assumed human.
  if (match.requires_human_signoff_above_stakes && def.stakes) {
    const ticketStakesLevel = resolveStakesLevel(labels, def.stakes);
    if (ticketStakesLevel >= def.stakes.threshold) {
      // A body known in the capability policy is an AI agent; unknown = human
      const isAgent = await isBodyKnown(bodyId);
      if (isAgent) {
        log.warn(`workflow-gate: stakes-threshold gate: ${intent} on ${issueId} blocked — stakes level ${ticketStakesLevel} >= threshold ${def.stakes.threshold}, caller '${bodyId}' is a known AI agent`);
        return (
          `[Proxy] '${intent}' blocked: this ticket has elevated stakes (level ${ticketStakesLevel}) ` +
          `and requires human sign-off. AI agent '${bodyId}' cannot self-sign-off on high-stakes work. ` +
          `Use 'escape' to exit the workflow and escalate to a human, or 'reject' to send back for changes.`
        );
      }
      log.info(`workflow-gate: stakes-threshold gate: ${intent} on ${issueId} — stakes level ${ticketStakesLevel} >= threshold ${def.stakes.threshold}, but caller '${bodyId}' is human/unknown — allowing`);
    }
  }

  // Resolve destination state for subsequent gates.
  const destStateNode = def.states.find((s) => s.id === match.to);

  // AI-1475 Defect 1 + AI-1492 + AI-1497: Done gate (§5.6) — terminal 'done' requires
  // evidence of merged PR. A wf:dev-impl ticket must not reach terminal done without
  // evidence that the implementation was pushed, reviewed, and merged.
  // Only applies to the deploy command (dev-impl workflow: deployment → done).
  // Other workflows (ux-audit) have their own gate paths (parent-AC gate).
  //
  // AI-1492 fix: A merged PR satisfies the gate even when the source branch was
  // auto-deleted by GitHub after a squash merge.
  //
  // AI-1497 fix: When branch+PR data are completely absent (both false), this is
  // indistinguishable from a successfully-merged ticket whose data was lost to
  // auto-delete. Since the ticket is in 'deployment' state (reachable only after
  // code-review approval), fail-open rather than stranding the ticket. Only block
  // when partial evidence exists (has branch but no PR = pushed but never reviewed).
  // Also fail-open on null (transient API failure) after one retry.
  if (intent === 'deploy' && destStateNode?.kind === 'terminal' && match.to === 'done') {
    let branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    // AI-1497: retry once on null — transient Linear API failure during
    // Hanzo merge+deploy quick succession.
    if (!branchStatus) {
      await new Promise((r) => setTimeout(r, 1000));
      branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    }
    if (!branchStatus) {
      // Two consecutive nulls — transient API failure. Fail-open to avoid
      // stranding tickets; deployment state is already past code review.
      log.warn(`workflow-gate: done gate: could not verify branch/PR status for ${issueId} after retry — failing open`);
    } else if (branchStatus.hasMergedPR) {
      log.info(`workflow-gate: done gate: ${issueId} passed (merged PR confirmed)`);
    } else if (!branchStatus.hasBranch && !branchStatus.hasPR) {
      // AI-1497: Complete absence of evidence — likely lost to auto-delete.
      // Fail-open: a ticket in deployment state has already passed code review,
      // so the PR almost certainly existed and was merged.
      log.info(`workflow-gate: done gate: ${issueId} passed (no branch/PR evidence — treating as merged, data likely lost to auto-delete)`);
    } else {
      // Partial evidence exists (has branch but no PR, or similar).
      // Block: affirmative evidence that review was not completed.
      const missing: string[] = [];
      if (!branchStatus.hasBranch) missing.push('branch not pushed to origin');
      if (!branchStatus.hasPR) missing.push('no pull request associated');
      if (missing.length > 0) {
        log.warn(`workflow-gate: done gate: ${issueId} blocked — ${missing.join('; ')}`);
        return (
          `[Proxy] 'deploy' blocked: cannot reach terminal done. Missing: ${missing.join('; ')}. ` +
          `Push the branch and open a pull request before deploying.`
        );
      }
      log.info(`workflow-gate: done gate: ${issueId} passed (has branch + PR, not yet merged)`);
    }
  }

  // Assignment target validation (§4.3, §16.1)
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
  /** §5.7 item 1 / C-2: artifact ref to bind at intake.accept (sprint-plan doc path). */
  artifactRef?: string | null;
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
    // H-6: remove from projection store — ticket leaves the workflow.
    await removeProjection(issueId).catch((err: unknown) => {
      log.warn(`workflow-gate: H-6: removeProjection failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }

  // ── Idempotency check (AI-1490 hardened) ────────────────────────────────
  // If the ticket is already in the target state, verify the state:* label
  // is actually present. If it's missing (CLI partial failure, race condition),
  // re-stamp it. Previously this was a blind no-op, which meant a lost label
  // would never be recovered.
  if (currentStateName === toStateName) {
    const targetLabelName = `state:${toStateName}`;
    const hasTargetLabel = issue.labels.some((l) => l.name === targetLabelName);
    if (hasTargetLabel) {
      log.info(
        `workflow-gate: B2 apply: ${issueId} already in state '${toStateName}' with label present — no-op`,
      );
      return;
    }
    // Label is missing despite being in the correct state — re-stamp.
    log.warn(
      `workflow-gate: B2 apply: ${issueId} is in state '${toStateName}' but label '${targetLabelName}' is missing — re-stamping`,
    );
    const newLabelId = await findOrCreateLabel(
      issue.teamId,
      targetLabelName,
      authToken,
    );
    if (!newLabelId) {
      log.warn(`workflow-gate: B2 apply: could not create label '${targetLabelName}' for re-stamp on ${issueId} — skipping`);
      return;
    }
    // Remove any stale state:* labels and add the correct one.
    const cleanedLabelIds = issue.labels
      .filter((l) => !l.name.startsWith("state:"))
      .map((l) => l.id);
    cleanedLabelIds.push(newLabelId);
    const applied = await issueUpdateLabels(issue.internalId, cleanedLabelIds, authToken);
    if (applied) {
      log.info(`workflow-gate: B2 apply: ${issueId} re-stamped label '${targetLabelName}'`);
    }
    return;
  }

  // ── AI-1475 Defect 1 + AI-1492 + AI-1497: Done gate defense-in-depth (§5.6) ─
  // Block the label swap to done if the branch/PR gate is not satisfied.
  // This is defense-in-depth: checkWorkflowRules is the primary gate, but
  // applyStateTransition also blocks to prevent any bypass path.
  // Only applies when intent is 'deploy' (dev-impl workflow: deployment → done).
  //
  // AI-1492: A merged PR satisfies the gate even without a branch (auto-deleted
  // after squash merge).
  //
  // AI-1497: Fail-open on null (after retry) and on complete absence of evidence
  // (no branch + no PR). Only block on partial evidence (branch exists but no PR).
  if (intent === 'deploy' && toStateName === 'done') {
    let branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    if (!branchStatus) {
      await new Promise((r) => setTimeout(r, 1000));
      branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    }
    const hasMergedPR = branchStatus?.hasMergedPR === true;
    const hasBranchAndPR = branchStatus?.hasBranch && branchStatus?.hasPR;
    const noEvidenceAtAll = branchStatus && !branchStatus.hasBranch && !branchStatus.hasPR;
    if (!hasMergedPR && !hasBranchAndPR && !noEvidenceAtAll) {
      // Block: either null after retry (branchStatus is null → noEvidenceAtAll is false)
      // or partial evidence (has branch but no PR).
      // But AI-1497: if null after retry, fail-open instead of blocking.
      if (!branchStatus) {
        log.warn(`workflow-gate: B2 apply: done gate could not verify status for ${issueId} after retry — failing open`);
      } else {
        const missing: string[] = [];
        if (!branchStatus.hasBranch) missing.push('branch not pushed to origin');
        if (!branchStatus.hasPR) missing.push('no pull request associated');
        log.warn(`workflow-gate: B2 apply: done gate blocked for ${issueId} — ${missing.join('; ')}`);
        return; // Block the transition
      }
    } else if (noEvidenceAtAll) {
      log.info(`workflow-gate: B2 apply: done gate for ${issueId} — no branch/PR evidence, treating as merged (AI-1497 fail-open)`);
    }
  }

  // ── Phase 5 / B-4: Parent-AC gate for review → done (F2b, §5.6) ─────
  // Before the atomic label swap, check if this is a review → done transition
  // on a ux-audit ticket. If so, the parent-AC gate must pass (§5.6): the
  // parent's own AC is verified, not the sum of children.
  // Fail-closed: if the AC gate cannot be evaluated (description fetch error),
  // block the transition to prevent premature done.
  const disposition = resolveDisposition(workflowId, currentStateName, intent);
  if (disposition === "done") {
    try {
      log.info(`workflow-gate: B-4 review: evaluating parent-AC gate for ${issueId} (review → done)`);
      const acResult = await dispositionToDone(issueId, authToken);
      if (!acResult.applied) {
        log.warn(`workflow-gate: B-4 review: → done blocked for ${issueId}: ${acResult.error ?? "unknown"}`);
        return; // Block the transition — AC gate failed
      }
      // AC gate passed and dispositionToDone already applied the label swap + comment.
      // Skip the normal atomic swap below — dispositionToDone handled it.
      log.info(`workflow-gate: B-4 review: ${issueId} review → done (parent AC satisfied)`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-4 review: parent-AC gate failed for ${issueId}: ${msg} — blocking transition`);
      return;
    }
  }

  if (disposition === "spawning") {
    try {
      log.info(`workflow-gate: B-4 review: disposition → spawning for ${issueId} (follow-up gaps)`);
      const spawnResult = await dispositionToSpawning(issueId, authToken);
      if (!spawnResult.applied) {
        log.warn(`workflow-gate: B-4 review: → spawning failed for ${issueId}: ${spawnResult.error ?? "unknown"}`);
        // Fall through to normal transition — it'll go to spawning via the standard path
      } else {
        // dispositionToSpawning applied the label swap + comment.
        log.info(`workflow-gate: B-4 review: ${issueId} review → spawning (follow-up)`);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-4 review: → spawning failed for ${issueId}: ${msg}`);
      // Fall through to normal transition
    }
  }

  // ── §5.7 item 1 / C-2: Sprint artifact gate at validating → done ────
  // For the sprint workflow, the approve transition from validating to done
  // requires that the artifact bound at intake is still present.
  // This is the §5.6 gate inherited from B-4, adapted for sprint: the
  // validating gate reads the bound artifact as the parent AC source.
  if (workflowId === "sprint" && currentStateName === "validating" && intent === "approve") {
    const artifact = getBoundArtifact(issueId);
    if (!artifact) {
      log.warn(`workflow-gate: C-2: sprint artifact gate: ${issueId} validating → done blocked — no bound artifact`);
      // Post a diagnostic comment
      const internalId = issue.internalId;
      const mutation = `
        mutation($issueId: ID!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }
      `;
      const commentBody =
        `[Artifact Gate] Cannot advance to **done** — no sprint-plan artifact is bound. ` +
        `The sprint workflow requires a sprint-plan document to be bound at intake before the validating gate can pass.`;
      try {
        await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authToken },
          body: JSON.stringify({ query: mutation, variables: { issueId: internalId, body: commentBody } }),
        });
      } catch (commentErr) {
        log.warn(`workflow-gate: C-2: failed to post diagnostic comment for ${issueId}: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`);
      }
      return; // Block the transition
    }
    log.info(`workflow-gate: C-2: sprint artifact gate: ${issueId} artifact '${artifact.ref}' present — allowing validating → done`);
  }

  // ── Phase 6.5 / H-7 (AI-1482): Verbatim AC capture at accept ──────────
  // When the accept transition has capture_ac: true, extract the verbatim AC
  // from the issue description and store it as the immutable AC of record.
  // This closes the gap where Ai's paraphrase silently becomes the de-facto spec.
  if (matchedTransition?.capture_ac && intent === 'accept') {
    try {
      const { description, fetchFailed } = await fetchIssueDescription(issueId, authToken);
      if (fetchFailed) {
        log.warn(`workflow-gate: H-7: description fetch failed for ${issueId} — AC capture skipped, delivery message will note incomplete capture`);
        // Continue with the transition but note that AC capture was incomplete
      } else {
        const verbatimAc = extractAcFromDescription(description);
        if (verbatimAc) {
          await captureAc(issueId, {
            verbatimAc,
            capturedAt: new Date().toISOString(),
            capturedBy: options?.bodyId ?? 'unknown',
            source: 'description',
          });
          log.info(`workflow-gate: H-7: captured verbatim AC for ${issueId} (${verbatimAc.length} chars)`);
        } else {
          log.warn(`workflow-gate: H-7: no AC section header found in description for ${issueId} — AC capture skipped (description has no '### Acceptance' or '### AC' section)`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: H-7: AC capture failed for ${issueId}: ${msg}`);
    }
  }

  // ── AI-1493: Pre-compute full transition tuple (atomic + fail-closed) ──
  // Before any mutation, resolve ALL facets: {label swap, delegate}.
  // If any facet cannot be resolved for deterministic transitions, fail CLOSED.

  // Step 1: Resolve label IDs for the state swap.
  const oldLabel = issue.labels.find((l) => l.name === `state:${currentStateName}`);
  if (!oldLabel) {
    log.error(
      `workflow-gate: B2 apply: FAIL-CLOSED — could not find label id for state:${currentStateName} on ${issueId}. Transition aborted.`,
    );
    return;
  }

  const newLabelId = await findOrCreateLabel(
    issue.teamId,
    `state:${toStateName}`,
    authToken,
  );
  if (!newLabelId) {
    log.error(
      `workflow-gate: B2 apply: FAIL-CLOSED — could not resolve label id for state:${toStateName}. Transition aborted.`,
    );
    return;
  }

  const newLabelIds = [
    ...issue.labels.filter((l) => l.id !== oldLabel.id).map((l) => l.id),
    newLabelId,
  ];

  // Step 2: Resolve the next delegate.
  // AI-1493: Deterministic owner-routing for ALL transitions.
  const destStateNode = def.states.find((s) => s.id === toStateName);
  const destOwnerRole = destStateNode?.owner_role;
  const isTerminal = destStateNode?.kind === 'terminal' || !destOwnerRole;
  let resolvedDelegateId: string | null | undefined = undefined;

  if (isTerminal) {
    resolvedDelegateId = null;
  } else {
    // Deterministic routing for reject / request-changes (back to implementation).
    if ((intent === 'reject' || intent === 'request-changes') && toStateName === 'implementation') {
      const priorImplementer = await getImplementer(issueId);
      if (priorImplementer) {
        const agent = getAgent(priorImplementer);
        if (agent?.linearUserId) {
          resolvedDelegateId = agent.linearUserId;
          log.info(
            `workflow-gate: B2 apply: ${issueId} ${intent} → implementation, routing to prior implementer '${priorImplementer}'`,
          );
        } else {
          log.error(
            `workflow-gate: B2 apply: FAIL-CLOSED — prior implementer '${priorImplementer}' has no linearUserId. Cannot route ${intent} on ${issueId}.`,
          );
          return;
        }
      } else {
        log.warn(
          `workflow-gate: B2 apply: no prior implementer recorded for ${issueId} on ${intent} — falling back to role resolution`,
        );
      }
    }

    // Role-based resolution (singleton auto-assign, multi-body skip).
    if (resolvedDelegateId === undefined) {
      try {
        const roleBodies = await resolveBodiesForRole(destOwnerRole!);
        if (roleBodies.length === 1) {
          const agent = getAgent(roleBodies[0]);
          if (agent?.linearUserId) {
            resolvedDelegateId = agent.linearUserId;
          } else {
            log.warn(
              `workflow-gate: B2 apply: singleton body '${roleBodies[0]}' for role '${destOwnerRole}' has no linearUserId — skipping auto-delegate`,
            );
          }
        } else if (roleBodies.length > 1) {
          // AI-1493 review fix: fail-closed for reject/request-changes when no prior implementer.
          // Multi-body roles on these intents MUST have a resolved delegate — silently
          // skipping leaves the ticket owner-less, which violates AC.
          if (intent === 'reject' || intent === 'request-changes') {
            log.error(
              `workflow-gate: B2 apply: FAIL-CLOSED — multi-body role '${destOwnerRole}' on '${intent}' with no prior implementer. Cannot auto-resolve delegate for ${issueId}. Use --target.`,
            );
            return;
          }
          log.info(
            `workflow-gate: B2 apply: ${issueId} multi-body role '${destOwnerRole}' (${roleBodies.join(", ")}) — delegate set by CLI target, skipping proxy auto-assign`,
          );
        } else {
          if (intent === 'approve' || intent === 'reject') {
            log.error(
              `workflow-gate: B2 apply: FAIL-CLOSED — no bodies found for role '${destOwnerRole}' on '${intent}'. Transition aborted per AI-1493.`,
            );
            return;
          }
          log.warn(
            `workflow-gate: B2 apply: no bodies found for role '${destOwnerRole}' on '${intent}' — skipping auto-delegate`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `workflow-gate: B2 apply: FAIL-CLOSED — role resolution failed for '${destOwnerRole}': ${msg}. Transition aborted.`,
        );
        return;
      }
    }
  }

  // Step 3: Record implementer BEFORE the mutation.
  if (toStateName === 'implementation' && resolvedDelegateId) {
    const agents = getAgents();
    const implementerAgent = agents.find(a => a.linearUserId === resolvedDelegateId);
    if (implementerAgent) {
      await recordImplementer(issueId, implementerAgent.name, workflowId);
      log.info(
        `workflow-gate: B2 apply: recorded implementer '${implementerAgent.name}' for ${issueId}`,
      );
    } else if (options?.bodyId) {
      await recordImplementer(issueId, options.bodyId, workflowId);
      log.info(
        `workflow-gate: B2 apply: recorded implementer from bodyId '${options.bodyId}' for ${issueId}`,
      );
    }
  }

  // Step 4 (AI-1498): Resolve native stateId from YAML native_state field.
  // The proxy is now the SOLE writer of all three facets: label, delegate, AND native state.
  // Fail-closed: if the destination state has a native_state field but we can't resolve
  // the Linear stateId, abort the transition (this is the structural guarantee that
  // prevents desync).
  let resolvedNativeStateId: string | null | undefined = undefined;
  const destNativeState = destStateNode?.native_state;
  if (destNativeState) {
    const stateId = await resolveNativeStateId(issue.teamId, destNativeState, authToken);
    if (!stateId) {
      log.error(
        `workflow-gate: B2 apply: FAIL-CLOSED — could not resolve native stateId for '${destNativeState}' on team ${issue.teamId}. Transition aborted.`,
      );
      return;
    }
    resolvedNativeStateId = stateId;
    log.info(
      `workflow-gate: B2 apply: resolved native_state '${destNativeState}' → stateId=${stateId} for ${issueId}`,
    );
  } else if (destStateNode) {
    // State exists but has no native_state — this should have been caught at load-time
    // validation (AI-1498 hard-fail). If we somehow reach here, fail-closed.
    log.error(
      `workflow-gate: B2 apply: FAIL-CLOSED — destination state '${toStateName}' has no native_state field. Transition aborted.`,
    );
    return;
  }

  // Step 5: Apply the FULL transition atomically (labels + delegate + native state in one mutation).
  const applied = await issueUpdateAtomic(
    issue.internalId,
    newLabelIds,
    authToken,
    resolvedDelegateId,
    resolvedNativeStateId,
  );

  if (applied) {
    log.info(
      `workflow-gate: B2 apply: ${issueId} state:${currentStateName} → state:${toStateName}` +
      (resolvedDelegateId != null ? ` delegate=${resolvedDelegateId}` : resolvedDelegateId === null ? ` delegate=cleared` : ``) +
      (resolvedNativeStateId ? ` native=${destNativeState}(${resolvedNativeStateId})` : ``),
    );
    // H-6: record authoritative state in the projection store.
    await recordProjection(issueId, workflowId, toStateName).catch((err: unknown) => {
      log.warn(`workflow-gate: H-6: recordProjection failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    log.error(
      `workflow-gate: B2 apply: atomic mutation FAILED for ${issueId} — all facets rolled back (no partial state)`,
    );
    return;
  }

  // ── §5.7 item 1 / C-2: Artifact-binding recording ────────────────────
  if (matchedTransition?.requires_artifact && options?.artifactRef) {
    try {
      bindArtifact(issueId, {
        ref: options.artifactRef,
        boundAt: new Date().toISOString(),
        boundBy: options.bodyId ?? "unknown",
      });
      log.info(
        `workflow-gate: C-2: artifact bound for ${issueId}: '${options.artifactRef}'`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: C-2: artifact bind failed for ${issueId}: ${msg}`);
    }
  }

  // Clean up artifact binding and implementer record on escape/demote
  if (toStateName === "escape" || toStateName === "__ad_hoc__") {
    removeArtifact(issueId);
    await removeAcRecord(issueId);
  }
  // Clean up implementer record on terminal states
  if (isTerminal) {
    await removeImplementer(issueId);
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

  // ── Phase 5 / B-3: Barrier (N→1) — event-driven parent auto-advance ─
  // After a successful state transition to a terminal state (done, escape),
  // fire the barrier check to see if the parent should auto-advance from
  // managing → review. The barrier module handles the full evaluation:
  // fetch parent, check all children, transition if ready.
  // Fail-open: barrier errors are logged and never block the transition.
  if (applied && isTerminalState(toStateName)) {
    try {
      log.info(`workflow-gate: B-3 barrier: child ${issueId} reached terminal state '${toStateName}' — checking parent barrier`);
      const barrierResult = await onChildTerminal(issueId, authToken);
      if (barrierResult?.transitioned) {
        log.info(
          `workflow-gate: B-3 barrier: parent auto-advanced managing → review via ${issueId}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-3 barrier check failed for ${issueId}: ${msg}`);
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

/**
 * AI-1493: Atomic issue update — sets labels AND delegate in a single mutation.
 * This replaces the separate issueUpdateLabels + issueUpdateDelegate calls
 * so the transition is all-or-nothing: either the full tuple lands or nothing does.
 *
 * @param delegateId - Linear user ID for the new delegate, or null to skip delegate update.
 */
async function issueUpdateAtomic(
  internalId: string,
  labelIds: string[],
  authToken: string,
  delegateId?: string | null,
  nativeStateId?: string | null,
): Promise<boolean> {
  // Build the mutation input: include delegateId when explicitly set (string or null to clear).
  // undefined means "don't touch delegate". null means "clear delegate".
  // AI-1498: include nativeStateId when explicitly set — the proxy writes ALL three facets
  // (label, delegate, native state) in a single mutation.
  const hasDelegate = delegateId !== undefined;
  const hasStateId = nativeStateId !== undefined;

  const inputParts: string[] = ["labelIds: $labelIds"];
  if (hasDelegate) inputParts.push("delegateId: $delegateId");
  if (hasStateId) inputParts.push("stateId: $stateId");

  const mutation = `
    mutation ApplyAtomicTransition($issueId: String!, $labelIds: [String!]!${hasDelegate ? ", $delegateId: String" : ""}${hasStateId ? ", $stateId: String" : ""}) {
      issueUpdate(id: $issueId, input: { ${inputParts.join(", ")} }) {
        success
      }
    }
  `;
  const variables: Record<string, unknown> = { issueId: internalId, labelIds };
  if (hasDelegate) variables.delegateId = delegateId;
  if (hasStateId) variables.stateId = nativeStateId;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`workflow-gate: atomic issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: atomic issueUpdate failed for ${internalId}: ${msg}`);
    return false;
  }
}

/**
 * Legacy label-only update, kept for non-atomic paths (ad_hoc demote, re-stamp).
 */
async function issueUpdateLabels(
  internalId: string,
  labelIds: string[],
  authToken: string,
): Promise<boolean> {
  return issueUpdateAtomic(internalId, labelIds, authToken);
}

/**
/**
 * Update only the delegate (for cases where the atomic label+delegate path
 * is not needed). Delegates to issueUpdateAtomic with empty label behavior.
 * Used by the auto-delegate assignment logic (AI-1463) after a state transition
 * to ensure the new state's owner body becomes the delegate.
 * Fail-open: returns false on any error, never throws.
 */
async function issueUpdateDelegateOnly(
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
      log.warn(`workflow-gate: delegate-only issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: delegate-only issueUpdate failed for ${internalId}: ${msg}`);
    return false;
  }
}

// ── Phase 6.5 / H-6: Drift reconciliation ────────────────────────────────

/**
 * A single drift entry detected during reconciliation.
 */
export interface DriftEntry {
  issueId: string;
  storedState: string;
  labelState: string | null;
  repaired: boolean;
}

/**
 * Result of a reconcileLabelDrift run.
 */
export interface ReconcileResult {
  checked: number;
  drifted: number;
  repaired: number;
  errors: number;
  details: DriftEntry[];
}

/**
 * Phase 6.5 / H-6: Drift reconciliation.
 *
 * Iterates all tickets tracked in the label-projection store, fetches their
 * current state:* label from Linear, and repairs any that diverge from the
 * stored authoritative state. The label never wins: when a human hand-edits
 * a state:* label in the Linear UI, the next reconcile pass overwrites it
 * with the store value and fires an alert.
 *
 * Called periodically (cron job) or on-demand by a steward.
 * Fail-open: individual ticket errors increment the errors counter and are
 * logged, but never abort the full run.
 *
 * @param authToken - Linear API token for fetching and writing labels.
 * @param alertFn   - Optional override for alert emission (default: log.error).
 */
export async function reconcileLabelDrift(
  authToken: string,
  alertFn?: (msg: string) => void,
): Promise<ReconcileResult> {
  const projections = await getAllProjections();
  const result: ReconcileResult = {
    checked: projections.size,
    drifted: 0,
    repaired: 0,
    errors: 0,
    details: [],
  };

  const alert = alertFn ?? ((msg: string) => log.error(`workflow-gate: H-6 DRIFT ALERT: ${msg}`));

  for (const [issueId, projection] of projections) {
    try {
      const labels = await fetchWorkflowLabels(issueId, authToken);
      const labelState = getCurrentState(labels);

      if (labelState === projection.stateName) continue; // no drift

      result.drifted++;
      const detail: DriftEntry = {
        issueId,
        storedState: projection.stateName,
        labelState,
        repaired: false,
      };

      alert(
        `ticket ${issueId}: store=${projection.stateName}, label=${labelState ?? "(none)"} — overwriting label with store value`,
      );

      // Re-project: fetch full label set, swap state:* back to store value.
      const issue = await fetchIssueWithLabels(issueId, authToken);
      if (!issue) {
        log.warn(`workflow-gate: H-6 reconcile: could not fetch labels for ${issueId} — skipping repair`);
        result.errors++;
        result.details.push(detail);
        continue;
      }

      const newLabelId = await findOrCreateLabel(
        issue.teamId,
        `state:${projection.stateName}`,
        authToken,
      );
      if (!newLabelId) {
        log.warn(
          `workflow-gate: H-6 reconcile: could not find/create label state:${projection.stateName} for ${issueId} — skipping repair`,
        );
        result.errors++;
        result.details.push(detail);
        continue;
      }

      // Replace all state:* labels with the authoritative one.
      const cleanedIds = issue.labels
        .filter((l) => !l.name.startsWith("state:"))
        .map((l) => l.id);
      cleanedIds.push(newLabelId);

      const repaired = await issueUpdateLabels(issue.internalId, cleanedIds, authToken);
      detail.repaired = repaired;
      if (repaired) {
        result.repaired++;
        log.info(
          `workflow-gate: H-6 reconcile: repaired ${issueId} label → state:${projection.stateName}`,
        );
      } else {
        result.errors++;
        log.warn(`workflow-gate: H-6 reconcile: label repair mutation failed for ${issueId}`);
      }

      result.details.push(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: H-6 reconcile: error processing ${issueId}: ${msg}`);
      result.errors++;
    }
  }

  return result;
}
