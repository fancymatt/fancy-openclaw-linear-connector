/**
 * AI-2565: CAS stale-snapshot check for terminal transitions.
 *
 * Terminal transitions (handoff-work, complete-work, needs-human, refuse-work)
 * on a ticket whose Linear `updatedAt` has changed since the dispatch snapshot
 * are refused — a sibling session may have already modified the ticket.
 *
 * Edge case: if all changes since the snapshot were made by the current
 * agent's own comments (self-only modifications), the check is skipped —
 * the agent is working with the state it knows.
 *
 * This is the CAS enforcement counterpart to canon rule 10 (advisory
 * honor-system). It makes the check structural rather than advisory.
 */

import type { DispatchLeaseStore } from "./store/dispatch-lease-store.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "proxy");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Terminal / delegate-routing intents that may race with sibling sessions. */
const TERMINAL_INTS = new Set([
  "handoff-work",
  "complete-work",
  "needs-human",
  "refuse-work",
]);

/**
 * Resolve a UUID issue ID to its human-readable identifier (e.g. "AI-2565").
 * Returns null on failure.
 */
async function resolveHumanIdentifier(
  uuidId: string,
  authorization: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { identifier } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ query, variables: { id: uuidId } }),
    });
    type Resp = { data?: { issue?: { identifier: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.identifier ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the current issue's `updatedAt` and human-readable identifier.
 * Returns null on failure.
 */
async function fetchIssueUpdatedAt(
  issueId: string,
  authorization: string,
): Promise<{ updatedAt: string; identifier: string } | null> {
  const query = `query($id: String!) { issue(id: $id) { identifier updatedAt } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = { data?: { issue?: { identifier: string; updatedAt: string } | null } };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue?.identifier || !issue?.updatedAt) return null;
    return { updatedAt: issue.updatedAt, identifier: issue.identifier };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`stale-snapshot: fetch issue failed for ${issueId}: ${msg}`);
    return null;
  }
}

/**
 * Check whether any comments were posted after the dispatch snapshot by someone
 * other than the current agent. Returns true if the only post-dispatch comments
 * are from the current agent (self-only modification).
 * Returns null when the check cannot be performed (fail-open to pass-through).
 */
async function isSelfOnlyChange(
  issueId: string,
  snapshotUpdatedAt: string,
  callerLinearUserId: string | null,
  authorization: string,
): Promise<boolean | null> {
  if (!callerLinearUserId) return null;
  const query = `
    query($id: String!) {
      issue(id: $id) {
        comments(first: 10, orderBy: createdAt) {
          nodes { createdAt user { id } }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          comments?: { nodes: Array<{ createdAt: string; user?: { id: string } | null }> };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.comments?.nodes ?? [];
    const dispatchTime = new Date(snapshotUpdatedAt).getTime();

    const postDispatch = nodes.filter(
      (c) => new Date(c.createdAt).getTime() > dispatchTime,
    );
    if (postDispatch.length === 0) return true; // no changes at all
    return postDispatch.every((c) => c.user?.id === callerLinearUserId);
  } catch {
    return null;
  }
}

/**
 * CAS stale-snapshot check.
 *
 * Before a terminal/delegate-routing transition is forwarded, check whether
 * the ticket has been modified since it was dispatched to this agent. If it
 * has, refuse with a clear error — the agent must re-read and re-evaluate.
 *
 * The edge case (self-only comments from the current session) is allowed
 * through since the agent is working with the state it knows.
 *
 * @param effectiveIntent - The resolved intent (e.g. "handoff-work").
 * @param issueId - The ticket identifier (human-readable like "AI-2565" or UUID).
 * @param agentId - The calling agent's ID.
 * @param authorization - Linear API auth token.
 * @param callerLinearUserId - The caller's Linear user ID (for self-comment check).
 * @param leaseStore - The dispatch lease store, or undefined to pass through.
 * @returns A rejection message string, or null if safe to proceed.
 */
export async function checkStaleSnapshotForTerminal(
  effectiveIntent: string,
  issueId: string,
  agentId: string,
  authorization: string,
  callerLinearUserId: string | null,
  leaseStore?: DispatchLeaseStore,
): Promise<string | null> {
  // Only applies to terminal/routing intents
  if (!TERMINAL_INTS.has(effectiveIntent)) return null;
  if (!leaseStore) return null; // no lease store = pass-through

  // Fetch the issue's current updatedAt and identifier
  const current = await fetchIssueUpdatedAt(issueId, authorization);
  if (!current) return null; // can't check = pass-through (fail-open)

  // Look up the lease using the human-readable identifier
  const lease = leaseStore.get(agentId, current.identifier);
  if (!lease) return null; // no active lease = pass-through

  const snapshotUpdatedAt = lease.ticket_updated_at;
  if (!snapshotUpdatedAt) return null; // no snapshot = pass-through

  // If updatedAt hasn't changed, the ticket is still current
  if (current.updatedAt === snapshotUpdatedAt) return null;

  // updatedAt differs — check if the only changes are self-comments
  const selfOnly = await isSelfOnlyChange(
    current.identifier,
    snapshotUpdatedAt,
    callerLinearUserId,
    authorization,
  );

  if (selfOnly === true) {
    log.info(
      `stale-snapshot-self-only agent=${agentId} intent=${effectiveIntent} ticket=${current.identifier}: ` +
      `updatedAt changed (${snapshotUpdatedAt} → ${current.updatedAt}) but only self-comments — allowing through`,
    );
    return null;
  }

  // Stale — refuse the terminal transition
  // Build a human-readable explanation of what happened
  const snapshotTime = new Date(snapshotUpdatedAt).toISOString();
  const currentTime = new Date(current.updatedAt).toISOString();

  log.warn(
    `stale-snapshot-block agent=${agentId} intent=${effectiveIntent} ticket=${current.identifier}: ` +
    `snapshot=${snapshotTime} current=${currentTime}`,
  );

  return (
    `[Proxy] '${effectiveIntent}' refused: the ticket has been modified since your dispatch snapshot. ` +
    `When you received this ticket, the issue was at version ${snapshotTime}; ` +
    `it is now at ${currentTime}. New comments or state changes were detected by another session. ` +
    `Re-read the ticket with \`linear observe-issue ${current.identifier}\` ` +
    `and re-evaluate before acting. If you believe this is an error, re-run the command.`
  );
}
