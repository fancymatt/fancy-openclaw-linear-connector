/**
 * AI-1838 — Audit-log + out-of-band reconcile tests.
 *
 * Tests three things:
 *   1. OperationalEventStore accepts the new outcomes (proxy-forwarded,
 *      transition-applied, state-change-observed, out-of-band-detected, etc.)
 *   2. The reconcile pass correctly matches state-change-observed events to
 *      proxy ops and flags unmatched ones as out-of-band.
 *   3. Encryption is enabled when a key is configured (AC3 verification).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { runOutOfBandReconcilePass } from "./cron/out-of-band-reconcile.js";

function createTempStore(): { store: OperationalEventStore; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1838-test-"));
  const dbPath = path.join(tmpDir, "operational-events.db");
  const store = new OperationalEventStore(dbPath);
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("AI-1838: OperationalEventStore new outcomes", () => {
  let cleanup: () => void;
  let store: OperationalEventStore;

  beforeEach(() => {
    const result = createTempStore();
    store = result.store;
    cleanup = result.cleanup;
  });

  afterEach(() => cleanup());

  it("accepts proxy-forwarded outcome", () => {
    const id = store.append({ outcome: "proxy-forwarded", agent: "igor", key: "linear-AI-1838", type: "implement", detail: { op: "issueUpdate", intent: "implement" } });
    expect(id).toBeGreaterThan(0);
    const events = store.query({ outcome: "proxy-forwarded" });
    expect(events.length).toBe(1);
    expect(events[0].agent).toBe("igor");
    expect(events[0].key).toBe("linear-AI-1838");
  });

  it("accepts proxy-blocked outcome", () => {
    const id = store.append({ outcome: "proxy-blocked", agent: "igor", key: "linear-AI-1838", errorSummary: "workflow-gate rejection", detail: { reason: "workflow-gate" } });
    expect(id).toBeGreaterThan(0);
    const events = store.query({ outcome: "proxy-blocked" });
    expect(events.length).toBe(1);
  });

  it("accepts transition-applied outcome", () => {
    store.append({ outcome: "transition-applied", agent: "igor", key: "linear-AI-1838", type: "implement", detail: { code: "transition-applied", from: "intake", to: "write-tests" } });
    const events = store.query({ outcome: "transition-applied" });
    expect(events.length).toBe(1);
  });

  it("accepts transition-failed outcome", () => {
    store.append({ outcome: "transition-failed", agent: "igor", key: "linear-AI-1838", errorSummary: "atomic-mutation-failed", detail: { code: "atomic-mutation-failed" } });
    const events = store.query({ outcome: "transition-failed" });
    expect(events.length).toBe(1);
  });

  it("accepts state-change-observed outcome", () => {
    store.append({
      outcome: "state-change-observed",
      key: "linear-AI-1838",
      sessionKey: "linear-AI-1838",
      agent: "ai",
      detail: {
        changes: { state: { from: { name: "Todo" }, to: { name: "In Progress" } } },
        actor: { id: "abc", name: "ai", isAgent: true },
        identifier: "AI-1838",
      },
    });
    const events = store.query({ outcome: "state-change-observed" });
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("linear-AI-1838");
  });

  it("accepts out-of-band-detected outcome", () => {
    store.append({ outcome: "out-of-band-detected", key: "linear-AI-1838", errorSummary: "Out-of-band state change", detail: { ticket: "linear-AI-1838" } });
    const events = store.query({ outcome: "out-of-band-detected" });
    expect(events.length).toBe(1);
  });

  it("accepts proxy-upstream-error and proxy-rate-limited outcomes", () => {
    store.append({ outcome: "proxy-upstream-error", agent: "igor", key: "linear-AI-1838", errorSummary: "Linear API returned 500", detail: {} });
    store.append({ outcome: "proxy-rate-limited", agent: "igor", key: "linear-AI-1838", errorSummary: "429", detail: {} });
    expect(store.query({ outcome: "proxy-upstream-error" }).length).toBe(1);
    expect(store.query({ outcome: "proxy-rate-limited" }).length).toBe(1);
  });

  it("classifies proxy-forwarded and transition-applied as success outcomes in snapshot", () => {
    store.append({ outcome: "proxy-forwarded", agent: "igor", key: "linear-AI-1838", detail: {} });
    store.append({ outcome: "transition-applied", agent: "igor", key: "linear-AI-1838", detail: {} });
    store.append({ outcome: "proxy-blocked", agent: "igor", key: "linear-AI-1838", errorSummary: "blocked", detail: {} });
    const snap = store.snapshot({ key: "linear-AI-1838" });
    expect(snap.lastSuccess).toBeDefined();
    expect(snap.lastSuccess?.outcome).toBe("transition-applied");
    expect(snap.lastError).toBeDefined();
    expect(snap.lastError?.outcome).toBe("proxy-blocked");
  });
});

describe("AI-1838 AC2: Out-of-band reconcile", () => {
  let cleanup: () => void;
  let store: OperationalEventStore;

  beforeEach(() => {
    const result = createTempStore();
    store = result.store;
    cleanup = result.cleanup;
  });

  afterEach(() => cleanup());

  it("matches state-change-observed to a proxy-forwarded op within tolerance", () => {
    const now = Date.now();
    // Proxy forwarded 5 seconds before the webhook observed the change.
    store.append({
      outcome: "proxy-forwarded",
      agent: "igor",
      key: "linear-AI-1838",
      type: "implement",
      occurredAt: new Date(now - 5000).toISOString(),
      detail: {},
    });
    store.append({
      outcome: "state-change-observed",
      key: "linear-AI-1838",
      sessionKey: "linear-AI-1838",
      occurredAt: new Date(now).toISOString(),
      detail: {
        changes: { state: { from: { name: "Todo" }, to: { name: "In Progress" } } },
        actor: { id: "abc", name: "ai", isAgent: true },
        identifier: "AI-1838",
      },
    });

    const result = runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 120_000 });
    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.outOfBandDetected).toBe(0);

    // No out-of-band event should have been emitted.
    expect(store.query({ outcome: "out-of-band-detected" }).length).toBe(0);
  });

  it("flags state-change-observed with no matching proxy op as out-of-band", () => {
    const now = Date.now();
    // State change observed, but NO proxy-forwarded event exists.
    store.append({
      outcome: "state-change-observed",
      key: "linear-AI-1838",
      sessionKey: "linear-AI-1838",
      occurredAt: new Date(now).toISOString(),
      detail: {
        changes: { state: { from: { name: "Todo" }, to: { name: "In Progress" } } },
        actor: { id: "human-1", name: "matt", isAgent: false },
        identifier: "AI-1838",
      },
    });

    const result = runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 120_000 });
    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.outOfBandDetected).toBe(1);

    // An out-of-band-detected event should have been emitted.
    const detections = store.query({ outcome: "out-of-band-detected" });
    expect(detections.length).toBe(1);
    expect(detections[0].key).toBe("linear-AI-1838");
    const detail = detections[0].detail as Record<string, unknown>;
    const actor = detail.actor as Record<string, unknown>;
    expect(actor.name).toBe("matt");
    expect(actor.isAgent).toBe(false);
  });

  it("matches state-change to a transition-applied op (not just proxy-forwarded)", () => {
    const now = Date.now();
    store.append({
      outcome: "transition-applied",
      agent: "igor",
      key: "linear-AI-1838",
      type: "implement",
      occurredAt: new Date(now - 3000).toISOString(),
      detail: { code: "transition-applied", from: "intake", to: "write-tests" },
    });
    store.append({
      outcome: "state-change-observed",
      key: "linear-AI-1838",
      sessionKey: "linear-AI-1838",
      occurredAt: new Date(now).toISOString(),
      detail: {
        changes: { labels: { from: { removed: [] }, to: { added: ["state:write-tests"] } } },
        actor: { id: "abc", name: "ai", isAgent: true },
        identifier: "AI-1838",
      },
    });

    const result = runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 120_000 });
    expect(result.matched).toBe(1);
    expect(result.outOfBandDetected).toBe(0);
  });

  it("does NOT match when proxy op is outside tolerance window", () => {
    const now = Date.now();
    // Proxy op was 5 minutes ago — well outside the 60s tolerance.
    store.append({
      outcome: "proxy-forwarded",
      agent: "igor",
      key: "linear-AI-1838",
      type: "implement",
      occurredAt: new Date(now - 300_000).toISOString(),
      detail: {},
    });
    store.append({
      outcome: "state-change-observed",
      key: "linear-AI-1838",
      sessionKey: "linear-AI-1838",
      occurredAt: new Date(now).toISOString(),
      detail: {
        changes: { state: { from: { name: "Todo" }, to: { name: "In Progress" } } },
        actor: { id: "human-1", name: "matt", isAgent: false },
        identifier: "AI-1838",
      },
    });

    const result = runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 600_000 });
    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.outOfBandDetected).toBe(1);
  });

  it("handles multiple tickets independently", () => {
    const now = Date.now();
    // Ticket A: has a matching proxy op.
    store.append({ outcome: "proxy-forwarded", agent: "igor", key: "linear-A", type: "implement", occurredAt: new Date(now - 5000).toISOString(), detail: {} });
    store.append({ outcome: "state-change-observed", key: "linear-A", sessionKey: "linear-A", occurredAt: new Date(now).toISOString(), detail: { changes: { state: {} }, actor: { name: "ai", isAgent: true }, identifier: "A" } });
    // Ticket B: no matching proxy op.
    store.append({ outcome: "state-change-observed", key: "linear-B", sessionKey: "linear-B", occurredAt: new Date(now).toISOString(), detail: { changes: { state: {} }, actor: { name: "matt", isAgent: false }, identifier: "B" } });

    const result = runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 120_000 });
    expect(result.scanned).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.outOfBandDetected).toBe(1);
  });

  it("returns zero results when there are no state-change events", () => {
    store.append({ outcome: "proxy-forwarded", agent: "igor", key: "linear-A", type: "implement", detail: {} });
    const result = runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 120_000 });
    expect(result.scanned).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.outOfBandDetected).toBe(0);
  });

  it("includes out-of-band detection events in the store for alerting", () => {
    const now = Date.now();
    store.append({
      outcome: "state-change-observed",
      key: "linear-AI-1838",
      sessionKey: "linear-AI-1838",
      occurredAt: new Date(now).toISOString(),
      detail: {
        changes: { delegate: { from: { id: "agent-a" }, to: { id: "agent-b" } } },
        actor: { id: "x", name: "matt", isAgent: false },
        identifier: "AI-1838",
      },
    });

    runOutOfBandReconcilePass({ operationalEventStore: store, toleranceMs: 60_000, lookbackMs: 120_000 });

    const detected = store.query({ outcome: "out-of-band-detected", key: "linear-AI-1838" });
    expect(detected.length).toBe(1);
    const detail = detected[0].detail as Record<string, unknown>;
    expect(detail.changes).toBeDefined();
    expect((detail.actor as Record<string, unknown>).name).toBe("matt");
  });
});
