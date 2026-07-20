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
import { loadWorkflowDef, loadWorkflowDefById, loadWorkflowRegistry, getWorkflowId, getCurrentState, type WorkflowDef, type WorkflowState } from "./workflow-gate.js";
import { getFanoutOutcome } from "./fanout-outcome-store.js";
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

/**
 * AI-1992: barrier-ness is now declared per-state in YAML (`barrier: true`), not
 * a hardcoded workflow-id allowlist. The old `BARRIER_WORKFLOWS` set has been
 * removed; any workflow whose current state declares `barrier: true` is a barrier
 * (evaluated against the loaded workflow def / registry).
 *
 * Pure predicate: does this state def declare an N→1 barrier?
 */
export function isBarrierState(state: { barrier?: boolean } | undefined | null): boolean {
  return state?.barrier === true;
}

/**
 * Parse a per-state SLA duration string into milliseconds.
 * Accepts `<n>h`, `<n>m`, `<n>s`, or a bare millisecond number (e.g. "24h",
 * "90m", "3600000"). Returns null when the value can't be parsed.
 */
export function parseSlaToMs(sla: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|m|s|ms)?\s*$/i.exec(sla);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "ms").toLowerCase()) {
    case "h": return n * 60 * 60 * 1000;
    case "m": return n * 60 * 1000;
    case "s": return n * 1000;
    default: return n; // bare number = ms
  }
}

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
  /**
   * INF-108: true when the child has no `state:*` label (demoted off its
   * workflow mid-flight). An orphaned child cannot contribute to the barrier
   * evaluation — it is neither terminal nor active — and holds the barrier
   * indefinitely. The parent steward needs to know about this condition to
   * manually resolve the deadlock.
   */
  isOrphaned: boolean;
}

/** Result of a barrier evaluation. */
export interface BarrierResult {
  /** All children are terminal — barrier is satisfied. */
  allTerminal: boolean;
  /** Total number of children. */
  totalChildren: number;
  /** Number of children in terminal states. */
  terminalCount: number;
  /** Number of orphaned children (demoted off workflow, INF-108). */
  orphanedCount: number;
  /** Details of each child. */
  children: ChildState[];
  /**
   * INF-34: the child set could not be read. Distinct from a successful read of
   * zero children — `totalChildren: 0` alone cannot tell the two apart, and
   * reading an unreadable set as empty satisfies the barrier vacuously.
   * When true, `allTerminal` is false and the barrier must not advance.
   */
  readFailed?: boolean;
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
  /** Epoch ms when the child entered its current state (for breach dedup). */
  stateEnteredAt: number | null;
  /** Dead-vs-slow classification from a liveness probe (AC2, G-12). Null until probed. */
  livenessClassification: "dead" | "slow" | null;
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
    const key = childIdentifier;
    const existing = this.deferrals.get(key);
    if (existing) {
      // Already deferring — accumulate what we have and restart
      existing.accumulatedMs += now - existing.startedAt;
      existing.startedAt = now;
    } else {
      this.deferrals.set(key, { startedAt: now, accumulatedMs: 0 });
    }
  }

  /** Stop tracking deferral for a child (e.g., when it becomes active again). */
  stopDeferral(childIdentifier: string, now: number = Date.now()): number {
    const key = childIdentifier;
    const entry = this.deferrals.get(key);
    if (!entry) return 0;
    const total = entry.accumulatedMs + (now - entry.startedAt);
    this.deferrals.delete(key);
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
 *
 * INF-34: returns **null** when the child set could not be read, and `[]` only
 * for a successful read of a parent that genuinely has no children. The two are
 * not interchangeable: `evaluateBarrier` reads `[]` as vacuous satisfaction
 * (the AI-1730 contract, which is correct), so reporting a failed read as an
 * empty one advances a parent past a barrier whose children it never read.
 *
 * A read is a failure if the request throws, the response is non-2xx, the body
 * is unparseable, the body carries GraphQL `errors`, or the issue/children
 * connection is absent — the last is malformed for a connection field, and
 * guessing "empty" from it is the same fail-open in a different disguise.
 */
export async function fetchChildren(
  parentIdentifier: string,
  authToken: string,
): Promise<ChildState[] | null> {
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
  const failed = (reason: string): null => {
    log.error(
      `barrier: failed to fetch children for ${parentIdentifier}: ${reason} — ` +
      `treating as UNREADABLE (not zero children); barrier will not advance`,
    );
    return null;
  };

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentIdentifier } }),
    });

    if (!res.ok) {
      return failed(`HTTP ${res.status} ${res.statusText}`);
    }

    type Resp = {
      errors?: Array<{ message?: string }>;
      data?: {
        issue?: {
          children?: {
            nodes?: Array<{
              identifier: string;
              state?: { name: string; type: string } | null;
              labels?: { nodes?: Array<{ name: string }> };
            }>;
          };
        } | null;
      };
    };

    let data: Resp;
    try {
      data = (await res.json()) as Resp;
    } catch (err) {
      return failed(`unparseable response body: ${err instanceof Error ? err.message : String(err)}`);
    }

    // A GraphQL error is a failed read even at HTTP 200 — Linear returns
    // `{ errors: [...] }` with no usable `data` on an internal error.
    if (data.errors?.length) {
      const messages = data.errors.map((e) => e.message ?? "unknown").join("; ");
      return failed(`GraphQL errors: ${messages}`);
    }

    // Belt-and-braces: without this the `.map` below throws on undefined and the
    // outer catch reaches the same `null`, but via a TypeError that reads like a
    // code bug rather than the read failure it is. Explicit beats incidental.
    const nodes = data.data?.issue?.children?.nodes;
    if (!nodes) {
      return failed("response contained no issue.children.nodes connection");
    }

    return nodes.map((node) => {
      const labels = (node.labels?.nodes ?? []).map((l) => l.name);
      const workflowState = getCurrentState(labels);
      // INF-108: a child is orphaned when it has no state:* label (it was
      // demoted off its workflow mid-flight). Such children can never reach a
      // terminal workflow state and hold the barrier indefinitely — the parent
      // steward needs to know about this to manually resolve the deadlock.
      const isOrphaned = workflowState === null && labels.length > 0;
      return {
        identifier: node.identifier,
        labels,
        isTerminal: isChildTerminal(labels),
        workflowState,
        isOrphaned,
      };
    });
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
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
 *
 * INF-34: an unreadable child set is reported as `readFailed` and never as
 * satisfaction. Fail-closed is the correct posture here specifically, against
 * this codebase's general fail-open lean: failing open on a *read* of barrier
 * state converts a transient network blip into silent state corruption that
 * nothing downstream can detect, because the parent has already moved on.
 */
