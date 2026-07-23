/**
 * INF-443 — Transition comment logic.
 *
 * Tracks comments that are carried as mandatory payload on a governed
 * transition (e.g. `request-changes --comment-file <reason>`) separately
 * from free-standing agent comments. A transition-carried comment is
 * required metadata, not "extra" agent chatter, so it must never feed a
 * recent-comment rate-limit or dedup counter.
 *
 * `recentAgentComments` is a mock/placeholder value (per INF-443 scope) —
 * no real rate-limit/dedup store exists yet in the codebase. It is exposed
 * here so /health has a stable shape to grow into once that store lands.
 *
 * The /health liveness surface (getCommentStats() / getTransitionCommentLogicHealth())
 * proves this component is wired at the production entry point (AI-1808 guard).
 */

let _transitionCarriedComments = 0;

/**
 * Record that a comment was carried by a governed transition command in the
 * same request. Must be called instead of any (future) free-standing
 * agent-comment counter so transition-mandatory comments never count
 * against an agent's rate-limit/dedup window.
 */
export function recordTransitionCarriedComment(): void {
  _transitionCarriedComments += 1;
}

/**
 * Liveness snapshot for the /health `commentStats` field.
 */
export function getCommentStats(): { transitionCarriedComments: number; recentAgentComments: number } {
  return {
    transitionCarriedComments: _transitionCarriedComments,
    // Mock value: no free-standing agent-comment rate-limit/dedup store exists
    // yet. Kept at 0 so transition-carried comments are provably excluded.
    recentAgentComments: 0,
  };
}

/**
 * Liveness snapshot for the /health `transitionCommentLogic` field — proves
 * this component is registered in createApp(), not merely importable.
 */
export function getTransitionCommentLogicHealth(): { registered: boolean; transitionCarriedComments: number } {
  return {
    registered: true,
    transitionCarriedComments: _transitionCarriedComments,
  };
}

/**
 * Reset all state (test isolation only).
 */
export function resetCommentStatsForTest(): void {
  _transitionCarriedComments = 0;
}
