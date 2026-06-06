/**
 * Phase 3 / B1 — Workflow-def-driven inbound command validation (AI-1352).
 *
 * Generalizes the Phase 2 single-rule escalation-gate (escalation-gate.ts) into
 * a full legal-move validator driven by the workflow definition YAML. The rule
 * table in the escalation-gate is superseded by this data-driven approach for
 * workflow tickets; both checks run in proxy.ts (defense in depth).
 *
 * For workflow tickets (wf:*):
 *   1. Resolves the ticket's current state from its state:* label via an independent
 *      Linear query — the proxy NEVER trusts agent-supplied state (§11).
 *   2. Rejects any command not in the legal set for that state, naming the legal moves.
 *   3. Break-glass (escape) is always legal from every state (§4.4).
 *   4. Merge requires repo:merge capability; only the merge-gate body (Hanzo) holds it.
 *
 * Ad-hoc tickets (no wf:* label) are full pass-through — §4.6 mode switch.
 *
 * Fail-open posture (slice-1 carry-forward, AI-1347): fails open on missing
 * issueId / intent / label-fetch error. Phase 3 hardening to derive intent/issue
 * from the request body itself is a separate follow-up — do not block on it here.
 * TODO(AI-1347): derive intent/issue from request body when headers are absent.
 *
 * Design: design.md §4.4, §4.6, §11, §13, §16.1, §16.2.
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
export const WORKFLOW_DEF_PATH =
  process.env.WORKFLOW_DEF_PATH ??
  "/home/fancymatt/obsidian-vault/ai-systems/projects/fleet-orchestration-redesign/workflows/dev-impl.yaml";

// ── YAML schema types ──────────────────────────────────────────────────────

interface WorkflowTransition {
  command: string;
  to: string;
  requires_capability?: string;
}

interface WorkflowState {
  id: string;
  owner_role?: string;
  kind?: string;
  transitions?: WorkflowTransition[];
}

interface WorkflowDef {
  id: string;
  version?: number;
  archetype?: string;
  entry_state?: string;
  break_glass?: { command: string };
  states: WorkflowState[];
}

// ── Workflow def cache ─────────────────────────────────────────────────────

let _workflowCache: WorkflowDef | null = null;

async function loadWorkflowDef(): Promise<WorkflowDef> {
  if (_workflowCache) return _workflowCache;
  const raw = await fs.readFile(WORKFLOW_DEF_PATH, "utf8");
  _workflowCache = yaml.load(raw) as WorkflowDef;
  return _workflowCache;
}

/** Invalidate the in-process workflow def cache (used in tests). */
export function resetWorkflowCache(): void {
  _workflowCache = null;
}

// ── Label fetch ────────────────────────────────────────────────────────────

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

function getWorkflowId(labels: string[]): string | null {
  const label = labels.find((l) => /^wf:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
}

function getCurrentState(labels: string[]): string | null {
  const label = labels.find((l) => /^state:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
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

  // Capability gate — e.g. repo:merge is Hanzo-only (§16.2).
  if (match.requires_capability) {
    const allowed = await bodyHasCapability(bodyId, match.requires_capability);
    if (!allowed) {
      return (
        `[Proxy] '${intent}' requires the '${match.requires_capability}' capability; ` +
        `handoff to the merge-gate body to proceed.`
      );
    }
  }

  return null;
}
