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
 *   3. **Stall detection (§5.5 / §16.1):** Engine-owns-detection, parent-owns-response.
 *      Each state carries an optional time-in-state SLA (from workflow def YAML).
 *      When an outstanding child breaches its SLA, the engine emits a structured
 *      **StallEvent** against that child and its ancestor chain. The parent agent's
 *      managing-wake delivers the stall event — the parent decides the qualitative
 *      response (nudge, guidance, or escalation via barrier-level break-glass, §5.3).
 *
 *      **At-capacity ≠ stall.** A legitimately deferred/at-capacity child has its
 *      waiting time attributed up the ancestor SLA accounting as **known deferral**,
 *      so an overloaded-but-healthy subtree doesn't trip stall escalation while a
 *      genuinely stuck leaf still does.
 *
 * Design: design.md §5.3, §5.5, §14, §16.1.
 *
 * ACs:
 *   - Last child terminal → parent auto-moves managing → review (no manual nudge).
 *   - A deliberately stalled leaf produces a stall event to its parent.
 *   - An at-capacity-but-healthy subtree does NOT trip stall escalation.
 *   - Children cannot address the parent (asymmetry enforced).
 */

import { componentLogger, createLogger } from "./logger.js";
import { loadWorkflowDef, getWorkflowId, getCurrentState, type WorkflowDef } from "./workflow-gate.js";
import {
  LINEAR_API_URL,
  findOrCreateLabel,
  postComment,
  resolveInternalId,
  issueUpdateLabels,
  fetchIssueWithLabels,
  type LabelNode,
  type IssueWithLabels,
} from "./linear-helpers.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "barrier");

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
  /** Epoch ms when the child entered its current state (from Linear history). */
  stateEnteredAt: number | null;
  /** Per-state SLA in ms from the workflow definition, or null if no SLA defined. */
  stateSlaMs: number | null;
  /** How long (ms) the child has been in its current state. */
  timeInStateMs: number;
  /** Known-deferral time (ms) attributed to this child's ancestor chain. */
  knownDeferralMs: number;
  /** Whether this child is classified as at-capacity (deferred but healthy). */
  isDeferredAtCapacity: boolean;
}

const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;  // 30 minutes
const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000;     // 10 minutes

// ── Stall event (§5.5 / §16.1) ─────────────────────────────────────────────

/**
 * A structured stall event emitted by the engine when a child breaches its
 * per-state SLA. Delivered to the parent agent via the managing-wake flow.
 *
 * The engine detects; the parent agent decides the qualitative response.
 */
export interface StallEvent {
  /** The child that breached its SLA. */
  childIdentifier: string;
  /** The parent that receives the stall event. */
  parentIdentifier: string;
  /** The child's current workflow state. */
  currentState: string;
  /** How long the child has been in this state (ms). */
  timeInStateMs: number;
  /** The per-state SLA (ms) from the workflow definition. */
  slaMs: number;
  /** How far past the SLA the child is (ms). */
  breachMs: number;
  /** Known-deferral time accounted for (at-capacity, §16.1). */
  knownDeferralMs: number;
  /** Whether the child is at-capacity (deferred but healthy). */
  isDeferredAtCapacity: boolean;
  /** When the stall event was created (epoch ms). */
  createdAt: number;
}

/**
 * In-memory accounting of known-deferral time per (agent, ticket).
 *
 * When a child is at-capacity (legitimately deferred, per AI-1339), its
 * waiting time is tracked here so the stall detection can subtract it from
 * the SLA clock. An overloaded-but-healthy subtree does NOT trip stall
 * escalation while a genuinely stuck leaf still does.
 */
export class DeferralAccountant {
  private deferrals: Map<string, { startedAt: number; accumulatedMs: number }> = new Map();

