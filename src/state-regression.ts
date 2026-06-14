/**
 * AI-1547 / AI-1594 — Governed state:* label regression guard.
 *
 * AC3: Stale webhooks carrying an older state:* label set must NOT cause
 *      backwards routing/delegate correction.
 * AC4: Emit a warning when a ticket is observed transitioning to an earlier
 *      workflow state without a corresponding B2 apply (corruption canary).
 */

import type { WorkflowDef } from "./workflow-gate.js";

// ── State ranking ────────────────────────────────────────────────────────────

/**
 * Returns the BFS rank of a state in the forward path of the workflow
 * (entry_state = 0, each reachable successor increments).
 * States not reachable via the forward transition graph (unknown states, break-glass
 * terminals like "escape" that have no incoming transitions from the main path)
 * return null.
 */
export function rankStateInWorkflow(stateId: string, def: WorkflowDef): number | null {
  if (!def.entry_state) return null;

  const visited = new Map<string, number>();
  const queue: string[] = [def.entry_state];
  visited.set(def.entry_state, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const state = def.states.find((s) => s.id === current);
    if (!state) continue;

    for (const transition of state.transitions ?? []) {
      if (!visited.has(transition.to)) {
        visited.set(transition.to, visited.size);
        queue.push(transition.to);
      }
    }
  }

  return visited.has(stateId) ? (visited.get(stateId) as number) : null;
}

/**
 * Returns true when observedState ranks strictly before lastKnownState in the
 * workflow's forward path — i.e. the observed snapshot is stale / regressed.
 * Returns false (fail open) when either state is not ranked (unknown or break-glass).
 */
export function isStateBackwards(
  observedState: string,
  lastKnownState: string,
  def: WorkflowDef,
): boolean {
  const observedRank = rankStateInWorkflow(observedState, def);
  const lastKnownRank = rankStateInWorkflow(lastKnownState, def);

  if (observedRank === null || lastKnownRank === null) return false;

  return observedRank < lastKnownRank;
}

// ── Regression detection ─────────────────────────────────────────────────────

export interface StateRegressionResult {
  isRegression: boolean;
  warning?: string;
  observedState?: string;
  lastKnownState?: string;
}

/**
 * Inspects a webhook's label snapshot against the last B2-confirmed state.
 * Returns a regression result with an operational warning when the snapshot
 * carries a state:* label that is earlier than lastKnownState in the workflow
 * (AC4 corruption canary). Returns { isRegression: false } in all safe paths.
 */
export function detectStateRegression(
  ticketId: string,
  labels: string[],
  lastKnownState: string | null,
  def: WorkflowDef,
): StateRegressionResult {
  // No wf:* label → ad-hoc ticket, not governed
  if (!labels.some((l) => l.startsWith("wf:"))) {
    return { isRegression: false };
  }

  // No state:* label → enrollment-gap ticket, no basis for comparison
  const stateLabel = labels.find((l) => l.startsWith("state:"));
  if (!stateLabel) return { isRegression: false };
  const observedState = stateLabel.slice("state:".length);

  // No last-known state → freshly seen ticket, no basis for comparison
  if (lastKnownState === null) return { isRegression: false };

  if (!isStateBackwards(observedState, lastKnownState, def)) {
    return { isRegression: false };
  }

  return {
    isRegression: true,
    observedState,
    lastKnownState,
    warning:
      `[${ticketId}] State regression detected: observed "${observedState}" but ` +
      `last known state is "${lastKnownState}". Webhook snapshot is stale — skipping delegate correction.`,
  };
}

// ── High-water-mark tracker ──────────────────────────────────────────────────

export interface StateHighWaterMarkTracker {
  /** Returns the last B2-confirmed state for a ticket, or null if never seen. */
  getLastKnownState(ticketId: string): string | null;
  /**
   * Attempts to advance the tracked state for a ticket.
   * - Returns false and updates the stored state when the new state is at or
   *   ahead of the current high-water mark (or when the ticket is freshly seen).
   * - Returns true and leaves the stored state unchanged when the new state is
   *   backwards (regression attempt detected — AC4 signal).
   * When no WorkflowDef was supplied at construction time the tracker accepts
   * all advances (it cannot rank states without a def); callers that need
   * regression rejection must supply a def.
   */
  advance(ticketId: string, state: string): boolean;
}

export function createStateHighWaterMarkTracker(def?: WorkflowDef): StateHighWaterMarkTracker {
  const highWaterMarks = new Map<string, string>();

  return {
    getLastKnownState(ticketId: string): string | null {
      return highWaterMarks.get(ticketId) ?? null;
    },

    advance(ticketId: string, newState: string): boolean {
      const current = highWaterMarks.get(ticketId);

      if (current === undefined) {
        highWaterMarks.set(ticketId, newState);
        return false;
      }

      if (def !== undefined && isStateBackwards(newState, current, def)) {
        // Regression: high-water mark is not updated
        return true;
      }

      highWaterMarks.set(ticketId, newState);
      return false;
    },
  };
}
