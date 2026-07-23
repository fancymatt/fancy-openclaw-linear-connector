import { buildAgentMap, getAccessToken, getAgent } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { normalizeSessionKey } from "./session-key.js";
import type { LinearEvent } from "./webhook/schema.js";

const log = componentLogger(createLogger(), "linear-actionable");

const TERMINAL_STATE_TYPES = new Set(["completed", "canceled", "cancelled", "duplicate"]);
const TERMINAL_STATE_NAMES = new Set(["done", "canceled", "cancelled", "duplicate"]);
const PARKED_STATE_TYPES = new Set(["backlog"]);
const PARKED_STATE_NAMES = new Set(["backlog"]);

export function isTerminalIssueState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  return TERMINAL_STATE_TYPES.has(type) || TERMINAL_STATE_NAMES.has(name);
}

export function isParkedIssueState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  return PARKED_STATE_TYPES.has(type) || PARKED_STATE_NAMES.has(name);
}

export interface LinearIssueState {
  name?: string;
  type?: string;
}

export interface LinearIssueReference {
  id?: string;
  identifier?: string;
  state?: LinearIssueState | null;
}

export interface LinearIssueRelation {
  type?: string;
  issue?: LinearIssueReference | null;
  relatedIssue?: LinearIssueReference | null;
}

export interface LinearUserReference {
  id?: string;
  name?: string;
  /**
   * Linear's `User.app` flag: true for application/bot users (our agents),
   * false for real people. Present on the assignee selection so the
   * human-blocked prune (AI-2295) can tell a human parking a ticket apart
   * from an agent holding it.
   */
  app?: boolean | null;
}

export interface LinearIssueWithRelations extends LinearIssueReference {
  delegate?: LinearUserReference | null;
  assignee?: LinearUserReference | null;
  relations?: { nodes?: LinearIssueRelation[] | null } | null;
  /** INF-83: whether the ticket is soft-deleted (trashed). Trashed tickets
   *  are still fetchable but reject commentCreate. */
  trashed?: boolean | null;
  /** INF-83: when the ticket was archived. Archived tickets have the same
   *  constraint as trashed — they are fetchable but not dispatchable. */
  archivedAt?: string | null;
}

/** How the dispatch route to this agent was decided. */
export type RoutingReason =
  | "delegate"
  | "assignee"
  | "mention"
  | "body-mention"
  | "department-prefix"
  | "steward-escalation";

/**
 * Routing reasons that carry a delegate/assignee ownership claim on the ticket,
 * and can therefore have that claim re-verified against Linear at delivery.
 */
const OWNERSHIP_REASONS = new Set<RoutingReason>(["delegate", "assignee"]);

/**
 * Routing reasons that fan a ticket to an agent by roster/department policy
 * rather than by an explicit human act. A ticket with no delegate that is
 * assigned to a HUMAN is human-blocked work, not unrouted work: nobody asked
 * for an agent, so these routes must not wake one. Deliberately EXCLUDES
 * mention / body-mention — a genuine @mention on a human-assigned ticket is a
 * legitimate wake (someone explicitly pinged the agent) and must still land.
 */
const ROSTER_FANOUT_REASONS = new Set<RoutingReason>(["department-prefix", "steward-escalation"]);

/**
 * Is this Linear user a human rather than one of our agents?
 *
 * Ordered so that a positive agent signal always wins, and an inconclusive
 * result is treated as NOT human. That keeps the human-blocked prune fail-safe:
 * when we cannot prove the assignee is a person, we keep dispatching (the
 * pre-AI-2295 behavior) rather than silently swallowing a legitimate wake.
 */
export function isHumanLinearUser(
  user: LinearUserReference | null | undefined,
  agentLinearUserIds: ReadonlySet<string>,
): boolean {
  if (!user) return false;
  if (user.app === true) return false;                          // Linear app user ⇒ one of our agents
  if (user.id && agentLinearUserIds.has(user.id)) return false; // on the agent roster ⇒ agent
  if (user.app === false) return true;                          // Linear says: real person
  return false;                                                 // inconclusive ⇒ don't prune
}

function agentLinearUserIdSet(): ReadonlySet<string> {
  return new Set(Object.keys(buildAgentMap()).filter((id) => Boolean(id)));
}

function isSameIssue(a: LinearIssueReference | null | undefined, b: LinearIssueReference): boolean {
  if (!a) return false;
  return Boolean(
    (a.id && b.id && a.id === b.id) ||
    (a.identifier && b.identifier && a.identifier === b.identifier),
  );
}