  /** Start tracking deferral for a child. */
  startDeferral(childIdentifier: string, now: number = Date.now()): void {
    const existing = this.deferrals.get(childIdentifier);
    if (existing) {
      // Already deferring — accumulate what we have and restart
      existing.accumulatedMs += now - existing.startedAt;
      existing.startedAt = now;
    } else {
      this.deferrals.set(childIdentifier, { startedAt: now, accumulatedMs: 0 });
    }
  }

  /** Stop tracking deferral for a child (e.g., when it becomes active again). */
  stopDeferral(childIdentifier: string, now: number = Date.now()): number {
    const entry = this.deferrals.get(childIdentifier);
    if (!entry) return 0;
    const total = entry.accumulatedMs + (now - entry.startedAt);
    this.deferrals.delete(childIdentifier);
    return total;
  }

  /** Get the total known-deferral time for a child (ms). */
  getDeferralMs(childIdentifier: string, now: number = Date.now()): number {
    const entry = this.deferrals.get(childIdentifier);
    if (!entry) return 0;
    return entry.accumulatedMs + (now - entry.startedAt);
  }

  /** Check if a child is currently in deferral. */
  isDeferring(childIdentifier: string): boolean {
    return this.deferrals.has(childIdentifier);
  }

  /** Clear all deferral state. */
  clearAll(): void {
    this.deferrals.clear();
  }
}