/**
 * INF-28: optional set of expected child identifiers for barrier evaluation.
 * When provided, only these children are considered — all others are ignored.
 * This prevents stale siblings (from prior cycles) from pre-satisfying the
 * barrier. When absent, all children are evaluated (current behavior).
 */
export type ExpectedChildrenFilter = string[] | undefined;

export async function evaluateBarrier(
  parentIdentifier: string,
  authToken: string,
  expectedChildren?: ExpectedChildrenFilter,
): Promise<BarrierResult> {
  const children = await fetchChildren(parentIdentifier, authToken);

  // INF-28: filter to the expected set if provided. This is the core fix:
  // waiting on exactly the children this cycle's fan-out produced, not the
  // accumulated history of all children the parent has ever had.
  if (children !== null && expectedChildren && expectedChildren.length > 0) {
    const filtered = children.filter((c) => expectedChildren.includes(c.identifier));
    if (filtered.length === 0) {
      // No expected children found — treat as zero, which means
      // all-terminal (vacuous satisfaction for the expected set).
      return { allTerminal: true, totalChildren: 0, terminalCount: 0, orphanedCount: 0, children: [] };
    }
    const terminalCount = filtered.filter((c) => c.isTerminal).length;
    const orphanedCount = filtered.filter((c) => c.isOrphaned).length;
    return {
      allTerminal: orphanedCount === 0 && terminalCount === filtered.length,
      totalChildren: filtered.length,
      terminalCount,
      orphanedCount,
      children: filtered,
    };
  }

  // INF-34: could not read the children ≠ has no children. Must precede the
  // zero-children check below, which would otherwise read this as satisfied.
  if (children === null) {
    return { allTerminal: false, totalChildren: 0, terminalCount: 0, orphanedCount: 0, children: [], readFailed: true };
  }

  // AI-1730: zero children = vacuous satisfaction (barrier is trivially met).
  if (children.length === 0) {
    return { allTerminal: true, totalChildren: 0, terminalCount: 0, orphanedCount: 0, children: [] };
  }

  const terminalCount = children.filter((c) => c.isTerminal).length;
  const orphanedCount = children.filter((c) => c.isOrphaned).length;
  // INF-108: orphaned children can never reach terminal and hold the barrier
  // indefinitely. Treat the barrier as not-all-terminal if any orphan exists.
  const allTerminal = orphanedCount === 0 && terminalCount === children.length;
  return {
    allTerminal,
    totalChildren: children.length,
    terminalCount,
    orphanedCount,
    children,
  };
}

