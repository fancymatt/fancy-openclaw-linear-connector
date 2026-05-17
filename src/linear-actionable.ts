import { getAccessToken, getAgent } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { normalizeSessionKey } from "./session-key.js";
import type { LinearEvent } from "./webhook/schema.js";

const log = componentLogger(createLogger(), "linear-actionable");

const TERMINAL_STATE_TYPES = new Set(["completed", "canceled", "cancelled"]);
const TERMINAL_STATE_NAMES = new Set(["done", "canceled", "cancelled"]);
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
 * Return false only when Linear confirms the issue is terminal or missing.
 * On auth/network/API uncertainty, keep the ticket actionable so we do not
 * silently drop legitimate work because Linear had a transient failure.
 */

export async function isLinearIssueStillRoutedToAgent(
  ticketId: string,
  agentId: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" | undefined,
): Promise<boolean> {
  if (routingReason === "mention" || routingReason === "body-mention") return true;

  const token = tokenForAgent(agentId);
  const agent = getAgent(agentId);
  if (!token || !agent?.linearUserId) return true;

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
      return true;
    }

    const body = await response.json() as {
      data?: { issue?: LinearIssueWithRelations | null };
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      log.warn(`Linear routing check errored for ${identifier}: ${body.errors.map((e) => e.message).join("; ")}`);
      return true;
    }

    const issue = body.data?.issue;
    if (!issue) return false;
    if (isTerminalIssueState(issue.state) || isParkedIssueState(issue.state)) return false;
    if (isBlockedByOpenIssue(issue)) {
      log.info(`Dropping pending Linear ticket ${identifier}: blocked by unfinished prerequisite`);
      return false;
    }

    if (routingReason === "delegate") {
      const ok = issue.delegate?.id === agent.linearUserId;
      if (!ok) log.info(`Dropping stale delegate event for ${identifier}: ${agentId} is no longer delegate`);
      return ok;
    }

    if (routingReason === "assignee") {
      const ok = issue.assignee?.id === agent.linearUserId;
      if (!ok) log.info(`Dropping stale assignee event for ${identifier}: ${agentId} is no longer assignee`);
      return ok;
    }

    return true;
  } catch (err) {
    log.warn(`Linear routing check failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
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
