
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MutationAuditStore, type MutationAuditInput } from "./store/mutation-audit-store.js";
import { reconcileOobMutations } from "./oob-reconcile-sweep.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oob-reconcile-test-"));
  return path.join(dir, "test.db");
}

// Minimal fake alert bus to avoid env dependencies.
function fakeAlertBus() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    notify: (alert: Record<string, unknown>) => calls.push(alert),
    _calls: calls,
  };
}

// Minimal fake operational event store.
function fakeOpStore() {
  const events: Array<Record<string, unknown>> = [];
  const store = {
    append: (input: Record<string, unknown>) => events.push(input),
  };
  return Object.assign(store, { _events: events }) as unknown as OperationalEventStore &
    { _events: Array<Record<string, unknown>> };
}

const NOW = new Date("2026-07-05T21:00:00.000Z").getTime();

describe("reconcileOobMutations", () => {
  let store: MutationAuditStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    store = new MutationAuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("correlates webhook mutation with matching proxy op", async () => {
    // Proxy forwarded a state change at 20:29
    store.append({
      source: "proxy",
      ticket: "AI-100",
      changeType: "state",
      field: "state:done",
      agent: "hanzo",
      intent: "advance",
      recordedAt: "2026-07-05T20:29:00.000Z",
    });
    // Webhook observed the state change at 20:30
    store.append({
      source: "webhook",
      ticket: "AI-100",
      changeType: "state",
      field: "state:done",
      actorId: "user-bot",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000, // 1 min grace (webhook is 30 min old, well past grace)
    });

    expect(result.examined).toBe(1);
    expect(result.correlated).toBe(1);
    expect(result.flagged).toBe(0);
  });

  test("flags webhook mutation with no matching proxy op", async () => {
    // Only a webhook record — no proxy op at all.
    store.append({
      source: "webhook",
      ticket: "AI-200",
      changeType: "state",
      field: "state:done",
      actorId: "user-raw-token-holder",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const bus = fakeAlertBus();
    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
      alertBus: bus as any,
    });

    expect(result.examined).toBe(1);
    expect(result.correlated).toBe(0);
    expect(result.flagged).toBe(1);
    expect(result.flaggedDetails[0]).toMatchObject({
      ticket: "AI-200",
      changeType: "state",
      field: "state:done",
    });
    expect(bus._calls).toHaveLength(1);
    expect(bus._calls[0].severity).toBe("warning");
    expect(String(bus._calls[0].title)).toContain("Out-of-band");
  });

  test("does not examine webhook mutations within grace window", async () => {
    // Webhook just happened (within grace)
    store.append({
      source: "webhook",
      ticket: "AI-300",
      changeType: "delegate",
      field: "delegateId",
      recordedAt: new Date(NOW - 30_000).toISOString(), // 30s ago
    });

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 5 * 60_000, // 5 min grace
    });

    expect(result.examined).toBe(0);
    expect(result.flagged).toBe(0);
  });

  test("does not examine mutations older than lookback", async () => {
    store.append({
      source: "webhook",
      ticket: "AI-400",
      changeType: "state",
      field: "state:done",
      recordedAt: "2026-06-01T00:00:00.000Z", // Very old
    });

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      lookbackMs: 60 * 60 * 1000, // 1h lookback
    });

    expect(result.examined).toBe(0);
  });

  test("matches by same ticket + change_type, different field value still correlates", async () => {
    // Proxy did a state transition to state:review
    store.append({
      source: "proxy",
      ticket: "AI-500",
      changeType: "state",
      field: "state:review",
      agent: "ai",
      intent: "advance",
      recordedAt: "2026-07-05T20:29:00.000Z",
    });
    // Webhook observed state:review (same change type, same ticket)
    store.append({
      source: "webhook",
      ticket: "AI-500",
      changeType: "state",
      field: "state:review",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const result = await reconcileOobMutations(store, { nowMs: NOW, graceMs: 60_000 });
    expect(result.correlated).toBe(1);
    expect(result.flagged).toBe(0);
  });

  test("proxy op outside match window does not correlate → flagged", async () => {
    // Proxy op was 2 hours ago — well outside the ±10min window
    store.append({
      source: "proxy",
      ticket: "AI-600",
      changeType: "state",
      field: "state:done",
      recordedAt: "2026-07-05T18:00:00.000Z",
    });
    // Webhook at 20:30
    store.append({
      source: "webhook",
      ticket: "AI-600",
      changeType: "state",
      field: "state:done",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const result = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
      matchWindowMs: 10 * 60_000,
    });

    expect(result.correlated).toBe(0);
    expect(result.flagged).toBe(1);
  });

  test("label changes are reconciled", async () => {
    // No proxy op for a label change → flagged
    store.append({
      source: "webhook",
      ticket: "AI-700",
      changeType: "label",
      field: "label:state:done",
      newValue: "added",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const result = await reconcileOobMutations(store, { nowMs: NOW, graceMs: 60_000 });
    expect(result.flagged).toBe(1);
    expect(result.flaggedDetails[0].changeType).toBe("label");
  });

  test("multiple mutations — mixed correlated and flagged", async () => {
    // AI-1: correlated (proxy + webhook)
    store.append({
      source: "proxy",
      ticket: "AI-1",
      changeType: "state",
      recordedAt: "2026-07-05T20:29:00.000Z",
    });
    store.append({
      source: "webhook",
      ticket: "AI-1",
      changeType: "state",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    // AI-2: out-of-band (webhook only)
    store.append({
      source: "webhook",
      ticket: "AI-2",
      changeType: "delegate",
      recordedAt: "2026-07-05T20:31:00.000Z",
    });

    const result = await reconcileOobMutations(store, { nowMs: NOW, graceMs: 60_000 });
    expect(result.examined).toBe(2);
    expect(result.correlated).toBe(1);
    expect(result.flagged).toBe(1);
    expect(result.flaggedDetails[0].ticket).toBe("AI-2");
  });

  test("idempotent — second run does not re-examine correlated records", async () => {
    store.append({
      source: "proxy",
      ticket: "AI-800",
      changeType: "state",
      recordedAt: "2026-07-05T20:29:00.000Z",
    });
    store.append({
      source: "webhook",
      ticket: "AI-800",
      changeType: "state",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const first = await reconcileOobMutations(store, { nowMs: NOW, graceMs: 60_000 });
    expect(first.correlated).toBe(1);

    const second = await reconcileOobMutations(store, { nowMs: NOW, graceMs: 60_000 });
    expect(second.examined).toBe(0);
    expect(second.correlated).toBe(0);
    expect(second.flagged).toBe(0);
  });

  test("AI-2191: flagged mutations are resolved — second pass does not re-examine or re-alert them", async () => {
    // A single out-of-band mutation (webhook only, no proxy op).
    store.append({
      source: "webhook",
      ticket: "AI-2191-OOB",
      changeType: "state",
      field: "state:done",
      actorId: "user-raw-token-holder",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    const bus1 = fakeAlertBus();
    const first = await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
      alertBus: bus1 as any,
    });
    expect(first.examined).toBe(1);
    expect(first.flagged).toBe(1);
    expect(bus1._calls).toHaveLength(1);

    // Second pass in a later hour: the record must already be resolved, so it
    // is not re-examined and the alert does not re-fire. Before the fix, the
    // still-uncorrelated record was re-counted every pass and the count climbed.
    const bus2 = fakeAlertBus();
    const second = await reconcileOobMutations(store, {
      nowMs: NOW + 60 * 60 * 1000, // +1h — fresh dedup key, would re-alert if unresolved
      graceMs: 60_000,
      alertBus: bus2 as any,
    });
    expect(second.examined).toBe(0);
    expect(second.flagged).toBe(0);
    expect(bus2._calls).toHaveLength(0);
  });

  test("writes operational events for flagged mutations", async () => {
    const opStore = fakeOpStore();

    store.append({
      source: "webhook",
      ticket: "AI-900",
      changeType: "state",
      field: "state:done",
      recordedAt: "2026-07-05T20:30:00.000Z",
    });

    await reconcileOobMutations(store, {
      nowMs: NOW,
      graceMs: 60_000,
      operationalEventStore: opStore,
    });

    expect(opStore._events.length).toBeGreaterThanOrEqual(1);
    expect(String(opStore._events[0].errorSummary)).toContain("Out-of-band");
  });
});
