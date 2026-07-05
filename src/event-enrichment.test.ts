/**
 * AI-1799 AC2 — Operational event enrichment: workflow_state, plane, wake_id.
 *
 * AC2: All task-scoped operational events written after this change carry
 *   - `workflow_state` (when the ticket is enrolled)
 *   - `plane` tag: `agent` (narrative) vs `connector` (mechanics)
 *   - dispatch-cycle events from route through session end share a `wake_id`
 *     minted at route time
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationalEventStore } from "./store/operational-event-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-enrichment-test-"));
  return path.join(dir, "events.db");
}

describe("AI-1799 AC2: operational events carry workflow_state and plane", () => {
  let dbPath: string;
  let store: OperationalEventStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new OperationalEventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("append() accepts and persists a workflow_state field on an enrolled ticket's event", () => {
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "tdd",
      key: "linear-AI-4001",
      workflowState: "write-tests",
      plane: "connector",
    });

    const [event] = store.query({ agent: "tdd" });
    expect(event.workflowState).toBe("write-tests");
    expect(event.plane).toBe("connector");
  });

  it("append() accepts plane='agent' for narrative events", () => {
    store.append({
      outcome: "delivered",
      type: "Comment",
      agent: "ai",
      key: "linear-AI-4002",
      workflowState: "implementation",
      plane: "agent",
    });

    const [event] = store.query({ agent: "ai" });
    expect(event.plane).toBe("agent");
  });

  it("workflow_state is null (not omitted) when the ticket is not enrolled", () => {
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "ai",
      key: "linear-ADHOC-1",
      plane: "connector",
    });

    const [event] = store.query({ agent: "ai" });
    expect(event.workflowState).toBeNull();
  });

  it("plane must be 'agent' or 'connector' — the audience axis", () => {
    // plane is optional (null for legacy events) but when present must be valid
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "ai",
      key: "linear-AI-4003",
      plane: "connector",
    });

    const [event] = store.query({ agent: "ai", key: "linear-AI-4003" });
    expect(["agent", "connector"]).toContain(event.plane);
  });

  it("persisted events survive store reopen (durable schema migration)", () => {
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "tdd",
      key: "linear-AI-4004",
      workflowState: "write-tests",
      plane: "connector",
    });
    store.close();

    const reopened = new OperationalEventStore(dbPath);
    const [event] = reopened.query({ agent: "tdd" });
    expect(event.workflowState).toBe("write-tests");
    expect(event.plane).toBe("connector");
    reopened.close();
  });
});

describe("AI-1799 AC2: wake_id correlation across the dispatch cycle", () => {
  let dbPath: string;
  let store: OperationalEventStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new OperationalEventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("append() accepts and persists a wake_id field", () => {
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "tdd",
      key: "linear-AI-4005",
      wakeId: "wake-abc-123",
      plane: "connector",
    });

    const [event] = store.query({ agent: "tdd" });
    expect(event.wakeId).toBe("wake-abc-123");
  });

  it("dispatch-cycle events sharing a wake_id can be queried as a group", () => {
    const wakeId = "wake-cycle-456";

    // Simulate the full dispatch cycle: routed → bag-added → dispatch-accepted → session-ended
    const cycleOutcomes = ["routed", "bag-added", "dispatch-accepted", "session-ended"] as const;
    for (const outcome of cycleOutcomes) {
      store.append({
        outcome,
        type: "Issue",
        agent: "tdd",
        key: "linear-AI-4006",
        wakeId,
        plane: "connector",
      });
    }

    // Query all events with this wake_id
    const cycleEvents = store.queryByWakeId(wakeId);
    expect(cycleEvents).toHaveLength(cycleOutcomes.length);
    expect(cycleEvents.map((e) => e.outcome)).toEqual(expect.arrayContaining([...cycleOutcomes]));
    // All share the same wake_id
    expect(cycleEvents.every((e) => e.wakeId === wakeId)).toBe(true);
  });

  it("a routed event with no dispatch-accepted sibling is mechanically detectable (AI-1773 class)", () => {
    const wakeId = "wake-incomplete-789";

    // Only routed, no dispatch-accepted — the silent-failure class
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "tdd",
      key: "linear-AI-4007",
      wakeId,
      plane: "connector",
    });

    const cycleEvents = store.queryByWakeId(wakeId);
    const hasDispatchAccepted = cycleEvents.some((e) => e.outcome === "dispatch-accepted");
    expect(hasDispatchAccepted).toBe(false);
  });

  it("wake_id is null on legacy/connector-internal events that predate route time", () => {
    store.append({
      outcome: "received",
      type: "Issue",
      plane: "connector",
    });

    const [event] = store.query({ outcome: "received" });
    expect(event.wakeId).toBeNull();
  });

  it("persisted wake_id survives store reopen", () => {
    store.append({
      outcome: "routed",
      type: "Issue",
      agent: "tdd",
      key: "linear-AI-4008",
      wakeId: "wake-durable-012",
      plane: "connector",
    });
    store.close();

    const reopened = new OperationalEventStore(dbPath);
    const [event] = reopened.query({ agent: "tdd" });
    expect(event.wakeId).toBe("wake-durable-012");
    reopened.close();
  });
});
