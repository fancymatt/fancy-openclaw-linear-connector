/**
 * AI-1565: Pre-routing workflow bootstrap hook.
 *
 * When a wf:* label is added to a ticket with no state:* label, applies the
 * entry state from the workflow def and sets the first-owner delegate — no
 * human/agent action required.
 *
 * Reverse (demote): when wf:* is removed and state:* labels remain, cleans
 * them up so the ticket reverts to ad-hoc.
 *
 * This hook runs before the delegate-based router so a label-only change
 * (no delegate, no assignee, no mention) can bootstrap the ticket.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "./logger.js";
import { loadWorkflowRegistry, type WorkflowDef } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
import { findOrCreateLabel } from "./linear-helpers.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import type { LinearEvent, LinearIssueCreatedEvent, LinearIssueUpdatedEvent } from "./webhook/schema.js";
import { getAgents, getAccessToken } from "./agents.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-bootstrap");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Public result type ────────────────────────────────────────────────────────

export interface BootstrapResult {
  action: "bootstrapped" | "demoted" | "failed";
  /** For failed actions: machine-readable reason code. */
  failureReason?: string;
  /** For failed actions: human-readable explanation. */
  failureMessage?: string;
  workflowId?: string;
  entryState?: string;
  /** OpenClaw agent name of the newly-set delegate (bootstrapped only). */
  delegateAgentName?: string;
  /** Ticket identifier for wake delivery (bootstrapped only). */
  ticketIdentifier?: string;
  /** Ticket title for wake delivery (bootstrapped only). */
  ticketTitle?: string;
}

// ── Agents loader ─────────────────────────────────────────────────────────────

async function loadAgents(): Promise<Array<{ name: string; linearUserId?: string }>> {
  const filePath = process.env.AGENTS_PATH ?? path.resolve(process.cwd(), "agents.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { agents?: Array<{ name: string; linearUserId?: string }> };
    return data.agents ?? [];
  } catch {
    return [];
  }
}

// ── Linear API helpers ────────────────────────────────────────────────────────

/** Issue context used by both the webhook bootstrap and the reconciliation sweep. */
export interface IssueContext {
  id: string;
  teamId: string;
  identifier: string;
  title: string;
  labels: Array<{ id: string; name: string }>;
}

/** Re-export so callers (sweep) can import from a single module. */
export type { WorkflowDef };

/**
 * Fetch an issue's current context (labels, team, identifier) from Linear.
 *
 * Shared by the webhook bootstrap path and the reconciliation sweep — the
 * sweep uses this for the idempotency re-fetch before healing a ticket.
 */