// Global singleton — survives across poll cycles within a single connector process.
export const deferralAccountant = new DeferralAccountant();

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
  // Phase 6 / C-3 (AI-1473): generalized from ux-audit-only to archetype-agnostic.
  // Both ux-audit (managing → review) and sprint (managing → validating) use the
  // same barrier pattern: all children terminal → auto-advance.
  const isOrchestrator = workflowId === "ux-audit";
  const isFeatureInitiative = workflowId === "sprint";
  if (!isOrchestrator && !isFeatureInitiative) {
    log.info(`barrier: parent ${parentIdentifier} is not an orchestrator or feature-initiative (wf:${workflowId}) — skipping`);
    result.error = `Parent workflow is '${workflowId}', expected 'ux-audit' or 'sprint'`;
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

  // Phase 6 / C-3: ux-audit advances to 'review', sprint advances to 'validating'.
  const barrierTarget = isOrchestrator ? "review" : "validating";
  const reviewLabelId = await findOrCreateLabel(
    parentWithLabels.teamId,
    `state:${barrierTarget}`,
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
    `Auto-advancing parent managing → ${barrierTarget}.\n\n${childSummary}`;
  await postComment(parentWithLabels.internalId, commentBody, authToken);

  result.transitioned = true;
  log.info(
    `barrier: ${parentIdentifier} managing → ${barrierTarget} ` +
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
  // Phase 6 / C-3: support both ux-audit and sprint archetypes.
  if (workflowId !== "ux-audit" && workflowId !== "sprint") return null;

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

// Re-export LabelNode for barrier-specific usage
export type { LabelNode } from "./linear-helpers.js";

/**
 * Fetch parent issue with label IDs.
 * Delegates to the shared fetchIssueWithLabels from linear-helpers.
 */
async function fetchParentWithLabelIds(
  parentIdentifier: string,
  authToken: string,
): Promise<IssueWithLabels | null> {
  return fetchIssueWithLabels(parentIdentifier, authToken);
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
    lines.push("⚠️ Stall event(s) (§5.5 / §16.1 — engine-detected SLA breach):");
    for (const stalled of stalledChildren) {
      const timeInStateMin = Math.round(stalled.timeInStateMs / 60000);
      const slaMin = stalled.stateSlaMs ? Math.round(stalled.stateSlaMs / 60000) : null;
      const slaInfo = slaMin ? ` (SLA: ${slaMin}m)` : "";
      const deferralInfo = stalled.knownDeferralMs > 0
        ? ` [deferral accounted: ${Math.round(stalled.knownDeferralMs / 60000)}m]`
        : "";
      lines.push(
        `  - ${stalled.identifier}: ${stalled.currentState ?? "unknown"} ` +
        `(${timeInStateMin}m in state${slaInfo}${deferralInfo})`,
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
 * Fetch the epoch ms when a child entered its current state, by examining
 * Linear history for the most recent `state:*` label change.
 *
 * Returns null if the state-entry time cannot be determined.
 */
async function fetchChildStateEnteredAt(
  childIdentifier: string,
  authToken: string,
): Promise<number | null> {
  const query = `
    query ChildStateHistory($id: String!) {
      issue(id: $id) {
        labels { nodes { name } }
        history(first: 100, orderBy: { createdAt: desc }) {
          nodes {
            __typename
            ... on IssueLabelPayload {
              createdAt
              fromLabel { name }
              toLabel { name }
            }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: childIdentifier } }),
    });
    type HistoryNode = {
      __typename: string;
      createdAt?: string;
      fromLabel?: { name: string } | null;
      toLabel?: { name: string } | null;
    };
    type Resp = {
      data?: {
        issue?: {
          labels?: { nodes?: Array<{ name: string }> };
          history?: { nodes?: HistoryNode[] };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;

    // Get the current state from labels
    const labelNames = (issue.labels?.nodes ?? []).map((l) => l.name);
    const currentState = getCurrentState(labelNames);
    if (!currentState) return null;

    const stateLabel = `state:${currentState}`;
    const historyNodes = issue.history?.nodes ?? [];

    // Find the most recent history event where the state:* label was set to the current state
    for (const node of historyNodes) {
      if (node.__typename === "IssueLabelPayload" && node.toLabel?.name === stateLabel && node.createdAt) {
        return new Date(node.createdAt).getTime();
      }
    }

    return null; // Couldn't determine state entry time
  } catch (err) {
    log.error(`barrier: failed to fetch state entry for ${childIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Detect stalled children of a parent issue in `managing` state.
 *
 * Phase 6.5 / H-3 (AI-1478): Engine-owns-detection split.
 *
 * A child is stalled when ALL of the following are true:
 *   - It is in a non-terminal state.
 *   - It has been in its current state longer than the per-state SLA
 *     (from the workflow definition YAML), MINUS any known-deferral time.
 *   - It is NOT classified as at-capacity (deferred but healthy).
 *
 * At-capacity children (§16.1) have their waiting time attributed as
 * known deferral so they do NOT trip stall escalation. Genuinely stuck
 * leaves that are NOT at-capacity still do.
 *
 * Returns the list of stalled children with StallEvent data.
 *
 * AC1: A deliberately stalled leaf produces a stall event to its parent.
 * AC2: An at-capacity-but-healthy subtree does NOT trip stall escalation.
 */
export async function detectStalledChildren(
  parentIdentifier: string,
  authToken: string,
  stallThresholdMs: number = DEFAULT_STALL_THRESHOLD_MS,
  now: number = Date.now(),
  workflowDef?: WorkflowDef,
  accountant?: DeferralAccountant,
): Promise<{ stalled: StalledChild[]; atCapacitySkipped: number }> {
  const children = await fetchChildren(parentIdentifier, authToken);
  const stalled: StalledChild[] = [];
  let atCapacitySkipped = 0;

  // Load workflow def if not provided
  let def = workflowDef;
  if (!def) {
    try {
      def = await loadWorkflowDef();
    } catch {
      // Fallback to legacy flat-threshold behavior if workflow def unavailable
      log.warn("barrier: workflow def unavailable, using flat stall threshold");
    }
  }

  const acct = accountant ?? deferralAccountant;

  for (const child of children) {
    if (child.isTerminal) continue;

    const lastActivity = await fetchChildLastActivity(child.identifier, authToken);
    if (lastActivity === null) continue;

    const idleDurationMs = now - lastActivity;

    // Fetch state-entry time for per-state SLA
    const stateEnteredAt = await fetchChildStateEnteredAt(child.identifier, authToken);
    const timeInStateMs = stateEnteredAt !== null ? now - stateEnteredAt : idleDurationMs;

    // Look up per-state SLA from workflow def
    let stateSlaMs: number | null = null;
    if (def && child.workflowState) {
      const stateDef = def.states.find((s) => s.id === child.workflowState);
      if (stateDef?.sla) {
        stateSlaMs = stateDef.sla;
      }
    }

    // Known-deferral accounting (at-capacity, §16.1)
    const isDeferredAtCapacity = acct.isDeferring(child.identifier);
    const knownDeferralMs = acct.getDeferralMs(child.identifier, now);

    // Determine effective threshold: per-state SLA or flat fallback
    const effectiveThresholdMs = stateSlaMs ?? stallThresholdMs;

    // Skip at-capacity children: they are deferred but healthy (AC2)
    if (isDeferredAtCapacity) {
      atCapacitySkipped++;
      continue;
    }

    // Effective time in state = time in state minus known deferral
    const effectiveTimeMs = Math.max(0, timeInStateMs - knownDeferralMs);

    if (effectiveTimeMs >= effectiveThresholdMs) {
      stalled.push({
        identifier: child.identifier,
        parentIdentifier,
        currentState: child.workflowState,
        lastActivityAt: lastActivity,
        idleDurationMs,
        stateEnteredAt,
        stateSlaMs,
        timeInStateMs,
        knownDeferralMs,
        isDeferredAtCapacity,
      });
    }
  }

  return { stalled, atCapacitySkipped };
}

/**
 * Build a StallEvent from a StalledChild.
 *
 * The engine emits this structured event; the parent agent decides the response.
 */
export function buildStallEvent(
  child: StalledChild,
  now: number = Date.now(),
): StallEvent {
  const slaMs = child.stateSlaMs ?? DEFAULT_STALL_THRESHOLD_MS;
  return {
    childIdentifier: child.identifier,
    parentIdentifier: child.parentIdentifier,
    currentState: child.currentState ?? "unknown",
    timeInStateMs: child.timeInStateMs,
    slaMs,
    breachMs: Math.max(0, child.timeInStateMs - child.knownDeferralMs - slaMs),
    knownDeferralMs: child.knownDeferralMs,
    isDeferredAtCapacity: child.isDeferredAtCapacity,
    createdAt: now,
  };
}

/**
 * Surface stalled children by emitting stall events to the parent.
 *
 * Phase 6.5 / H-3 (AI-1478): Engine detects stall → emits StallEvent(s) →
 * parent agent responds via managing-wake flow.
 *
 * Posts a tripwire comment on the parent ticket with structured stall data.
 * Returns the list of StallEvents for downstream delivery (managing-wake).
 */
export async function surfaceStalledChildren(
  parentIdentifier: string,
  authToken: string,
  stallThresholdMs: number = DEFAULT_STALL_THRESHOLD_MS,
): Promise<{ surfaced: number; events: StallEvent[]; atCapacitySkipped: number }> {
  const { stalled, atCapacitySkipped } = await detectStalledChildren(parentIdentifier, authToken, stallThresholdMs);
  if (stalled.length === 0) return { surfaced: 0, events: [], atCapacitySkipped };

  const events: StallEvent[] = stalled.map((child) => buildStallEvent(child));

  const children = await fetchChildren(parentIdentifier, authToken);
  const message = buildShepherdingMessage(parentIdentifier, children, stalled);

  const internalId = await resolveInternalId(parentIdentifier, authToken);
  if (!internalId) {
    log.error(`barrier: cannot surface stalled children — failed to resolve ${parentIdentifier}; ${events.length} stall event(s) detected but not posted`);
    return { surfaced: events.length, events, atCapacitySkipped };
  }

  const posted = await postComment(internalId, message, authToken);
  if (posted) {
    log.info(
      `barrier: §5.5/§16.1 — emitted ${events.length} stall event(s) on ${parentIdentifier}`,
    );
  }
  return { surfaced: events.length, events, atCapacitySkipped };
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
