import { normalizeLinearEvent } from "./normalize.js";
import {
  LinearIssueCreatedEvent,
  LinearIssueUpdatedEvent,
  LinearCommentCreatedEvent,
  LinearCommentUpdatedEvent,
  LinearUnknownEvent,
} from "./schema.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const issuePayload = {
  type: "Issue",
  action: "create",
  createdAt: "2026-04-10T10:00:00.000Z",
  actor: { id: "actor-1", name: "Alice", email: "alice@example.com" },
  data: {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Fix the widget",
    description: "It's broken.",
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    priority: 2,
    priorityLabel: "High",
    team: { id: "team-1", key: "ENG" },
    assignee: { id: "user-1", name: "Bob" },
    labelIds: ["label-a", "label-b"],
    url: "https://linear.app/org/issue/ENG-42",
    createdAt: "2026-04-10T09:55:00.000Z",
    updatedAt: "2026-04-10T10:00:00.000Z",
  },
};

const issueUpdatePayload = {
  ...issuePayload,
  action: "update",
  updatedFrom: { priority: 3 },
};

const commentPayload = {
  type: "Comment",
  action: "create",
  createdAt: "2026-04-10T10:05:00.000Z",
  actor: { id: "actor-2", name: "Carol" },
  data: {
    id: "comment-1",
    body: "LGTM!",
    issue: { id: "issue-1", identifier: "ENG-42" },
    url: "https://linear.app/org/issue/ENG-42#comment-1",
    createdAt: "2026-04-10T10:05:00.000Z",
    updatedAt: "2026-04-10T10:05:00.000Z",
  },
};

const unknownPayload = {
  type: "Project",
  action: "create",
  createdAt: "2026-04-10T10:10:00.000Z",
  actor: { id: "actor-1", name: "Alice" },
  data: { id: "proj-1", name: "Q2 Roadmap" },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("normalizeLinearEvent — Issue create", () => {
  it("returns type=Issue action=create", () => {
    const event = normalizeLinearEvent(issuePayload) as LinearIssueCreatedEvent;
    expect(event.type).toBe("Issue");
    expect(event.action).toBe("create");
  });

  it("normalizes actor fields", () => {
    const event = normalizeLinearEvent(issuePayload) as LinearIssueCreatedEvent;
    expect(event.actor).toEqual({
      id: "actor-1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("normalizes issue data fields", () => {
    const event = normalizeLinearEvent(issuePayload) as LinearIssueCreatedEvent;
    const { data } = event;
    expect(data.identifier).toBe("ENG-42");
    expect(data.title).toBe("Fix the widget");
    expect(data.priority).toBe(2);
    expect(data.priorityLabel).toBe("High");
    expect(data.teamKey).toBe("ENG");
    expect(data.assigneeName).toBe("Bob");
    expect(data.labelIds).toEqual(["label-a", "label-b"]);
    expect(data.state.type).toBe("unstarted");
  });

  it("preserves the raw payload", () => {
    const event = normalizeLinearEvent(issuePayload) as LinearIssueCreatedEvent;
    expect(event.raw).toBe(issuePayload);
  });
});

describe("normalizeLinearEvent — Issue update", () => {
  it("returns type=Issue action=update with updatedFrom", () => {
    const event = normalizeLinearEvent(
      issueUpdatePayload
    ) as LinearIssueUpdatedEvent;
    expect(event.type).toBe("Issue");
    expect(event.action).toBe("update");
    expect(event.updatedFrom).toEqual({ priority: 3 });
  });
});

describe("normalizeLinearEvent — Comment create", () => {
  it("returns type=Comment action=create", () => {
    const event = normalizeLinearEvent(
      commentPayload
    ) as LinearCommentCreatedEvent;
    expect(event.type).toBe("Comment");
    expect(event.action).toBe("create");
  });

  it("normalizes comment data fields", () => {
    const event = normalizeLinearEvent(
      commentPayload
    ) as LinearCommentCreatedEvent;
    const { data } = event;
    expect(data.id).toBe("comment-1");
    expect(data.body).toBe("LGTM!");
    expect(data.issueIdentifier).toBe("ENG-42");
  });
});

describe("normalizeLinearEvent — Comment update", () => {
  it("returns type=Comment action=update", () => {
    const payload = { ...commentPayload, action: "update" };
    const event = normalizeLinearEvent(payload) as LinearCommentUpdatedEvent;
    expect(event.type).toBe("Comment");
    expect(event.action).toBe("update");
  });

  it("normalizes comment data fields on update", () => {
    const payload = { ...commentPayload, action: "update" };
    const event = normalizeLinearEvent(payload) as LinearCommentUpdatedEvent;
    expect(event.data.id).toBe("comment-1");
    expect(event.data.body).toBe("LGTM!");
    expect(event.data.issueIdentifier).toBe("ENG-42");
  });

  it("preserves raw payload on update", () => {
    const payload = { ...commentPayload, action: "update" };
    const event = normalizeLinearEvent(payload) as LinearCommentUpdatedEvent;
    expect(event.raw).toBe(payload);
  });
});

describe("normalizeLinearEvent — unknown event type", () => {
  it("returns a LinearUnknownEvent without throwing", () => {
    const event = normalizeLinearEvent(unknownPayload) as LinearUnknownEvent;
    expect(event.type).toBe("Project");
    expect(event.action).toBe("create");
    expect(event.raw).toBe(unknownPayload);
  });
});

describe("normalizeLinearEvent — error handling", () => {
  it("throws on null payload", () => {
    expect(() => normalizeLinearEvent(null)).toThrow();
  });

  it("throws on non-object payload", () => {
    expect(() => normalizeLinearEvent("string")).toThrow();
  });

  it("throws when type field is missing", () => {
    expect(() => normalizeLinearEvent({ action: "create" })).toThrow(
      /type/
    );
  });

  it("throws when action field is missing", () => {
    expect(() => normalizeLinearEvent({ type: "Issue" })).toThrow(
      /action/
    );
  });
});
