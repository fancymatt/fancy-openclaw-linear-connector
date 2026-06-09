/**
 * Phase 5 / B-3 — Managing barrier (N→1) + asymmetric shepherding + stall detection.
 *
 * Three subsystems:
 *
 *   1. **Barrier (N→1):** Event-driven — when the last linked child reaches a
 *      terminal state, the engine auto-advances the parent `managing → review`.
 *      No polling for done-ness (§5.3). Triggered by Linear webhook events.
 *
 *   2. **Asymmetric shepherding (§5.3):** Parent (researcher/engine) shepherds
 *      *down* — nudge/escalate stuck children; children never look *up*.
 *      The asymmetry is structural: children run `wf:dev-impl`, parents run
 *      `wf:ux-audit`. A dev-impl ticket has no legal command to address its
 *      parent. The parent's managing-wake already includes child-status checks;
 *      this module enriches it with stall-surface logic.
 *
 *   3. **Stall detection (§5.5):** Reuses the existing `code-review` SLA-breach /
 *      stale-session tripwire pattern from StuckDelegateDetector. When a child
 *      in a non-terminal state has been idle beyond a threshold, surfaces it
 *      via a comment on the parent + a stewardship wake to the parent's owner.
 *
 * Design: design.md §5.3, §5.5, §14.
 *
 * ACs:
 *   - Last child terminal → parent auto-moves managing → review (no manual nudge).
 *   - A stalled child raises the §5.5 tripwire (surfaced, not silent).
 *   - Children cannot address the parent (asymmetry enforced).
 */

import { componentLogger, createLogger } from "./logger.js";
import { loadWorkflowDef, getWorkflowId, getCurrentState, type WorkflowDef } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "barrier");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ─────────────────────────────────────────────────────────────────

/** Terminal states that satisfy the parent barrier. */
const TERMINAL_WORKFLOW_STATES = new Set(["done", "escape"]);

/** A child issue's resolved state for barrier evaluation. */
export interface ChildState {
  identifier: string;
  /** Labels on the child issue. */
  labels: string[];
  /** Whether the child is in a terminal workflow state. */
  isTerminal: boolean;
  /** The child's workflow state (from state:* label), or null. */
  workflowState: string | null;
}

/** Result of a barrier evaluation. */
export interface BarrierResult {
  /** All children are terminal — barrier is satisfied. */
  allTerminal: boolean;
  /** Total number of children. */
  totalChildren: number;
  /** Number of children in terminal states. */
  terminalCount: number;
  /** Details of each child. */
  children: ChildState[];
}

/** Result of a barrier auto-transition attempt. */
export interface BarrierTransitionResult {
  /** Whether the parent was successfully transitioned. */
  transitioned: boolean;
  /** Parent issue identifier. */
  parentIdentifier: string;
  /** Number of children that were terminal. */
  terminalCount: number;
  /** Number of children total. */
  totalChildren: number;
  /** Error message if transition failed. */
  error?: string;
}

/** Configuration for stall detection. */
export interface StallDetectionConfig {
  /** How long (ms) a child must be idle in a non-terminal state before
   *  being considered stalled. Default: 30 min. */
  stallThresholdMs: number;
  /** How often (ms) to check for stalled children. Default: 10 min. */
  pollIntervalMs: number;
}

/** A stalled child surfaced by stall detection. */
export interface StalledChild {
  identifier: string;
  parentIdentifier: string;
  currentState: string | null;
  /** Epoch ms of last activity on this child. */
  lastActivityAt: number | null;
  /** How long (ms) the child has been idle. */
  idleDurationMs: number;
}

const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;  // 30 minutes
const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000;     // 10 minutes

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Is a child in a terminal state based on its labels?
 * Terminal states: done, escape (from the ux-audit and dev-impl workflow defs).
 * Also checks if the child has a `state:*` label matching a terminal state.
 */
export function isChildTerminal(labels: string[]): boolean {
  const state = getCurrentState(labels);
  if (!state) return false;
  return TERMINAL_WORKFLOW_STATES.has(state);
}

/**
 * Determine if a workflow state is terminal.
 */
export function isTerminalState(stateName: string): boolean {
  return TERMINAL_WORKFLOW_STATES.has(stateName);
}

// ── Linear API helpers ────────────────────────────────────────────────────

