import { AgentQueue } from "./agent-queue";
import type { RouteResult } from "../types";
import type { LinearIssueCreatedEvent } from "../webhook/schema";
import os from "os";
import path from "path";
import fs from "fs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-queue-test-"));
  return path.join(dir, "test.db");
}

function makeRouteResult(agentId: string, issueId: string): RouteResult {
  const event: LinearIssueCreatedEvent = {
    type: "Issue",
    action: "create",
    actor: { id: "actor-1", name: "Test" },
    createdAt: new Date().toISOString(),
    data: {
      id: issueId,
      identifier: `ENG-${issueId}`,
      title: `Task ${issueId}`,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 2,
      priorityLabel: "High",
      teamId: "team-1",
      teamKey: "ENG",
      assigneeId: "user-1",
      assigneeName: "Agent",
      labelIds: [],
      url: `https://linear.app/org/issue/ENG-${issueId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    raw: {},
  };

  return {
    agentId,
    sessionKey: `agent:${agentId}:main`,
    priority: 2,
    event,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AgentQueue", () => {
  let queue: AgentQueue;

  beforeEach(() => {
    queue = new AgentQueue(tmpDbPath());
  });

  afterEach(() => {
    queue.close();
  });

  it("first task for an agent returns deliver and becomes active", () => {
    const result = makeRouteResult("charles", "1");
    const { action } = queue.enqueue(result);

    expect(action).toBe("deliver");
    expect(queue.getActive("charles")).toEqual(result);
  });

  it("second task for same agent returns queued", () => {
    queue.enqueue(makeRouteResult("charles", "1"));
    const { action } = queue.enqueue(makeRouteResult("charles", "2"));

    expect(action).toBe("queued");
  });

  it("complete() with queued tasks returns next task and promotes it", () => {
    queue.enqueue(makeRouteResult("charles", "1"));
    queue.enqueue(makeRouteResult("charles", "2"));

    const next = queue.complete("charles");

    expect(next).not.toBeNull();
    expect(next!.event).toEqual(makeRouteResult("charles", "2").event);
    expect(queue.getActive("charles")).toEqual(next);
  });

  it("complete() with no queued tasks returns null", () => {
    queue.enqueue(makeRouteResult("charles", "1"));
    const next = queue.complete("charles");

    expect(next).toBeNull();
    expect(queue.getActive("charles")).toBeNull();
  });

  it("multiple agents are independent", () => {
    const r1 = queue.enqueue(makeRouteResult("charles", "1"));
    const r2 = queue.enqueue(makeRouteResult("laren", "2"));

    expect(r1.action).toBe("deliver");
    expect(r2.action).toBe("deliver");
    expect(queue.getActive("charles")).not.toBeNull();
    expect(queue.getActive("laren")).not.toBeNull();
  });

  it("getStats() returns correct state", () => {
    queue.enqueue(makeRouteResult("charles", "1"));
    queue.enqueue(makeRouteResult("charles", "2"));
    queue.enqueue(makeRouteResult("laren", "3"));

    const stats = queue.getStats();
    const charles = stats.find((s) => s.agentId === "charles");
    const laren = stats.find((s) => s.agentId === "laren");

    expect(charles).toEqual({ agentId: "charles", active: true, queueDepth: 1 });
    expect(laren).toEqual({ agentId: "laren", active: true, queueDepth: 0 });
  });

  it("queue ordering is FIFO", () => {
    queue.enqueue(makeRouteResult("charles", "1"));
    queue.enqueue(makeRouteResult("charles", "2"));
    queue.enqueue(makeRouteResult("charles", "3"));

    const queued = queue.getQueued("charles");
    expect(queued).toHaveLength(2);
    expect(queued[0].event).toEqual(makeRouteResult("charles", "2").event);
    expect(queued[1].event).toEqual(makeRouteResult("charles", "3").event);
  });

  it("getActive() and getQueued() return correct data", () => {
    const r1 = makeRouteResult("charles", "1");
    const r2 = makeRouteResult("charles", "2");
    const r3 = makeRouteResult("charles", "3");

    queue.enqueue(r1);
    queue.enqueue(r2);
    queue.enqueue(r3);

    expect(queue.getActive("charles")).toEqual(r1);
    expect(queue.getQueued("charles")).toEqual([r2, r3]);

    // After completing first, second becomes active
    const next = queue.complete("charles");
    expect(next).toEqual(r2);
    expect(queue.getActive("charles")).toEqual(r2);
    expect(queue.getQueued("charles")).toEqual([r3]);
  });
});
