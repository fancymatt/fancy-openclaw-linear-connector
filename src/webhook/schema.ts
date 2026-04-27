/**
 * Normalized internal event shape for Linear webhook payloads.
 *
 * All inbound Linear webhook events are parsed into a `LinearEvent` before
 * being routed downstream. This decouples routing/queue logic from the raw
 * Linear API surface and gives us a stable internal contract.
 */

// ─── Actor ────────────────────────────────────────────────────────────────────

export interface LinearActor {
  id: string;
  name: string;
  email?: string;
}

// ─── Issue ────────────────────────────────────────────────────────────────────

export interface LinearIssueData {
  id: string;
  identifier: string; // e.g. "ENG-42"
  title: string;
  description?: string;
  state: {
    id: string;
    name: string;
    type: string; // "triage" | "backlog" | "unstarted" | "started" | "completed" | "cancelled"
  };
  priority: number; // 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
  priorityLabel: string;
  teamId: string;
  teamKey: string;
  assigneeId?: string;
  assigneeName?: string;
  /** Delegate user (OAuth app actors appear here, not in assignee) */
  delegate?: { id?: string; name?: string } | null;
  /** Assignee object with id (for OAuth routing) */
  assignee?: { id?: string; name?: string } | null;
  /** Users mentioned in the issue/comment */
  mentionedUsers?: Array<{ id?: string; name?: string }>;
  labelIds: string[];
  url: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── Comment ──────────────────────────────────────────────────────────────────

export interface LinearCommentData {
  id: string;
  body: string;
  issueId: string;
  issueIdentifier: string; // e.g. "ENG-42"
  issueTitle: string;
  /** Users mentioned in the comment */
  mentionedUsers?: Array<{ id?: string; name?: string }>;
  url: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Event types ──────────────────────────────────────────────────────────────

export type LinearEventAction = "create" | "update" | "remove";

export interface LinearIssueCreatedEvent {
  type: "Issue";
  action: "create";
  actor: LinearActor;
  createdAt: string;
  data: LinearIssueData;
  /** Raw payload preserved for debugging */
  raw: unknown;
}

export interface LinearIssueUpdatedEvent {
  type: "Issue";
  action: "update";
  actor: LinearActor;
  createdAt: string;
  data: LinearIssueData;
  /** Fields that changed in this update, as reported by Linear */
  updatedFrom?: Record<string, unknown>;
  raw: unknown;
}

export interface LinearCommentCreatedEvent {
  type: "Comment";
  action: "create";
  actor: LinearActor;
  createdAt: string;
  data: LinearCommentData;
  raw: unknown;
}

export interface LinearCommentUpdatedEvent {
  type: "Comment";
  action: "update";
  actor: LinearActor;
  createdAt: string;
  data: LinearCommentData;
  raw: unknown;
}

export interface LinearUnknownEvent {
  type: string;
  action: string;
  actor: LinearActor;
  createdAt: string;
  /** Event data — may contain issue/comment/agent session payload */
  data?: Record<string, unknown>;
  /** Raw payload — we keep it so unsupported events aren't silently dropped */
  raw: unknown;
}

export type LinearEvent =
  | LinearIssueCreatedEvent
  | LinearIssueUpdatedEvent
  | LinearCommentCreatedEvent
  | LinearCommentUpdatedEvent
  | LinearUnknownEvent;