function blockerOf(issue: LinearIssueWithRelations, relation: LinearIssueRelation): LinearIssueReference | null {
  const type = relation.type?.toLowerCase();
  if (!type) return null;
  if ((type === "blocks" || type === "blocking") && isSameIssue(relation.relatedIssue, issue)) {
    return relation.issue ?? null;
  }
  if ((type === "blocked_by" || type === "blocked-by" || type === "blockedby") && isSameIssue(relation.issue, issue)) {
    return relation.relatedIssue ?? null;
  }
  return null;
}

export function isBlockedByOpenIssue(issue: LinearIssueWithRelations): boolean {
  const nodes = issue.relations?.nodes ?? [];
  return nodes.some((rel) => {
    const blocker = blockerOf(issue, rel);
    return blocker !== null && !isTerminalIssueState(blocker.state);
  });
}

export function issueIdentifierFromSessionKey(ticketId: string): string {
  return normalizeSessionKey(ticketId).replace(/^linear-/, "");
}

export function isTerminalIssueEvent(event: LinearEvent): boolean {
  if (event.type !== "Issue") return false;
  return isTerminalIssueState((event.data as Record<string, unknown> | undefined)?.state);
}

export function issueIdentifierFromEvent(event: LinearEvent): string | null {
  const data = event.data as Record<string, unknown> | undefined;
  const identifier = data?.identifier ?? data?.issueIdentifier;
  return typeof identifier === "string" && identifier.length > 0 ? identifier : null;
}

function tokenForAgent(agentId: string): string | undefined {
  return (
    getAccessToken(agentId) ??
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY
  );
}