export async function fetchIssueContext(issueId: string, authToken: string): Promise<IssueContext | null> {
  const query = `
    query IssueWithLabels($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        team { id }
        labels { nodes { id name } }
        delegate { id }
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
          identifier: string;
          title: string;
          team: { id: string };
          labels: { nodes: Array<{ id: string; name: string }> };
          delegate: { id: string } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      id: issue.id,
      teamId: issue.team.id,
      identifier: issue.identifier,
      title: issue.title,
      labels: issue.labels.nodes,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically apply label IDs (+ optional delegate) to an issue.
 *
 * Shared primitive — used by both the webhook bootstrap and the sweep.
 */
export async function issueUpdateAtomic(
  internalId: string,
  labelIds: string[],
  authToken: string,
  delegateId?: string | null,
): Promise<boolean> {
  const hasDelegate = delegateId !== undefined;
  const inputParts: string[] = ["labelIds: $labelIds"];
  if (hasDelegate) inputParts.push("delegateId: $delegateId");

  const mutation = `
    mutation ApplyAtomicTransition($issueId: String!, $labelIds: [String!]!${hasDelegate ? ", $delegateId: String" : ""}) {
      issueUpdate(id: $issueId, input: { ${inputParts.join(", ")} }) {
        success
      }
    }
  `;
  const variables: Record<string, unknown> = { issueId: internalId, labelIds };
  if (hasDelegate) variables.delegateId = delegateId;

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
}

// ── Main hook ─────────────────────────────────────────────────────────────────

/**
 * Pre-routing bootstrap hook — runs before the delegate-based router.
 *
 * Returns a BootstrapResult if the bootstrap or demote path fired, null otherwise.
 * Never throws: all errors are caught and logged, failing safe.
 */
export async function maybeBootstrapWorkflow(
  event: LinearEvent,
  authToken: string,
  enrolledTicketsStore?: EnrolledTicketsStore,
): Promise<BootstrapResult | null> {
  if (event.type !== "Issue" || (event.action !== "update" && event.action !== "create")) return null;
  // For create events updatedFrom is absent — previousLabelIds will be [] and all current labels
  // are treated as "added", which is exactly what we want for pre-attached wf: labels.
  const issueEvent = event as LinearIssueUpdatedEvent | LinearIssueCreatedEvent;

  const currentLabelIds: string[] = issueEvent.data.labelIds ?? [];
  const updatedFrom = (issueEvent as LinearIssueUpdatedEvent).updatedFrom as Record<string, unknown> | undefined;
  const previousLabelIds: string[] = (updatedFrom?.labelIds as string[] | undefined) ?? [];

  const currentSet = new Set(currentLabelIds);
  const previousSet = new Set(previousLabelIds);
  const addedIds = currentLabelIds.filter((id) => !previousSet.has(id));
  const removedIds = previousLabelIds.filter((id) => !currentSet.has(id));

  if (addedIds.length === 0 && removedIds.length === 0) {
    return null;
  }

  // Fetch current label names — needed to distinguish wf:* from state:* by ID.
  // Try the provided token first; if issue fetch fails, fall back to other
  // agent tokens (the provided token may lack access to the issue's team).
  let issue: IssueContext | null = null;
  let effectiveToken = authToken; // may be replaced by a fallback token
  const triedTokens: string[] = [];
  const tryFetch = async (token: string) => {
    triedTokens.push(token.slice(0, 8) + "...");
    return fetchIssueContext(issueEvent.data.id, token);
  };
  try {
    issue = await tryFetch(authToken);
  } catch {
    /* fall through to fallback */
  }
  if (!issue) {
    // Fallback: try other agent tokens that may have access to this issue's team.
    try {
      const agents = getAgents();
      for (const a of agents) {
        const t = getAccessToken(a.name);
        if (!t || t === authToken) continue; // skip the one we already tried
        try {
          issue = await tryFetch(t);
          if (issue) {
            effectiveToken = t;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* give up */
    }
  }
  if (!issue) {
    return null;
  }

  const currentWfLabelNode = issue.labels.find((n) => n.name.startsWith("wf:"));
  const currentStateLabels = issue.labels.filter((n) => n.name.startsWith("state:"));

  // ── Bootstrap path: a wf:* label was newly added ──────────────────────────
  if (addedIds.length > 0 && currentWfLabelNode && addedIds.includes(currentWfLabelNode.id)) {
    // Idempotency: if state:* is already present, this ticket is already in-flight.
    if (currentStateLabels.length > 0) return null;

    return applyBootstrapToIssue(issue, effectiveToken, undefined, enrolledTicketsStore);
  }

  // ── Demote path: wf:* was removed, state:* labels remain ─────────────────
  if (removedIds.length > 0 && !currentWfLabelNode && currentStateLabels.length > 0) {
    const stateLabelIds = new Set(currentStateLabels.map((n) => n.id));
    const newLabelIds = currentLabelIds.filter((id) => !stateLabelIds.has(id));

    await issueUpdateAtomic(issue.id, newLabelIds, effectiveToken);

    log.info(
      `workflow-bootstrap: demoted ${issueEvent.data.id} — removed [${currentStateLabels.map((n) => n.name).join(", ")}]`,
    );
    return { action: "demoted" };
  }

  return null;
}

// ── Shared bootstrap core ────────────────────────────────────────────────────

/**
 * Apply bootstrap (entry-state label + first-owner delegate) to an issue whose
 * context has already been fetched.
 *
 * This is the shared core invoked by both:
 *   - the webhook bootstrap hook (`maybeBootstrapWorkflow`)
 *   - the periodic reconciliation sweep (`runBootstrapReconciliationSweep`)
 *
 * AI-1775: a parallel reimplementation is explicitly disallowed by AC1 — both
 * paths must funnel through this function so the heal is identical to the
 * webhook-triggered bootstrap.
 *
 * Pre-conditions (checked by the caller):
 *   - The issue has a `wf:*` label
 *   - The issue has NO `state:*` label (idempotency)
 *
 * This function re-checks idempotency defensively (state:* present → null) so
 * the race between a late webhook and the sweep is covered even when the
 * caller's context is slightly stale.
 *
 * Returns a BootstrapResult on success, null for idempotency skips, or a
 * { action: "failed" } result when enrollment was attempted but could not
 * complete (AI-1836: definitive failure rather than silent null).
 *
 * Failure reasons are surfaced so callers can decide whether to roll back,
 * alert, or retry. The sweep treats failures as retryable (next cycle);
 * the webhook path treats them as visible errors.
 */
export async function applyBootstrapToIssue(
  issue: IssueContext,
  authToken: string,
  /** Optional registry override (used by the sweep). If absent, loads from file. */
  workflowRegistryOverride?: Map<string, WorkflowDef>,
  /** AI-1799: optional mirror store — writes enrollment rows for board data. */
  enrolledTicketsStore?: EnrolledTicketsStore,
): Promise<BootstrapResult | null> {
  // Defensive idempotency re-check — handles the webhook/sweep race.
  const currentStateLabels = issue.labels.filter((n) => n.name.startsWith("state:"));
  if (currentStateLabels.length > 0) return null;

  const wfLabelNode = issue.labels.find((n) => n.name.startsWith("wf:"));
  if (!wfLabelNode) return null;

  const workflowId = wfLabelNode.name.slice("wf:".length);

  let registry: Map<string, WorkflowDef>;
  if (workflowRegistryOverride) {
    registry = workflowRegistryOverride;
  } else {
    try {
      registry = await loadWorkflowRegistry();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `workflow-bootstrap: failed to load registry for '${workflowId}': ${msg}`,
      );
      return {
        action: "failed",
        workflowId,
        failureReason: "registry_load_failed",
        failureMessage: `Cannot load workflow registry — enrollment of '${workflowId}' cannot proceed: ${msg}`,
      };
    }
  }

  const def = registry.get(workflowId);
  if (!def) {
    log.warn(`workflow-bootstrap: no workflow def for '${workflowId}' — cannot enroll`);
    return {
      action: "failed",
      workflowId,
      failureReason: "no_workflow_def",
      failureMessage: `No workflow definition found for '${workflowId}' — enrollment rejected. Either create the workflow def or remove the wf:${workflowId} label.`,
    };
  }
  if (!def.entry_state) {
    log.warn(`workflow-bootstrap: workflow '${workflowId}' has no entry_state — cannot enroll`);
    return {
      action: "failed",
      workflowId,
      failureReason: "no_entry_state",
      failureMessage: `Workflow '${workflowId}' exists but has no entry_state — enrollment rejected. Fix the workflow def or remove the label.`,
    };
  }

  const entryState = def.entry_state;
  const entryStateDef = def.states.find((s) => s.id === entryState);

  // Resolve first-owner delegate from capability policy.
  let delegateLinearUserId: string | undefined;
  let delegateAgentName: string | undefined;
  let delegateRole = entryStateDef?.owner_role;
  if (delegateRole) {
    try {
      let bodies = await resolveBodiesForRole(delegateRole);
      // If the entry role has no bodies (e.g. synthetic "engine" role),
      // look ahead to the first transition target's owner_role.
      if (bodies.length === 0 && (entryStateDef as { transitions?: Array<{ to: string }> })?.transitions?.length) {
        const firstTransTarget = def.states.find(
          (s) => s.id === (entryStateDef as { transitions?: Array<{ to: string }> }).transitions![0].to,
        );
        const nextRole = firstTransTarget?.owner_role;
        if (nextRole && nextRole !== delegateRole) {
          bodies = await resolveBodiesForRole(nextRole);
          if (bodies.length > 0) delegateRole = nextRole;
        }
      }
      if (bodies.length === 1) {
        delegateAgentName = bodies[0];
        const agents = await loadAgents();
        const agent = agents.find((a) => a.name === delegateAgentName);
        if (agent?.linearUserId) {
          delegateLinearUserId = agent.linearUserId;
        } else {
          log.warn(`workflow-bootstrap: body '${delegateAgentName}' has no linearUserId — delegate not set`);
        }
      }
    } catch (err) {
      log.warn(
        `workflow-bootstrap: role resolution failed for '${delegateRole}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Find or create the entry state label.
  const stateLabelId = await findOrCreateLabel(issue.teamId, `state:${entryState}`, authToken);
  if (!stateLabelId) {
    log.warn(`workflow-bootstrap: could not resolve label 'state:${entryState}' — aborting bootstrap`);
    return {
      action: "failed",
      workflowId,
      failureReason: "label_creation_failed",
      failureMessage: `Could not find or create state label 'state:${entryState}' for workflow '${workflowId}' — enrollment cannot proceed.`,
    };
  }

  const currentLabelIds = issue.labels.map((l) => l.id);
  const newLabelIds = Array.from(new Set([...currentLabelIds, stateLabelId]));
  const success = await issueUpdateAtomic(issue.id, newLabelIds, authToken, delegateLinearUserId);

  if (!success) {
    log.warn(`workflow-bootstrap: issueUpdate returned non-success for ${issue.id}`);
    return {
      action: "failed",
      workflowId,
      failureReason: "mutation_failed",
      failureMessage: `Linear API mutation to stamp state:${entryState} + delegate on ${issue.identifier ?? issue.id} failed — enrollment could not be applied atomically. The sweep will retry.`,
    };
  } else {
    log.info(
      `workflow-bootstrap: bootstrapped ${issue.id} → ${workflowId}:${entryState}, delegate=${delegateLinearUserId ?? "none"}`,
    );
    // AI-1799: write enrollment row to the mirror so the board read API has data.
    enrolledTicketsStore?.enroll({
      ticketId: issue.identifier ?? issue.id,
      workflow: workflowId,
      state: entryState,
      delegate: delegateAgentName ?? null,
    });
  }

  return {
    action: "bootstrapped",
    workflowId,
    entryState,
    delegateAgentName,
    ticketIdentifier: issue.identifier,
    ticketTitle: issue.title,
  };
}
