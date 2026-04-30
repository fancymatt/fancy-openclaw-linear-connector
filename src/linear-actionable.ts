import { getAccessToken } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { normalizeSessionKey } from "./session-key.js";
import type { LinearEvent } from "./webhook/schema.js";

const log = componentLogger(createLogger(), "linear-actionable");

const TERMINAL_STATE_TYPES = new Set(["completed", "canceled", "cancelled"]);
const TERMINAL_STATE_NAMES = new Set(["done", "canceled", "cancelled"]);

export function isTerminalIssueState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  return TERMINAL_STATE_TYPES.has(type) || TERMINAL_STATE_NAMES.has(name);
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

/**
 * Return false only when Linear confirms the issue is terminal or missing.
 * On auth/network/API uncertainty, keep the ticket actionable so we do not
 * silently drop legitimate work because Linear had a transient failure.
 */
export async function isLinearIssueActionable(ticketId: string, agentId: string): Promise<boolean> {
  const token = tokenForAgent(agentId);
  if (!token) return true;

  const identifier = issueIdentifierFromSessionKey(ticketId);
  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: token,
      },
      body: JSON.stringify({
        query: `query IssueState($id: String!) { issue(id: $id) { id identifier state { name type } } }`,
        variables: { id: identifier },
      }),
    });

    if (!response.ok) {
      log.warn(`Linear actionable check failed for ${identifier}: HTTP ${response.status}`);
      return true;
    }

    const body = await response.json() as {
      data?: { issue?: { state?: { name?: string; type?: string } } | null };
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

    const terminal = isTerminalIssueState(issue.state);
    if (terminal) {
      log.info(`Dropping pending Linear ticket ${identifier}: state is ${issue.state?.name ?? issue.state?.type ?? "terminal"}`);
    }
    return !terminal;
  } catch (err) {
    log.warn(`Linear actionable check failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