function linearAuthorizationHeader(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * Rich result from a Linear routing check.
 * - actionable: whether the ticket should be dispatched to the agent
 * - failOpen: true when actionable=true is due to a transient error (network/auth/API)
 *   rather than a confirmed routing decision. Callers that want strict-mode
 *   semantics (e.g. startup-replay) can treat failOpen=true as "defer, don't dispatch."
 */
export interface RoutingCheckResult {
  actionable: boolean;
  /** True when actionable is set by fail-open (transient error) not by confirmed routing. */
  failOpen: boolean;
  /**
   * AI-2091 §2 (G2, AI-2015 / AI-2034) — true only when Linear returned a
   * DEFINITIVE not-found for the ticket at check time (`data.issue === null`
   * with an OK response and no GraphQL errors), i.e. a phantom / dead
   * identifier. Distinct from a transient fetch failure (`failOpen`): a
   * terminal not-found aborts the dispatch loudly (phantom-dispatch-abort);
   * a transient failure fails open and retries. Undefined only when the issue
   * was never fetched (no token → fail-open).
   */
  terminalNotFound?: boolean;
}

/**
 * Core routing check. Returns a rich result distinguishing confirmed routing from fail-open.
 * Most callers should use isLinearIssueStillRoutedToAgent for the simple boolean interface.
 *
 * AI-2295 — two independent gates, in order:
 *
 *  1. LIVENESS gate — applies to EVERY routing reason. A ticket that is
 *     not-found, terminal, parked, or blocked by an open prerequisite is dead
 *     work: nobody should be woken for it, however the route was decided. This
 *     gate used to be unreachable for mention / body-mention / department-prefix
 *     / steward-escalation, which short-circuited to `actionable: true` BEFORE
 *     the issue was ever fetched.
 *
 *  2. OWNERSHIP gate — applies only to delegate / assignee routes, the reasons
 *     that carry a claim we can re-verify. Mentions have no delegate to check.
 *
 *  Plus a HUMAN-BLOCKED prune for roster-fanout routes (department-prefix /
 *  steward-escalation) only: `delegate == null && assignee is a human` means the
 *  ticket is parked on a person, not waiting on the department.
 *
 * Fail-open semantics are preserved throughout: a transient fetch/auth/API
 * failure still returns `{ actionable: true, failOpen: true }` for every reason,
 * so a Linear outage cannot turn the new liveness gate into dropped wakes.
 */
export async function checkLinearIssueRouting(
  ticketId: string,
  agentId: string,
  routingReason: RoutingReason | undefined,
): Promise<RoutingCheckResult> {
  const token = tokenForAgent(agentId);
  if (!token) return { actionable: true, failOpen: true };

  const agent = getAgent(agentId);
  const identifier = issueIdentifierFromSessionKey(ticketId);
  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: linearAuthorizationHeader(token),
      },
      body: JSON.stringify({
        query: `query IssueRouting($id: String!) {
          issue(id: $id) {
            id identifier
            delegate { id name app }
            assignee { id name app }
            state { name type }
            trashed
            archivedAt
            relations(first: 50) {
              nodes { type issue { id identifier state { name type } } relatedIssue { id identifier state { name type } } }
            }
          }
        }`,
        variables: { id: identifier },
      }),
    });

    if (!response.ok) {
      log.warn(`Linear routing check failed for ${identifier}: HTTP ${response.status}`);
      return { actionable: true, failOpen: true };
    }

    const body = await response.json() as {
      data?: { issue?: LinearIssueWithRelations | null };
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      log.warn(`Linear routing check errored for ${identifier}: ${body.errors.map((e) => e.message).join("; ")}`);
      return { actionable: true, failOpen: true };
    }

    const issue = body.data?.issue;

    // ── Gate 1: LIVENESS (all routing reasons, AI-2295) ──────────────────
    // AI-2091 §2 (G2): an OK response with no errors and a null issue is a
    // DEFINITIVE not-found — the ticket does not exist (dead identifier /
    // deleted). Surface it as terminalNotFound so the dispatch path can abort
    // as a phantom rather than silently no-route it.
    if (!issue) return { actionable: false, failOpen: false, terminalNotFound: true };
    if (isTerminalIssueState(issue.state) || isParkedIssueState(issue.state)) {
      log.info(`Dropping ${routingReason ?? "unrouted"} event for ${identifier}: state is ${issue.state?.name ?? issue.state?.type ?? "non-actionable"}`);
      return { actionable: false, failOpen: false };
    }
    if (isBlockedByOpenIssue(issue)) {
      log.info(`Dropping pending Linear ticket ${identifier}: blocked by unfinished prerequisite`);
      return { actionable: false, failOpen: false };
    }
    // INF-83: archived/trashed tickets are fetchable but not dispatchable —
    // commentCreate fails on them with "Entity not found: Issue", and any
    // agent woken on them will bounce commentless. Reject at the liveness
    // gate before a dispatch is armed.
    if (issue.trashed || issue.archivedAt) {
      log.info(`Dropping ${routingReason ?? "unrouted"} event for ${identifier}: ticket is ${issue.trashed ? "trashed" : "archived"}`);
      return { actionable: false, failOpen: false };
    }

    // ── Gate 2a: HUMAN-BLOCKED prune (roster-fanout reasons only, AI-2295) ─
    // A department-prefix / steward-escalation route onto a ticket with NO
    // delegate that is assigned to a HUMAN is not actionable by any agent: the
    // ticket is blocked on a person (AI-2230 — parked on Matt for a browser
    // OAuth click), not unrouted departmental work. Without this, every
    // human-blocked ticket in To Do is a standing false-wake source for every
    // agent in the department. Mentions deliberately do NOT take this path.
    if (routingReason && ROSTER_FANOUT_REASONS.has(routingReason)) {
      if (!issue.delegate && isHumanLinearUser(issue.assignee, agentLinearUserIdSet())) {
        log.info(
          `Dropping ${routingReason} event for ${identifier}: no delegate and assigned to human ${issue.assignee?.name ?? "unknown"} — human-blocked, not unrouted work`,
        );
        return { actionable: false, failOpen: false };
      }
      // ── INF-226 Defect A: STALE-DELEGATE prune (roster-fanout only) ──────
      // A department-prefix / steward-escalation fanout targets the STATIC
      // department default, blind to who currently holds the ticket. After an
      // ad-hoc `handoff-work` moves the delegate to a different agent, every
      // subsequent non-routing event (comment, label edit) re-fans-out to the
      // old default and — absent this guard — re-wakes it in a loop (INF-221:
      // Felix woken 5x after INF-221 was handed to Sage). Mirror Gate 2b's
      // ownership re-verification: when a live delegate exists and is verifiably
      // NOT the agent being woken, this fanout is stale. The null-delegate case
      // falls through untouched, so genuinely unrouted departmental work still
      // wakes the default.
      if (issue.delegate && agent?.linearUserId && issue.delegate.id !== agent.linearUserId) {
        log.info(
          `Dropping ${routingReason} event for ${identifier}: delegated to ${issue.delegate.name ?? "another agent"}, not ${agentId} — stale department fanout`,
        );
        return { actionable: false, failOpen: false };
      }
      return { actionable: true, failOpen: false };
    }

    // ── Gate 2b: OWNERSHIP (delegate / assignee reasons only) ─────────────
    // Mentions and body-mentions reach here and fall through to actionable:
    // they passed liveness, and there is no ownership claim to re-verify.
    if (routingReason && !OWNERSHIP_REASONS.has(routingReason)) {
      return { actionable: true, failOpen: false };
    }

    if (routingReason === "delegate") {
      if (!issue.delegate) {
        log.info(`Dropping stale delegate event for ${identifier}: ticket has no delegate (handed back)`);
        return { actionable: false, failOpen: false };
      }
      if (agent?.linearUserId) {
        const ok = issue.delegate.id === agent.linearUserId;
        if (!ok) log.info(`Dropping stale delegate event for ${identifier}: ${agentId} is no longer delegate`);
        return { actionable: ok, failOpen: false };
      }
      // linearUserId not configured — can't verify; allow through but not fail-open (persistent config gap)
      log.warn(`Agent ${agentId} missing linearUserId — cannot verify delegate ownership for ${identifier}; allowing through`);
      return { actionable: true, failOpen: false };
    }

    if (routingReason === "assignee") {
      if (!issue.assignee) {
        log.info(`Dropping stale assignee event for ${identifier}: ticket has no assignee`);
        return { actionable: false, failOpen: false };
      }
      if (agent?.linearUserId) {
        const ok = issue.assignee.id === agent.linearUserId;
        if (!ok) log.info(`Dropping stale assignee event for ${identifier}: ${agentId} is no longer assignee`);
        return { actionable: ok, failOpen: false };
      }
      log.warn(`Agent ${agentId} missing linearUserId — cannot verify assignee ownership for ${identifier}; allowing through`);
      return { actionable: true, failOpen: false };
    }

    return { actionable: true, failOpen: false };
  } catch (err) {
    log.warn(`Linear routing check failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return { actionable: true, failOpen: true };
  }
}

/**
 * Return false only when Linear confirms the issue is terminal or missing.
 * On auth/network/API uncertainty, keep the ticket actionable so we do not
 * silently drop legitimate work because Linear had a transient failure.
 */
export async function isLinearIssueStillRoutedToAgent(
  ticketId: string,
  agentId: string,
  routingReason: RoutingReason | undefined,
): Promise<boolean> {
  return (await checkLinearIssueRouting(ticketId, agentId, routingReason)).actionable;
}

export async function isLinearIssueActionable(ticketId: string, agentId: string): Promise<boolean> {
  const token = tokenForAgent(agentId);
  if (!token) return true;

  const identifier = issueIdentifierFromSessionKey(ticketId);
  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: linearAuthorizationHeader(token),
      },
      body: JSON.stringify({
        query: `query IssueState($id: String!) {
          issue(id: $id) {
            id identifier
            state { name type }
            trashed
            archivedAt
            relations(first: 50) {
              nodes { type issue { id identifier state { name type } } relatedIssue { id identifier state { name type } } }
            }
          }
        }`,
        variables: { id: identifier },
      }),
    });

    if (!response.ok) {
      log.warn(`Linear actionable check failed for ${identifier}: HTTP ${response.status}`);
      return true;
    }

    const body = await response.json() as {
      data?: { issue?: LinearIssueWithRelations | null };
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      log.warn(`Linear actionable check errored for ${identifier}: ${body.errors.map((e) => e.message).join("; ")}`);
      return true;
    }

    const issue = body.data?.issue;
    if (!issue) {
      log.info(`Dropping pending Linear ticket ${identifier}: issue no longer exists`);
      return false;
    }

    // INF-83: archived/trashed tickets are not dispatchable — they fail
    // commentCreate with "Entity not found: Issue". Treat as non-actionable.
    if (issue.trashed || issue.archivedAt) {
      log.info(`Dropping pending Linear ticket ${identifier}: ticket is ${issue.trashed ? "trashed" : "archived"}`);
      return false;
    }

    const nonActionable = isTerminalIssueState(issue.state) || isParkedIssueState(issue.state) || isBlockedByOpenIssue(issue);
    if (nonActionable) {
      log.info(`Dropping pending Linear ticket ${identifier}: state is ${issue.state?.name ?? issue.state?.type ?? "non-actionable"}`);
    }
    return !nonActionable;
  } catch (err) {
    log.warn(`Linear actionable check failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