/**
 * Fetch the parent issue's identifier for a given child issue.
 * Returns null if the child has no parent.
 */
export async function fetchParentIdentifier(
  childIdentifier: string,
  authToken: string,
): Promise<string | null> {
  const query = `
    query ChildParent($id: String!) {
      issue(id: $id) {
        parent { identifier }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: childIdentifier } }),
    });
    type Resp = { data?: { issue?: { parent?: { identifier: string } | null } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.parent?.identifier ?? null;
  } catch (err) {
    log.error(`barrier: failed to fetch parent for ${childIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Fetch all children of a parent issue with their labels.
 * Returns the children's identifiers and label names.
 */
export async function fetchChildren(
  parentIdentifier: string,
  authToken: string,
): Promise<ChildState[]> {
  const query = `
    query ParentChildren($id: String!) {
      issue(id: $id) {
        children {
          nodes {
            identifier
            labels { nodes { name } }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentIdentifier } }),
    });
    type Resp = {
      data?: {
        issue?: {
          children?: {
            nodes?: Array<{
              identifier: string;
              labels?: { nodes?: Array<{ name: string }> };
            }>;
          };
        };
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.children?.nodes ?? [];
    return nodes.map((node) => {
      const labels = (node.labels?.nodes ?? []).map((l) => l.name);
      return {
        identifier: node.identifier,
        labels,
        isTerminal: isChildTerminal(labels),
        workflowState: getCurrentState(labels),
      };
    });
  } catch (err) {
    log.error(`barrier: failed to fetch children for ${parentIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Fetch the parent issue's labels to determine its current workflow state.
 */
async function fetchParentState(
  parentIdentifier: string,
  authToken: string,
): Promise<{ labels: string[]; internalId: string; teamId: string } | null> {
  const query = `
    query ParentState($id: String!) {
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
      body: JSON.stringify({ query, variables: { id: parentIdentifier } }),
    });
    type Resp = {
      data?: {
        issue?: {
          id: string;
          team: { id: string };
          labels: { nodes: Array<{ id: string; name: string }> };
        };
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      labels: issue.labels.nodes.map((l) => l.name),
      internalId: issue.id,
      teamId: issue.team.id,
    };
  } catch (err) {
    log.error(`barrier: failed to fetch parent state for ${parentIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Find or create a state label in the team.
 */
async function findOrCreateLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
  // Look up existing
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
    type LookupResp = { data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } } };
    const lookupData = (await lookupRes.json()) as LookupResp;
    const existing = (lookupData.data?.team?.labels?.nodes ?? []).find(
      (n) => n.name === labelName,
    );
    if (existing) return existing.id;
  } catch (err) {
    log.error(`barrier: label lookup failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Create
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
      log.info(`barrier: created label '${labelName}' in team ${teamId}`);
      return result.issueLabel.id;
    }
    return null;
  } catch (err) {
    log.error(`barrier: label creation failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Post a comment on an issue.
 */
async function postComment(
  issueInternalId: string,
  body: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
    });
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.commentCreate?.success ?? false;
  } catch (err) {
    log.error(`barrier: comment post failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Resolve a human-readable identifier to an internal UUID.
 */
async function resolveInternalId(
  identifier: string,
  authToken: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { id } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { id: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.id ?? null;
  } catch (err) {
    log.error(`barrier: failed to resolve internal ID for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Public API: Barrier ───────────────────────────────────────────────────

/**
 * Evaluate whether the barrier is satisfied for a parent in `managing` state.
 *
 * Fetches all children of the parent and checks if every one has reached
 * a terminal workflow state. Returns the evaluation result.
 *
 * This is a pure evaluation — it does not mutate anything.
 */
export async function evaluateBarrier(
  parentIdentifier: string,
  authToken: string,
): Promise<BarrierResult> {
  const children = await fetchChildren(parentIdentifier, authToken);

  if (children.length === 0) {
    return { allTerminal: false, totalChildren: 0, terminalCount: 0, children: [] };
  }

  const terminalCount = children.filter((c) => c.isTerminal).length;
  return {
    allTerminal: terminalCount === children.length,
    totalChildren: children.length,
    terminalCount,
    children,
  };
}

/**
 * Attempt to auto-advance the parent from `managing → review` when the
 * barrier is satisfied (all children terminal).
 *
 * Steps:
 *   1. Evaluate the barrier — are all children terminal?
 *   2. Verify the parent is in `managing` state.
 *   3. Atomically swap state:managing → state:review.
 *   4. Post a barrier-summary comment on the parent.
 *
 * Returns the result of the transition attempt.
 * Fail-open: any error is logged and returned — callers should not retry.
 *
 * AC1: Last child terminal → parent auto-moves managing → review with no
 *      manual nudge.
 */
export async function attemptBarrierTransition(
  parentIdentifier: string,
  authToken: string,
  workflowDef?: WorkflowDef,
  prefetchedParentState?: { labels: string[]; internalId: string; teamId: string } | null,
): Promise<BarrierTransitionResult> {
  const result: BarrierTransitionResult = {
    transitioned: false,
    parentIdentifier,
    terminalCount: 0,
    totalChildren: 0,
  };

  // 1. Evaluate barrier
  const barrier = await evaluateBarrier(parentIdentifier, authToken);
  result.terminalCount = barrier.terminalCount;
  result.totalChildren = barrier.totalChildren;

  if (barrier.totalChildren === 0) {
    log.info(`barrier: no children for ${parentIdentifier} — skipping`);
    result.error = "No children found — barrier requires at least one child";
    return result;
  }

  if (!barrier.allTerminal) {
    log.info(
      `barrier: not all children terminal for ${parentIdentifier} — ` +
      `${barrier.terminalCount}/${barrier.totalChildren} done`,
    );
    return result; // Not an error — just not ready yet
  }

  // 2. Verify parent is in managing state
  //    Use pre-fetched state if provided (avoids redundant API call)
  const parentState = prefetchedParentState ?? await fetchParentState(parentIdentifier, authToken);
  if (!parentState) {
    result.error = "Failed to fetch parent state";
    return result;
  }

  const workflowId = getWorkflowId(parentState.labels);
  if (workflowId !== "ux-audit") {
    log.info(`barrier: parent ${parentIdentifier} is not ux-audit (wf:${workflowId}) — skipping`);
    result.error = `Parent workflow is '${workflowId}', expected 'ux-audit'`;
    return result;
  }

  const currentState = getCurrentState(parentState.labels);
  if (currentState !== "managing") {
    log.info(`barrier: parent ${parentIdentifier} is in '${currentState}', not 'managing' — skipping`);
    result.error = `Parent state is '${currentState}', expected 'managing'`;
    return result;
  }

  // 3. Atomic label swap: state:managing → state:review
  // We need the label IDs, not just the names — re-fetch with IDs
  const parentWithLabels = await fetchParentWithLabelIds(parentIdentifier, authToken);
  if (!parentWithLabels) {
    result.error = "Failed to fetch parent label IDs";
    return result;
  }

  const managingLabelNode = parentWithLabels.labels.find((l) => l.name === "state:managing");
  if (!managingLabelNode) {
    result.error = "No state:managing label found on parent";
    return result;
  }

  const reviewLabelId = await findOrCreateLabel(
    parentWithLabels.teamId,
    "state:review",
    authToken,
  );
  if (!reviewLabelId) {
    result.error = "Failed to resolve state:review label";
    return result;
  }

  const newLabelIds = [
    ...parentWithLabels.labels.filter((l) => l.id !== managingLabelNode.id).map((l) => l.id),
    reviewLabelId,
  ];

  const updated = await issueUpdateLabels(parentWithLabels.internalId, newLabelIds, authToken);
  if (!updated) {
    result.error = "Label swap mutation returned non-success";
    return result;
  }

  // 4. Post barrier-summary comment
  const childSummary = barrier.children
    .map((c) => `- ${c.identifier}: ${c.workflowState ?? "unknown"}`)
    .join("\n");
  const commentBody =
    `[Barrier] All ${barrier.totalChildren} child(ren) reached terminal state. ` +
    `Auto-advancing parent managing → review.\n\n${childSummary}`;
  await postComment(parentWithLabels.internalId, commentBody, authToken);

  result.transitioned = true;
  log.info(
    `barrier: ${parentIdentifier} managing → review ` +
    `(${barrier.terminalCount}/${barrier.totalChildren} children terminal)`,
  );
  return result;
}

/**
 * Main entry point for the webhook-driven barrier check.
 *
 * Call this when a child issue reaches a terminal state. It:
 *   1. Finds the parent issue.
 *   2. If the parent is in `managing` state on `ux-audit` workflow,
 *      evaluates the barrier.
 *   3. If all children are terminal, auto-transitions to `review`.
 *
 * Returns true if a barrier transition was attempted (whether successful or not).
 * Returns false if the barrier was not applicable (no parent, not managing, etc.)
 */
export async function onChildTerminal(
  childIdentifier: string,
  authToken: string,
): Promise<BarrierTransitionResult | null> {
  // 1. Find the parent
  const parentIdentifier = await fetchParentIdentifier(childIdentifier, authToken);
  if (!parentIdentifier) {
    log.info(`barrier: ${childIdentifier} has no parent — skipping barrier check`);
    return null;
  }

  // 2. Check if parent is in managing state on ux-audit
  const parentState = await fetchParentState(parentIdentifier, authToken);
  if (!parentState) return null;

  const workflowId = getWorkflowId(parentState.labels);
  if (workflowId !== "ux-audit") return null;

  const currentState = getCurrentState(parentState.labels);
  if (currentState !== "managing") {
    log.info(`barrier: parent ${parentIdentifier} in '${currentState}' (not managing) — skipping`);
    return null;
  }

  // 3. Attempt the barrier transition, passing pre-fetched parent state
  log.info(`barrier: child ${childIdentifier} terminal, checking barrier for parent ${parentIdentifier}`);
  return attemptBarrierTransition(parentIdentifier, authToken, undefined, parentState);
}

// ── Label fetch with IDs ──────────────────────────────────────────────────

interface LabelNode {
  id: string;
  name: string;
}

async function fetchParentWithLabelIds(
  parentIdentifier: string,
  authToken: string,
): Promise<{ internalId: string; teamId: string; labels: LabelNode[] } | null> {
  const query = `
    query ParentLabels($id: String!) {
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
      body: JSON.stringify({ query, variables: { id: parentIdentifier } }),
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
    log.error(`barrier: failed to fetch parent labels for ${parentIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function issueUpdateLabels(
  internalId: string,
  labelIds: string[],
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation BarrierTransition($issueId: String!, $labelIds: [String!]!) {
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
      log.warn(`barrier: issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error(`barrier: issueUpdate failed for ${internalId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Public API: Asymmetric shepherding ────────────────────────────────────

/**
 * Build a shepherding message for the parent's owner about child status.
 *
 * The parent (researcher/engine) shepherds DOWN — nudges/escalates stuck
 * children. Children never look UP (§5.3). The asymmetry is structural:
 * children run wf:dev-impl which has no command to address the parent.
 *
 * This function builds the message surfaced to the parent owner during
 * a stewardship wake, listing child states and surfacing any stalled ones.
 */
export function buildShepherdingMessage(
  parentIdentifier: string,
  children: ChildState[],
  stalledChildren: StalledChild[],
): string {
  const lines: string[] = [
    `[Shepherding] Parent ${parentIdentifier} — child status summary:`,
    "",
  ];

  for (const child of children) {
    const state = child.workflowState ?? "no state";
    const marker = child.isTerminal ? "✓" : "●";
    lines.push(`  ${marker} ${child.identifier}: ${state}`);
  }

  if (stalledChildren.length > 0) {
    lines.push("");
    lines.push("⚠️ Stalled children (§5.5 tripwire):");
    for (const stalled of stalledChildren) {
      const idleMin = Math.round(stalled.idleDurationMs / 60000);
      lines.push(
        `  - ${stalled.identifier}: ${stalled.currentState ?? "unknown"} ` +
        `(idle ${idleMin}m)`,
      );
    }
    lines.push("");
    lines.push("Action: nudge or escalate stalled children. Run `linear nudge <child-id>` or reassign.");
  }

  return lines.join("\n");
}

/**
 * Enforce asymmetry: check if a given issue is a child of a ux-audit parent.
 * Returns true if the issue is a child that should NOT be able to address
 * its parent. Used by the workflow-gate to block upward-directed commands.
 *
 * §5.3: children never look up. A child running wf:dev-impl cannot issue
 * commands targeting the parent's ux-audit workflow.
 */
export async function isChildOfUxAuditParent(
  issueIdentifier: string,
  authToken: string,
): Promise<boolean> {
  const parentIdentifier = await fetchParentIdentifier(issueIdentifier, authToken);
  if (!parentIdentifier) return false;

  const parentState = await fetchParentState(parentIdentifier, authToken);
  if (!parentState) return false;

  const workflowId = getWorkflowId(parentState.labels);
  return workflowId === "ux-audit";
}

// ── Public API: Stall detection ───────────────────────────────────────────

/**
 * Fetch the last activity timestamp for a child issue.
 * Uses the updatedAt field as a proxy for activity.
 */
async function fetchChildLastActivity(
  childIdentifier: string,
  authToken: string,
): Promise<number | null> {
  const query = `
    query ChildActivity($id: String!) {
      issue(id: $id) {
        updatedAt
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: childIdentifier } }),
    });
    type Resp = { data?: { issue?: { updatedAt: string } | null } };
    const data = (await res.json()) as Resp;
    const updatedAt = data.data?.issue?.updatedAt;
    if (!updatedAt) return null;
    return new Date(updatedAt).getTime();
  } catch (err) {
    log.error(`barrier: failed to fetch activity for ${childIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Detect stalled children of a parent issue in `managing` state.
 *
 * A child is stalled when:
 *   - It is in a non-terminal state.
 *   - Its last activity (updatedAt) exceeds the stall threshold.
 *   - The parent is in `managing` state on `ux-audit` workflow.
 *
 * Returns the list of stalled children for the §5.5 tripwire.
 *
 * AC2: A stalled child raises the §5.5 tripwire (surfaced, not silent).
 */
export async function detectStalledChildren(
  parentIdentifier: string,
  authToken: string,
  stallThresholdMs: number = DEFAULT_STALL_THRESHOLD_MS,
  now: number = Date.now(),
): Promise<StalledChild[]> {
  const children = await fetchChildren(parentIdentifier, authToken);
  const stalled: StalledChild[] = [];

  for (const child of children) {
    if (child.isTerminal) continue;

    const lastActivity = await fetchChildLastActivity(child.identifier, authToken);
    if (lastActivity === null) continue;

    const idleDurationMs = now - lastActivity;
    if (idleDurationMs >= stallThresholdMs) {
      stalled.push({
        identifier: child.identifier,
        parentIdentifier,
        currentState: child.workflowState,
        lastActivityAt: lastActivity,
        idleDurationMs,
      });
    }
  }

  return stalled;
}

/**
 * Surface stalled children by posting a tripwire comment on the parent.
 *
 * This is the §5.5 tripwire: a stalled child surfaces instead of hanging
 * the barrier. The comment is posted on the parent ticket so the parent's
 * owner (researcher/engine) can take action.
 *
 * Returns the number of stalled children surfaced.
 */
export async function surfaceStalledChildren(
  parentIdentifier: string,
  authToken: string,
  stallThresholdMs: number = DEFAULT_STALL_THRESHOLD_MS,
): Promise<number> {
  const stalled = await detectStalledChildren(parentIdentifier, authToken, stallThresholdMs);
  if (stalled.length === 0) return 0;

  const children = await fetchChildren(parentIdentifier, authToken);
  const message = buildShepherdingMessage(parentIdentifier, children, stalled);

  const internalId = await resolveInternalId(parentIdentifier, authToken);
  if (!internalId) {
    log.error(`barrier: cannot surface stalled children — failed to resolve ${parentIdentifier}`);
    return 0;
  }

  const posted = await postComment(internalId, message, authToken);
  if (posted) {
    log.info(
      `barrier: §5.5 tripwire — surfaced ${stalled.length} stalled child(ren) on ${parentIdentifier}`,
    );
  }
  return stalled.length;
}

/**
 * Parse stall detection config from environment variables.
 */
export function parseStallConfig(): StallDetectionConfig {
  const stallThresholdMs = parseInt(process.env.BARRIER_STALL_THRESHOLD_MS ?? "", 10);
  const pollIntervalMs = parseInt(process.env.BARRIER_STALL_POLL_MS ?? "", 10);

  return {
    stallThresholdMs: isNaN(stallThresholdMs) || stallThresholdMs <= 0
      ? DEFAULT_STALL_THRESHOLD_MS : stallThresholdMs,
    pollIntervalMs: isNaN(pollIntervalMs) || pollIntervalMs <= 0
      ? DEFAULT_POLL_INTERVAL_MS : pollIntervalMs,
  };
}
