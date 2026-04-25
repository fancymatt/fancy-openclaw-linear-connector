"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLinearEvent = normalizeLinearEvent;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractActor(payload) {
    const actor = (payload.actor ?? {});
    return {
        id: String(actor.id ?? "unknown"),
        name: String(actor.name ?? "unknown"),
        email: actor.email ? String(actor.email) : undefined,
    };
}
function extractIssueData(data) {
    const state = (data.state ?? {});
    const team = (data.team ?? {});
    const assignee = data.assignee
        ? data.assignee
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
        delegate: data.delegate,
        assignee: data.assignee,
        mentionedUsers: data.mentionedUsers,
        labelIds: Array.isArray(data.labelIds)
            ? data.labelIds.map(String)
            : [],
        url: String(data.url ?? ""),
        createdAt: String(data.createdAt ?? ""),
        updatedAt: String(data.updatedAt ?? ""),
    };
}
function extractCommentData(data) {
    const issue = (data.issue ?? {});
    return {
        id: String(data.id ?? ""),
        body: String(data.body ?? ""),
        issueId: String(issue.id ?? data.issueId ?? ""),
        issueIdentifier: String(issue.identifier ?? data.issueIdentifier ?? ""),
        issueTitle: String(issue.title ?? ""),
        mentionedUsers: data.mentionedUsers,
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
function normalizeLinearEvent(payload) {
    if (!payload || typeof payload !== "object") {
        throw new Error("Payload must be a non-null object");
    }
    const p = payload;
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
    const data = (p.data ?? {});
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
                ? p.updatedFrom
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
        data: p.data,
        raw: payload,
    };
}
//# sourceMappingURL=normalize.js.map