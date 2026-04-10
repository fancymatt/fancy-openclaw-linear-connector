# Normalized Event Schema

All inbound Linear webhook payloads are parsed into a `LinearEvent` before being
routed to the queue or delivery layer. This document describes the normalized shape.

## Why normalize?

- Decouples internal logic from the Linear API surface
- Provides a stable contract for routing rules and queue management
- Makes future API version changes a single-point update in `normalize.ts`

---

## Top-level: `LinearEvent`

```ts
type LinearEvent =
  | LinearIssueCreatedEvent
  | LinearIssueUpdatedEvent
  | LinearCommentCreatedEvent
  | LinearUnknownEvent;
```

All event types share a common envelope:

| Field       | Type            | Description                                            |
|-------------|-----------------|--------------------------------------------------------|
| `type`      | `string`        | Linear object type: `"Issue"`, `"Comment"`, etc.      |
| `action`    | `string`        | Event action: `"create"`, `"update"`, `"remove"`      |
| `actor`     | `LinearActor`   | The user who triggered the event                       |
| `createdAt` | `string`        | ISO 8601 timestamp from Linear                         |
| `raw`       | `unknown`       | Original payload, preserved for debugging/logging      |

---

## `LinearActor`

```ts
interface LinearActor {
  id: string;
  name: string;
  email?: string;
}
```

---

## `LinearIssueCreatedEvent`

Emitted when a new issue is created in Linear.

```ts
interface LinearIssueCreatedEvent {
  type: "Issue";
  action: "create";
  actor: LinearActor;
  createdAt: string;
  data: LinearIssueData;
  raw: unknown;
}
```

## `LinearIssueUpdatedEvent`

Emitted when an existing issue is modified.

```ts
interface LinearIssueUpdatedEvent {
  type: "Issue";
  action: "update";
  actor: LinearActor;
  createdAt: string;
  data: LinearIssueData;
  updatedFrom?: Record<string, unknown>; // fields that changed, before values
  raw: unknown;
}
```

`updatedFrom` mirrors the Linear `updatedFrom` object: keys are field names,
values are the *previous* values (not the new ones). Example:

```json
{ "priority": 3, "stateId": "old-state-id" }
```

## `LinearCommentCreatedEvent`

Emitted when a comment is posted on an issue.

```ts
interface LinearCommentCreatedEvent {
  type: "Comment";
  action: "create";
  actor: LinearActor;
  createdAt: string;
  data: LinearCommentData;
  raw: unknown;
}
```

## `LinearUnknownEvent`

Catch-all for event types not explicitly handled (e.g. `Project`, `Cycle`,
`Label`). Routing rules can choose to ignore or forward these.

```ts
interface LinearUnknownEvent {
  type: string;
  action: string;
  actor: LinearActor;
  createdAt: string;
  raw: unknown;
}
```

---

## `LinearIssueData`

```ts
interface LinearIssueData {
  id: string;            // Linear internal UUID
  identifier: string;   // Human-readable ID, e.g. "ENG-42"
  title: string;
  description?: string; // Markdown body, may be absent
  state: {
    id: string;
    name: string;
    type: string;        // "triage" | "backlog" | "unstarted" | "started" | "completed" | "cancelled"
  };
  priority: number;     // 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
  priorityLabel: string;
  teamId: string;
  teamKey: string;      // Short team identifier, e.g. "ENG"
  assigneeId?: string;
  assigneeName?: string;
  labelIds: string[];
  url: string;          // Direct URL to the issue in the Linear app
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
}
```

### Priority mapping

| Value | Label       |
|-------|-------------|
| 0     | No priority |
| 1     | Urgent      |
| 2     | High        |
| 3     | Medium      |
| 4     | Low         |

---

## `LinearCommentData`

```ts
interface LinearCommentData {
  id: string;
  body: string;            // Markdown content of the comment
  issueId: string;         // UUID of the parent issue
  issueIdentifier: string; // e.g. "ENG-42"
  url: string;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
```

---

## Source files

- Types: [`src/webhook/schema.ts`](../src/webhook/schema.ts)
- Normalization logic: [`src/webhook/normalize.ts`](../src/webhook/normalize.ts)
- Tests: [`src/webhook/normalize.test.ts`](../src/webhook/normalize.test.ts)
