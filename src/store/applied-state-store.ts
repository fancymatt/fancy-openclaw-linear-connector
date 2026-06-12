/**
 * AI-1534 — Authoritative post-transition state cache.
 *
 * Linear's GraphQL reads are eventually consistent. After the connector applies
 * a state transition (the proxy is the SOLE writer of transitions — see
 * applyStateTransition), a near-immediate label read by the outbound per-step
 * delivery path (build-message.ts → fetchWorkflowLabels) can still return the
 * PRE-transition state. That read-after-write lag made a freshly-reassigned
 * delegate (e.g. tdd on AI-1531) be told to run the previous state's verb
 * (`accept` from `write-tests`), which the gate then rejected as illegal,
 * stalling the ticket.
 *
 * Because the connector knows the authoritative destination state at write time,
 * we record it here, keyed by human issue identifier (e.g. "AI-1531"), with a
 * short TTL. The delivery path prefers this value over the (possibly-stale) live
 * read while it is fresh. After the TTL the live read is authoritative again.
 *
 * In-memory only: the lag window is seconds, and a connector restart drops
 * in-flight deliveries anyway. Keeping it off-disk also avoids the shared
 * /tmp state-file hazard that has bitten other stores.
 */

/** How long a recorded post-transition state is trusted over a live read. */
export const APPLIED_STATE_TTL_MS = 60_000;

interface AppliedState {
  state: string;
  appliedAt: number;
}

const _store = new Map<string, AppliedState>();

function normalizeKey(issueId: string): string {
  return issueId.trim().toUpperCase();
}

/** Record the authoritative destination state for a just-applied transition. */
export function recordAppliedState(issueId: string, state: string, now: number = Date.now()): void {
  if (!issueId) return;
  _store.set(normalizeKey(issueId), { state, appliedAt: now });
}

/**
 * Return the recorded post-transition state if it is still within the TTL,
 * else null. Expired entries are evicted on read.
 */
export function getAppliedState(issueId: string, now: number = Date.now()): string | null {
  if (!issueId) return null;
  const key = normalizeKey(issueId);
  const entry = _store.get(key);
  if (!entry) return null;
  if (now - entry.appliedAt > APPLIED_STATE_TTL_MS) {
    _store.delete(key);
    return null;
  }
  return entry.state;
}

/**
 * Drop any recorded state for a ticket. Called when a ticket leaves the
 * workflow (demote to ad-hoc) or reaches a terminal disposition, so a stale
 * cached state can never override a later live read.
 */
export function clearAppliedState(issueId: string): void {
  if (!issueId) return;
  _store.delete(normalizeKey(issueId));
}

/** Test helper — reset the in-memory store between cases. */
export function _resetAppliedStateStore(): void {
  _store.clear();
}