const UNREADABLE_CHILDREN_ERROR = "Failed to read child set — barrier held (INF-34)";

/**
 * INF-34: surface an unreadable child set. The barrier holds the parent in
 * place, which is recoverable — but a barrier that silently stops evaluating
 * is its own failure mode, so the hold is alarmed at error level and named on
 * the ticket. A parent that stays put is recoverable; one that has fallen
 * through is LIF-2.
 *
 * Best-effort: a comment failure must not mask the read failure it reports.
 */
async function alarmUnreadableChildren(
  parentIdentifier: string,
  authToken: string,
): Promise<void> {
  log.error(
    `barrier: ${parentIdentifier} — child set unreadable; holding the barrier. ` +
    `The parent stays in its barrier state until the children can be read.`,
  );
  try {
    const internalId = await resolveInternalId(parentIdentifier, authToken);
    if (!internalId) {
      log.error(`barrier: cannot alarm unreadable child set — failed to resolve ${parentIdentifier}`);
      return;
    }
    await postComment(
      internalId,
      `[Barrier] **Child set unreadable — barrier held on ${parentIdentifier}.**\n\n` +
      `The barrier could not read this parent's children (Linear API read failed). ` +
      `It is holding rather than advancing: an unreadable child set is not an empty one, ` +
      `and advancing on a read that never happened would move this parent past children ` +
      `that may still be in progress.\n\n` +
      `No action is required if this was a transient API error — the barrier re-evaluates ` +
      `on the next child transition. If this repeats, the read itself is broken and needs ` +
      `investigation. See the connector logs for the underlying error.`,
      authToken,
    );
  } catch (err) {
    log.error(
      `barrier: failed to post unreadable-child-set alarm for ${parentIdentifier}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * INF-108: alarm when the barrier evaluation finds orphaned children (children
 * that have been demoted off their workflow mid-flight). Orphaned children
 * hold the barrier indefinitely because they can never reach a terminal
 * workflow state. The parent steward needs to know which children are orphaned
 * and a clear escape path.
 *
 * Best-effort: a comment failure must not propagate.
 */
async function alarmOrphanedChildren(
  parentIdentifier: string,
  orphaned: Array<{ identifier: string; labels: string[] }>,
  authToken: string,
): Promise<void> {
  const orphanList = orphaned.map((c) => `- ${c.identifier}`).join("\n");
  log.error(
    `barrier: INF-108 orphaned-children-detected on ${parentIdentifier}: ` +
    `${orphaned.length} child(ren) demoted off their workflow — barrier held indefinitely. ` +
    `Orphaned: ${orphaned.map((c) => c.identifier).join(", ")}`,
  );
  try {
    const internalId = await resolveInternalId(parentIdentifier, authToken);
    if (!internalId) {
      log.error(`barrier: INF-108 cannot alarm orphaned children — failed to resolve ${parentIdentifier}`);
      return;
    }
    await postComment(
      internalId,
      `[Barrier] **Orphaned child(ren) detected — barrier held on ${parentIdentifier} (INF-108).**\n\n` +
      `The barrier found ${orphaned.length} child(ren) that have been demoted off their workflow:\n\n` +
      `${orphanList}\n\n` +
      `These children can never reach a terminal workflow state, so the barrier will NOT ` +
      `auto-advance. To resolve the deadlock, the steward must manually complete or escape ` +
      `the parent (\`linear complete ${parentIdentifier}\` or \`linear escape ${parentIdentifier}\`).\n\n` +
      `After resolving, consider whether the orphaned children need re-enrollment or closure.`,
      authToken,
    );
  } catch (err) {
    log.error(
      `barrier: INF-108 failed to post orphaned-children alarm for ${parentIdentifier}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
/**
 * INF-28: attempt a barrier transition, optionally scoped to an expected child set.
 * When `expectedChildren` is provided, only those children are evaluated.
 * When absent, reads the recorded fan-out outcome from the store (if any) and
 * uses the `awaiting` set as the filter. Falls back to all children (current
 * behavior) when no outcome or the outcome has no child set.
 */
export async function attemptBarrierTransition(
  parentIdentifier: string,
  authToken: string,
  workflowDef?: WorkflowDef,
  prefetchedParentState?: { labels: string[]; internalId: string; teamId: string } | null,
  expectedChildren?: ExpectedChildrenFilter,
): Promise<BarrierTransitionResult> {
  const result: BarrierTransitionResult = {
    transitioned: false,
    parentIdentifier,
    terminalCount: 0,
    totalChildren: 0,
  };

  // INF-28: resolve expected children from the store if not provided.
  // This handles the onChildTerminal path where the outcome was recorded
  // when the parent entered the barrier state.
  let childFilter = expectedChildren;
  let outcomeType: string | undefined;
  if (childFilter === undefined) {
    const outcome = await getFanoutOutcome(parentIdentifier);
    if (outcome) {
      outcomeType = outcome.outcome;
      if (outcome.outcome === "awaiting" && outcome.childIdentifiers && outcome.childIdentifiers.length > 0) {
        childFilter = outcome.childIdentifiers;
        log.info(
          `barrier: INF-28 attemptBarrierTransition scoped to recorded set for ${parentIdentifier}: ` +
          `${childFilter.join(", ")}`,
        );
      }
    }
  }

  // INF-28: a recorded non-proceed outcome (refused, failed, or pending-approval)
  // means the barrier must not advance from this path either. Even if the
  // children list is empty (AI-1730 vacuous satisfaction), the outcome tells us
  // the parent is blocked deliberately — the fan-out did not produce a valid set.
  if (outcomeType === "refused" || outcomeType === "failed") {
    result.error = `Fan-out ${outcomeType} — barrier held (INF-28, from recorded outcome)`;
    log.warn(
      `barrier: INF-28 attemptBarrierTransition: ${parentIdentifier} has recorded outcome ` +
      `'${outcomeType}' — barrier will not advance`,
    );
    return result;
  }
  if (outcomeType === "pending-approval") {
    result.error = "Fan-out pending steward approval — barrier held (INF-28)";
    log.info(
      `barrier: INF-28 attemptBarrierTransition: ${parentIdentifier} has recorded outcome ` +
      `'pending-approval' — barrier will not advance`,
    );
    return result;
  }

  // 1. Evaluate barrier
  const barrier = await evaluateBarrier(parentIdentifier, authToken, childFilter);
  result.terminalCount = barrier.terminalCount;
  result.totalChildren = barrier.totalChildren;

  // INF-34: fail closed on an unreadable child set. Checked before allTerminal
  // so the hold is alarmed rather than logged as a routine not-ready-yet.
  if (barrier.readFailed) {
    result.error = UNREADABLE_CHILDREN_ERROR;
    await alarmUnreadableChildren(parentIdentifier, authToken);
    return result;
  }

  // INF-108: detect orphaned children before the generic not-all-terminal log.
  // Orphaned children (demoted off their workflow) can never reach a terminal
  // state and hold the barrier indefinitely. Surface them as a named condition.
  if (barrier.orphanedCount > 0) {
    const orphanedChildren = barrier.children.filter((c) => c.isOrphaned);
    await alarmOrphanedChildren(parentIdentifier, orphanedChildren, authToken);
    result.error = `INF-108: ${barrier.orphanedCount} orphaned child(ren) detected — barrier held indefinitely`;
    return result;
  }

  // AI-1730: zero children is now a valid barrier state (vacuous satisfaction);
  // do NOT early-return — fall through to the managing-state check.
  if (!barrier.allTerminal) {
    log.info(
      `barrier: not all children terminal for ${parentIdentifier} — ` +
      `${barrier.terminalCount}/${barrier.totalChildren} done`,
    );
    return result; // Not an error — just not ready yet
  }

  // 2. Verify parent is in a barrier state
  //    Use pre-fetched state if provided (avoids redundant API call)
  const parentState = prefetchedParentState ?? await fetchParentState(parentIdentifier, authToken);
  if (!parentState) {
    result.error = "Failed to fetch parent state";
    return result;
  }

  const workflowId = getWorkflowId(parentState.labels);
  if (!workflowId) {
    result.error = "No workflow ID found on parent labels";
    return result;
  }

  const currentState = getCurrentState(parentState.labels);
  if (!currentState) {
    result.error = "No state:* label found on parent";
    return result;
  }

  // AI-1992: barrier-ness is config-driven. Load the parent's workflow def and
  // confirm its CURRENT state declares `barrier: true`. No hardcoded workflow-id
  // allowlist and no hardcoded "managing" state name — a def may have multiple
  // barrier states (two-phase) under any workflow id.
  let wfDef: WorkflowDef | null = workflowDef ?? null;
  if (!wfDef) {
    try {
      wfDef = await loadWorkflowDefById(workflowId);
    } catch {
      wfDef = null;
    }
  }
  const currentStateDef = wfDef?.states.find((s) => s.id === currentState);
  if (!isBarrierState(currentStateDef)) {
    log.info(`barrier: parent ${parentIdentifier} state '${currentState}' (wf:${workflowId}) is not a barrier state — skipping`);
    result.error = `Parent state '${currentState}' on wf:${workflowId} is not a barrier state`;
    return result;
  }

  // Barrier target: advance along THIS barrier state's forward transition —
  // prefer the `complete` command, else the first non-break-glass transition.
  // This is what makes two-phase (managing-arm → impl, managing-impl → done)
  // work without any hardcoded managing → review/validating assumption.
  const barrierTarget = resolveBarrierTarget(wfDef!, currentStateDef!);
  if (!barrierTarget) {
    result.error = `Barrier state '${currentState}' has no forward transition to advance to`;
    return result;
  }

  // 3. Atomic label swap: state:<currentState> → state:<barrierTarget>
  // We need the label IDs, not just the names — re-fetch with IDs
  const parentWithLabels = await fetchParentWithLabelIds(parentIdentifier, authToken);
  if (!parentWithLabels) {
    result.error = "Failed to fetch parent label IDs";
    return result;
  }

  const currentStateLabelNode = parentWithLabels.labels.find((l) => l.name === `state:${currentState}`);
  if (!currentStateLabelNode) {
    result.error = `No state:${currentState} label found on parent`;
    return result;
  }

  const reviewLabelId = await findOrCreateLabel(
    parentWithLabels.teamId,
    `state:${barrierTarget}`,
    authToken,
  );
  if (!reviewLabelId) {
    result.error = `Failed to resolve state:${barrierTarget} label`;
    return result;
  }

  const newLabelIds = [
    ...parentWithLabels.labels.filter((l) => l.id !== currentStateLabelNode.id).map((l) => l.id),
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
    `Auto-advancing parent ${currentState} → ${barrierTarget}.\n\n${childSummary}`;
  await postComment(parentWithLabels.internalId, commentBody, authToken);

  result.transitioned = true;
  log.info(
    `barrier: ${parentIdentifier} ${currentState} → ${barrierTarget} ` +
    `(${barrier.terminalCount}/${barrier.totalChildren} children terminal)`,
  );
  return result;
}

/**
 * AI-1992: Resolve a barrier state's forward target — the state it auto-advances
 * to when the barrier is satisfied. Prefers the `complete` command (the canonical
 * barrier edge), else the first transition that is not the def's break-glass
 * command. Returns undefined when the state has no eligible forward transition.
 *
 * INF-122: exported for anti-entropy AC2 (barrier missed) and engine-watch
 * detection paths, which re-evaluate barriers on a periodic sweep rather than
 * relying solely on the event-driven webhook path.
 */
export function resolveBarrierTarget(def: WorkflowDef, state: WorkflowState): string | undefined {
  const transitions = state.transitions ?? [];
  const complete = transitions.find((t) => t.command === "complete");
  if (complete) return complete.to;
  const breakGlass = def.break_glass?.command ?? "escape";
  const forward = transitions.find((t) => t.command !== breakGlass);
  return forward?.to;
}

/**
 * AI-1730 / INF-28: Entry-time barrier check for a parent entering a barrier state.
 *
 * Called unconditionally after the fan-out block in workflow-gate.ts.
 *
 * INF-28: Before evaluating children, reads the recorded fan-out outcome from the
 * store. The outcome tells the barrier what happened at fan-out time:
 *
 * | Outcome | Behavior |
 * |---------|----------|
 * | `awaiting:[ids]` | Filter children to the recorded set; wait on those only |
 * | `not-declared` / `waived` / absent | Current behavior (all children all-terminal) |
 * | `refused` / `failed` | Block + alarm (barrier cannot advance) |
 * | `pending-approval` | Block, no alarm (steward will wake it) |
 *
 * Returns BarrierTransitionResult if a transition was attempted,
 * null if the barrier is not yet satisfied (not an error).
 */
export async function onManagingEntry(
  parentIdentifier: string,
  authToken: string,
): Promise<BarrierTransitionResult | null> {
  // INF-28: Read the recorded fan-out outcome, if any.
  const outcome = await getFanoutOutcome(parentIdentifier);

  // INF-28: Handle non-advancing outcomes that block with or without alarm.
  if (outcome) {
    switch (outcome.outcome) {
      case "refused": {
        log.warn(
          `barrier: INF-28 outcome 'refused' for ${parentIdentifier} — ` +
          `fan-out was refused (bad spec / cap violation). Barrier will not advance.`,
        );
        return {
          transitioned: false,
          parentIdentifier,
          terminalCount: 0,
          totalChildren: 0,
          error: "Fan-out refused — barrier held (INF-28)",
        };
      }
      case "failed": {
        log.error(
          `barrier: INF-28 outcome 'failed' for ${parentIdentifier} — ` +
          `fan-out attempted but failed to create children. Barrier will not advance.`,
        );
        return {
          transitioned: false,
          parentIdentifier,
          terminalCount: 0,
          totalChildren: 0,
          error: "Fan-out failed — barrier held (INF-28)",
        };
      }
      case "pending-approval": {
        log.info(
          `barrier: INF-28 outcome 'pending-approval' for ${parentIdentifier} — ` +
          `steward approval outstanding. Barrier will not advance until approved.`,
        );
        return {
          transitioned: false,
          parentIdentifier,
          terminalCount: 0,
          totalChildren: 0,
          error: "Fan-out pending steward approval — barrier held (INF-28)",
        };
      }
      case "awaiting": {
        // Use the recorded set as the expected children filter.
        // All other children (stale siblings from prior cycles) are ignored.
        if (outcome.childIdentifiers && outcome.childIdentifiers.length > 0) {
          log.info(
            `barrier: INF-28 outcome 'awaiting' for ${parentIdentifier} — ` +
            `evaluating barrier against ${outcome.childIdentifiers.length} recorded child(ren) ` +
            `(${outcome.childIdentifiers.join(", ")})`,
          );
          const barrier = await evaluateBarrier(parentIdentifier, authToken, outcome.childIdentifiers);

          if (barrier.readFailed) {
            await alarmUnreadableChildren(parentIdentifier, authToken);
            return {
              transitioned: false,
              parentIdentifier,
              terminalCount: 0,
              totalChildren: 0,
              error: UNREADABLE_CHILDREN_ERROR,
            };
          }

          if (!barrier.allTerminal) {
            return null;
          }

          log.info(
            `barrier: INF-28 onManagingEntry: awaiting set all-terminal for ${parentIdentifier} ` +
            `(${barrier.terminalCount}/${barrier.totalChildren}) — attempting transition`,
          );
          return attemptBarrierTransition(parentIdentifier, authToken);
        }
        // fall through: empty awaiting set → treat as claimed (no children to wait on)
        break;
      }
      case "not-declared":
      case "waived": {
        log.info(
          `barrier: INF-28 outcome '${outcome.outcome}' for ${parentIdentifier} — ` +
          `using current behavior (no spec-matched children to constrain)`,
        );
        break; // fall through to current behavior
      }
    }
  }

  // 1. Evaluate the barrier (current behavior for absent / not-declared / waived)
  const barrier = await evaluateBarrier(parentIdentifier, authToken);

  // INF-34: an unreadable child set is not "children still active" — returning
  // null here would be logged by the caller as normal flow, which is how the
  // original fail-open deleted its own alarm. Return a result carrying the
  // error instead, and hold the parent in place.
  if (barrier.readFailed) {
    await alarmUnreadableChildren(parentIdentifier, authToken);
    return {
      transitioned: false,
      parentIdentifier,
      terminalCount: 0,
      totalChildren: 0,
      error: UNREADABLE_CHILDREN_ERROR,
    };
  }

  // INF-108: orphaned children (demoted off workflow mid-flight) hold the
  // barrier indefinitely. Surface them as a named condition rather than
  // returning null (which looks like normal "children still active").
  if (barrier.orphanedCount > 0) {
    const orphanedChildren = barrier.children.filter((c) => c.isOrphaned);
    await alarmOrphanedChildren(parentIdentifier, orphanedChildren, authToken);
    return {
      transitioned: false,
      parentIdentifier,
      terminalCount: barrier.terminalCount,
      totalChildren: barrier.totalChildren,
      error: `INF-108: ${barrier.orphanedCount} orphaned child(ren) detected — barrier held indefinitely`,
    };
  }

  // 2. If barrier is not satisfied, return null (normal flow — children still active)
  if (!barrier.allTerminal) {
    return null;
  }

  // 3. Barrier is satisfied — attempt the transition
  log.info(
    `barrier: AI-1730 onManagingEntry: barrier satisfied for ${parentIdentifier} ` +
    `(${barrier.terminalCount}/${barrier.totalChildren} terminal) — attempting transition`,
  );
  return attemptBarrierTransition(parentIdentifier, authToken);
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
  if (!workflowId) return null;

  // AI-1992: config-driven — the parent's current state must declare barrier:true.
  const currentState = getCurrentState(parentState.labels);
  if (!currentState) return null;
  let wfDef: WorkflowDef | null = null;
  try {
    wfDef = await loadWorkflowDefById(workflowId);
  } catch {
    wfDef = null;
  }
  const currentStateDef = wfDef?.states.find((s) => s.id === currentState);
  if (!isBarrierState(currentStateDef)) {
    log.info(`barrier: parent ${parentIdentifier} state '${currentState}' (wf:${workflowId}) is not a barrier state — skipping`);
    return null;
  }

  // 3. Attempt the barrier transition, passing pre-fetched parent state + def
  log.info(`barrier: child ${childIdentifier} terminal, checking barrier for parent ${parentIdentifier}`);
  return attemptBarrierTransition(parentIdentifier, authToken, wfDef ?? undefined, parentState);
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

/**
 * Pure predicate: returns true if the given parent labels indicate the parent
 * is currently in a barrier state (config-driven).
 *
 * AI-1992: barrier-ness is per-state (`barrier: true`), not a workflow-id
 * allowlist. The caller supplies the loaded workflow-def registry (the sla-sweep
 * batch path already has it in scope) so this stays a synchronous predicate.
 *
 * Shared by isManagedBarrierChild (async/fetch path) and the sla-sweep driver
 * (batch-embedded path) so both paths use the same logic — no re-implementation.
 */
export function isManagedBarrierFromLabels(
  parentLabels: string[],
  defs: Map<string, WorkflowDef>,
): boolean {
  const wfId = getWorkflowId(parentLabels);
  const state = getCurrentState(parentLabels);
  if (!wfId || !state) return false;
  const stateDef = defs.get(wfId)?.states.find((s) => s.id === state);
  return isBarrierState(stateDef);
}

/**
 * Returns true if the given issue is a managed child of a barrier workflow
 * parent currently in managing state (i.e. the barrier stall path owns it).
 *
 * Covers all BARRIER_WORKFLOWS (ux-audit, sprint, vocab-builder, word-build),
 * replacing the ux-audit-only isChildOfUxAuditParent for sla-sweep exclusion.
 * The sla-sweep driver imports and uses this function — not a parallel heuristic.
 */
export async function isManagedBarrierChild(
  issueIdentifier: string,
  authToken: string,
): Promise<boolean> {
  const query = `
    query IsManagedBarrierChild($id: String!) {
      issue(id: $id) {
        parent {
          labels { nodes { name } }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueIdentifier } }),
    });
    type Resp = {
      data?: {
        issue?: {
          parent?: { labels: { nodes: Array<{ name: string }> } } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const parent = data.data?.issue?.parent;
    if (!parent) return false;
    // AI-1992: config-driven — load the registry and evaluate the parent's
    // current state's barrier flag against its workflow def.
    const registry = await loadWorkflowRegistry();
    return isManagedBarrierFromLabels(parent.labels.nodes.map((l) => l.name), registry);
  } catch {
    return false;
  }
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
        history(first: 100, orderBy: createdAt) {
          nodes {
            __typename
            createdAt
            addedLabelIds
            removedLabelIds
            fromState { name }
            toState { name }
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
      addedLabelIds?: string | null;
      removedLabelIds?: string | null;
      fromState?: { name: string } | null;
      toState?: { name: string } | null;
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

    // Find the most recent history entry as a best-effort state entry timestamp.
    // In the new Linear schema, IssueLabelPayload no longer exists — history entries
    // are flat IssueHistory objects with fromState/toState for native state changes.
    for (const node of historyNodes) {
      if (node.createdAt) {
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
): Promise<StalledChild[]> {
  const children = await fetchChildren(parentIdentifier, authToken);
  // INF-34: an unreadable child set yields no stall detection this round rather
  // than a confident "nothing is stalled". Stall detection is advisory and
  // re-runs on the next poll, so holding is not required here — but the empty
  // result must not be mistaken for a healthy read.
  if (children === null) {
    log.error(
      `barrier: cannot detect stalled children for ${parentIdentifier} — child set unreadable; ` +
      `skipping this round (no stall conclusions drawn)`,
    );
    return [];
  }
  const stalled: StalledChild[] = [];

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

    // Look up per-state SLA from workflow def (duration string → ms)
    let stateSlaMs: number | null = null;
    if (def && child.workflowState) {
      const stateDef = def.states.find((s) => s.id === child.workflowState);
      if (stateDef?.sla) {
        stateSlaMs = parseSlaToMs(stateDef.sla);
      }
    }

    // Known-deferral accounting (at-capacity, §16.1)
    const isDeferredAtCapacity = acct.isDeferring(child.identifier);
    const knownDeferralMs = acct.getDeferralMs(child.identifier, now);

    // Determine effective threshold: per-state SLA or flat fallback
    const effectiveThresholdMs = stateSlaMs ?? stallThresholdMs;

    // Effective time in state = time in state minus known deferral
    // At-capacity children get their deferral time subtracted so they don't
    // trip stall escalation (AC2)
    const effectiveTimeMs = Math.max(0, timeInStateMs - knownDeferralMs);

    // Skip at-capacity children: they are deferred but healthy (AC2)
    if (isDeferredAtCapacity) {
      // Even though they might have a large time-in-state, they are accounted for
      // and should not trigger stall escalation
      continue;
    }

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

  return stalled;
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
    stateEnteredAt: child.stateEnteredAt,
    livenessClassification: null,
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
): Promise<{ surfaced: number; events: StallEvent[] }> {
  const stalled = await detectStalledChildren(parentIdentifier, authToken, stallThresholdMs);
  if (stalled.length === 0) return { surfaced: 0, events: [] };

  const events: StallEvent[] = stalled.map((child) => buildStallEvent(child));

  // INF-34: `stalled` is non-empty here, so the child set read moments ago in
  // detectStalledChildren succeeded. A failure on this second read is transient;
  // report the stall events without the full-roster context rather than dropping
  // detections that were made against a good read.
  const children = await fetchChildren(parentIdentifier, authToken) ?? [];
  const message = buildShepherdingMessage(parentIdentifier, children, stalled);

  const internalId = await resolveInternalId(parentIdentifier, authToken);
  if (!internalId) {
    log.error(`barrier: cannot surface stalled children — failed to resolve ${parentIdentifier}`);
    return { surfaced: 0, events };
  }

  const posted = await postComment(internalId, message, authToken);
  if (posted) {
    log.info(
      `barrier: §5.5/§16.1 — emitted ${events.length} stall event(s) on ${parentIdentifier}`,
    );
  }
  return { surfaced: events.length, events };
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
