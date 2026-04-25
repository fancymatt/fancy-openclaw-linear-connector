import {
  LinearEvent,
  LinearActor,
  LinearIssueData,
  LinearCommentData,
} from "./schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractActor(payload: Record<string, unknown>): LinearActor {
  const actor = (payload.actor ?? {}) as Record<string, unknown>;
  return {
    id: String(actor.id ?? "unknown"),
    name: String(actor.name ?? "unknown"),
    email: actor.email ? String(actor.email) : undefined,
  };
}

function extractIssueData(data: Record<string, unknown>): LinearIssueData {
  const state = (data.state ?? {}) as Record<string, unknown>;
  const team = (data.team ?? {}) as Record<string, unknown>;
  const assignee = data.assignee
    ? (data.assignee as Record<string, unknown>)
    : null;

  return {
    id: String(data.id ?? ""),
    identifier: String(data.identifier ?? ""),
    title: String(data.title ?? ""),
    description: data.description ? String(data.description) : undefined,
    state: {
      id: String(state.id ?? ""),
      name: String(state.name ?? ""),
      type: String(state.type ?? ""),
    },
    priority: typeof data.priority === "number" ? data.priority : 0,
    priorityLabel: String(data.priorityLabel ?? "No priority"),
    teamId: String(team.id ?? data.teamId ?? ""),
    teamKey: String(team.key ?? data.teamKey ?? ""),
    assigneeId: assignee ? String(assignee.id) : undefined,
    assigneeName: assignee ? String(assignee.name) : undefined,
    delegate: data.delegate as { id?: string; name?: string } | null | undefined,
    assignee: data.assignee as { id?: string; name?: string } | null | undefined,
    mentionedUsers: data.mentionedUsers as Array<{ id?: string; name?: string }> | undefined,
    labelIds: Array.isArray(data.labelIds)
      ? (data.labelIds as unknown[]).map(String)
      : [],
    url: String(data.url ?? ""),
    createdAt: String(data.createdAt ?? ""),
    updatedAt: String(data.updatedAt ?? ""),
  };
}

function extractCommentData(
  data: Record<string, unknown>
): LinearCommentData {
  const issue = (data.issue ?? {}) as Record<string, unknown>;

  return {
    id: String(data.id ?? ""),
    body: String(data.body ?? ""),
    issueId: String(issue.id ?? data.issueId ?? ""),
    issueIdentifier: String(issue.identifier ?? data.issueIdentifier ?? ""),
    issueTitle: String(issue.title ?? ""),
    mentionedUsers: data.mentionedUsers as Array<{ id?: string; name?: string }> | undefined,
    url: String(data.url ?? ""),
    createdAt: String(data.createdAt ?? ""),
    updatedAt: String(data.updatedAt ?? ""),
  };
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

/**
 * Parses a raw Linear webhook payload into a normalized `LinearEvent`.
 *
 * Unknown event types are preserved as `LinearUnknownEvent` so they can be
 * logged or forwarded without being silently dropped.
 *
 * @throws {Error} if the payload is missing required top-level fields.
 */
export function normalizeLinearEvent(payload: unknown): LinearEvent {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload must be a non-null object");
  }

  const p = payload as Record<string, unknown>;

  if (typeof p.type !== "string") {
    throw new Error("Payload missing required field: type");
  }
  if (typeof p.action !== "string") {
    throw new Error("Payload missing required field: action");
  }

  const type = p.type;
  const action = p.action;
  const actor = extractActor(p);
  const createdAt = String(p.createdAt ?? new Date().toISOString());
  const data = (p.data ?? {}) as Record<string, unknown>;

  if (type === "Issue" && action === "create") {
    return {
      type: "Issue",
      action: "create",
      actor,
      createdAt,
      data: extractIssueData(data),
      raw: payload,
    };
  }

  if (type === "Issue" && action === "update") {
    return {
      type: "Issue",
      action: "update",
      actor,
      createdAt,
      data: extractIssueData(data),
      updatedFrom: p.updatedFrom
        ? (p.updatedFrom as Record<string, unknown>)
        : undefined,
      raw: payload,
    };
  }

  if (type === "Comment" && action === "create") {
    return {
      type: "Comment",
      action: "create",
      actor,
      createdAt,
      data: extractCommentData(data),
      raw: payload,
    };
  }

  // Fallthrough: unsupported but preserved
  return {
    type,
    action,
    actor,
    createdAt,
    data: p.data as Record<string, unknown> | undefined,
    raw: payload,
  };
}
