
import { extractWebhookMutations } from "./mutation-extraction.js";
import type { LinearIssueUpdatedEvent, LinearEvent } from "./schema.js";

function makeIssueUpdate(
  overrides: Partial<LinearIssueUpdatedEvent> = {},
): LinearIssueUpdatedEvent {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "user-actor-1", name: "Test Actor" },
    createdAt: "2026-07-05T20:00:00.000Z",
    data: {
      id: "issue-uuid-1",
      identifier: "AI-1838",
      title: "Test Issue",
      state: { id: "state-2", name: "Done", type: "completed" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: "team-1",
      teamKey: "AI",
      labelIds: ["label-a"],
      url: "https://linear.app/...",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-05T20:00:00.000Z",
    },
    updatedFrom: {},
    raw: {},
    ...overrides,
  };
}

describe("extractWebhookMutations", () => {
  test("returns empty for non-Issue-update events", () => {
    const event = {
      type: "Comment",
      action: "create",
      actor: { id: "u1", name: "X" },
      createdAt: "2026-07-05T20:00:00.000Z",
      data: {},
      raw: {},
    } as unknown as LinearEvent;
    expect(extractWebhookMutations(event)).toEqual([]);
  });

  test("extracts state change", () => {
    const event = makeIssueUpdate({
      updatedFrom: { stateId: "state-1" },
    });
    const result = extractWebhookMutations(event, "delivery-123");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "webhook",
      ticket: "AI-1838",
      changeType: "state",
      field: "state:Done",
      oldValue: "state-1",
      newValue: "state-2",
      actorId: "user-actor-1",
      webhookEventId: "delivery-123",
    });
  });

  test("extracts delegate change", () => {
    const event = makeIssueUpdate({
      data: {
        ...makeIssueUpdate().data,
        delegate: { id: "user-new-delegate" },
      },
      updatedFrom: { delegateId: "user-old-delegate" },
    });
    const result = extractWebhookMutations(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      changeType: "delegate",
      field: "delegateId",
      oldValue: "user-old-delegate",
      newValue: "user-new-delegate",
    });
  });

  test("extracts assignee change", () => {
    const event = makeIssueUpdate({
      data: {
        ...makeIssueUpdate().data,
        assigneeId: "user-new-assignee",
      },
      updatedFrom: { assigneeId: "user-old-assignee" },
    });
    const result = extractWebhookMutations(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      changeType: "assignee",
      field: "assigneeId",
      oldValue: "user-old-assignee",
      newValue: "user-new-assignee",
    });
  });

  test("extracts label adds and removes", () => {
    const event = makeIssueUpdate({
      data: {
        ...makeIssueUpdate().data,
        labelIds: ["label-a", "label-b", "label-c"],
      },
      updatedFrom: { labelIds: ["label-a", "label-x"] },
    });
    const result = extractWebhookMutations(event);
    // Added: label-b, label-c. Removed: label-x.
    expect(result).toHaveLength(3);
    const fields = result.map((r) => r.field).sort();
    expect(fields).toEqual(["label:label-b", "label:label-c", "label:label-x"].sort());

    const added = result.filter((r) => r.newValue === "added");
    const removed = result.filter((r) => r.oldValue === "removed");
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(1);
    expect(removed[0].field).toBe("label:label-x");
  });

  test("extracts multiple change types in one event", () => {
    const event = makeIssueUpdate({
      data: {
        ...makeIssueUpdate().data,
        delegate: { id: "user-delegate-new" },
        labelIds: ["label-a", "label-b"],
      },
      updatedFrom: {
        stateId: "state-1",
        delegateId: "user-delegate-old",
        labelIds: ["label-a"],
      },
    });
    const result = extractWebhookMutations(event);
    expect(result).toHaveLength(3);
    const types = result.map((r) => r.changeType).sort();
    expect(types).toEqual(["delegate", "label", "state"]);
  });

  test("returns empty when updatedFrom has no tracked fields", () => {
    const event = makeIssueUpdate({
      updatedFrom: { title: "old title", description: "old desc" },
    });
    expect(extractWebhookMutations(event)).toEqual([]);
  });

  test("all extracted records have source=webhook and ticket set", () => {
    const event = makeIssueUpdate({
      updatedFrom: { stateId: "s1", delegateId: "d1" },
    });
    const result = extractWebhookMutations(event);
    for (const rec of result) {
      expect(rec.source).toBe("webhook");
      expect(rec.ticket).toBe("AI-1838");
      expect(rec.recordedAt).toBe("2026-07-05T20:00:00.000Z");
    }
  });
});
