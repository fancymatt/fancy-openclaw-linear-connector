import { getAccessToken, getAgent } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { normalizeSessionKey } from "./session-key.js";
import type { LinearEvent } from "./webhook/schema.js";

const log = componentLogger(createLogger(), "linear-actionable");

const TERMINAL_STATE_TYPES = new Set(["completed", "canceled", "cancelled"]);
const TERMINAL_STATE_NAMES = new Set(["done", "canceled", "cancelled"]);
const PARKED_STATE_TYPES = new Set<string>();
const PARKED_STATE_NAMES = new Set<string>();

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

export interface LinearIssueWithRelations extends LinearIssueReference {
  delegate?: { id?: string; name?: string } | null;
  assignee?: { id?: string; name?: string } | null;
  relations?: { nodes?: LinearIssueRelation[] | null } | null;
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
   * a transient failure fails open and retries. Undefined on the mention /
   * functionary early-return paths, which do not fetch the issue.
   */
  terminalNotFound?: boolean;
}

/**
 * Core routing check. Returns a rich result distinguishing confirmed routing from fail-open.
 * Most callers should use isLinearIssueStillRoutedToAgent for the simple boolean interface.
 */
export async function checkLinearIssueRouting(
  ticketId: string,
  agentId: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" | "department-prefix" | "steward-escalation" | undefined,
): Promise<RoutingCheckResult> {
  // Mentions and functionary routes (AI-1479 department-prefix / steward
  // escalation) have no delegate/assignee ownership on the ticket to re-verify —
  // the route was decided by mention or roster prefix, not by a delegation the
  // stale-route guard could confirm. Treat them as actionable.
  if (
    routingReason === "mention" ||
    routingReason === "body-mention" ||
    routingReason === "department-prefix" ||
    routingReason === "steward-escalation"
  ) {
    return { actionable: true, failOpen: false };
  }

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
            delegate { id name }
            assignee { id name }
            state { name type }
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
    // AI-2091 §2 (G2): an OK response with no errors and a null issue is a
    // DEFINITIVE not-found — the ticket does not exist (dead identifier /
    // deleted). Surface it as terminalNotFound so the dispatch path can abort
    // as a phantom rather than silently no-route it.
    if (!issue) return { actionable: false, failOpen: false, terminalNotFound: true };
    if (isTerminalIssueState(issue.state) || isParkedIssueState(issue.state)) {
      return { actionable: false, failOpen: false };
    }
    if (isBlockedByOpenIssue(issue)) {
      log.info(`Dropping pending Linear ticket ${identifier}: blocked by unfinished prerequisite`);
      return { actionable: false, failOpen: false };
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
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" | "department-prefix" | "steward-escalation" | undefined,
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
