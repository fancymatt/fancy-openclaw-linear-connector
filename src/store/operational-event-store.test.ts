import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationalEventStore, redactOperationalDetail } from "./operational-event-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operational-events-test-"));
  return path.join(dir, "events.db");
}

describe("OperationalEventStore", () => {
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

  it("redacts token and secret fields before persisting or returning details", () => {
    store.append({
      outcome: "delivery-failed",
      type: "Issue",
      agent: "igor",
      key: "linear-AI-616",
      errorSummary: "failed with access-token-secret-value",
      detail: {
        accessToken: "access-token-secret-value",
        nested: { clientSecret: "client-secret-value", safe: "kept" },
        headers: { authorization: "Bearer token" },
      },
    });

    const [event] = store.query({ agent: "igor" });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("access-token-secret-value");
    expect(serialized).not.toContain("client-secret-value");
    expect(serialized).not.toContain("Bearer token");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("kept");
  });

  it("redacts credential value shapes embedded under non-sensitive detail keys", () => {
    const sensitiveMessages = [
      "Authorization: Bearer sk_live_1234567890abcdef",
      "Bearer sk_live_1234567890abcdef",
      "api key: sk_live_1234567890abcdef",
      "x-api-key: sk_live_1234567890abcdef",
      "linear-signature: lin_wh_abc123456789",
    ];

    for (const message of sensitiveMessages) {
      const detail = redactOperationalDetail({ message });
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain("sk_live_1234567890abcdef");
      expect(serialized).not.toContain("lin_wh_abc123456789");
      expect(serialized).toContain("[REDACTED]");
    }
  });

  it("redacts credential value shapes from persisted error summaries", () => {
    const sensitiveSummaries = [
      "Authorization: Bearer sk_live_1234567890abcdef",
      "Bearer sk_live_1234567890abcdef",
      "api key: sk_live_1234567890abcdef",
      "x-api-key: sk_live_1234567890abcdef",
      "linear-signature: lin_wh_abc123456789",
    ];

    sensitiveSummaries.forEach((errorSummary, index) => store.append({
      outcome: "delivery-failed",
      agent: "igor",
      key: `linear-AI-616-${index}`,
      errorSummary,
    }));

    const serialized = JSON.stringify(store.query({ agent: "igor" }));
    expect(serialized).not.toContain("sk_live_1234567890abcdef");
    expect(serialized).not.toContain("lin_wh_abc123456789");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts hyphenated sensitive detail keys", () => {
    const detail = redactOperationalDetail({
      "api-key": "sk_live_1234567890abcdef",
      "x-api-key": "sk_live_abcdef1234567890",
      "linear-signature": "lin_wh_abc123456789",
      safe: "kept",
    });

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("sk_live_1234567890abcdef");
    expect(serialized).not.toContain("sk_live_abcdef1234567890");
    expect(serialized).not.toContain("lin_wh_abc123456789");
    expect(serialized).toContain("kept");
  });

  it("bounds large JSON details", () => {
    const detail = redactOperationalDetail({ big: "x".repeat(20_000) });
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeLessThanOrEqual(4200);
    expect(detail).toMatchObject({ truncated: true });
  });

  it("queries representative lifecycle rows by agent, key, outcome, type, and time range", () => {
    store.append({ outcome: "received", type: "Issue", key: "linear-AI-616", occurredAt: "2026-05-01T10:00:00.000Z" });
    store.append({ outcome: "routed", type: "Issue", agent: "igor", key: "linear-AI-616", occurredAt: "2026-05-01T10:01:00.000Z" });
    store.append({ outcome: "bag-added", type: "Issue", agent: "igor", key: "linear-AI-616", occurredAt: "2026-05-01T10:02:00.000Z" });
    store.append({ outcome: "delivered", type: "Issue", agent: "igor", key: "linear-AI-616", deliveryMode: "wake-up", attemptCount: 1, occurredAt: "2026-05-01T10:03:00.000Z" });
    store.append({ outcome: "delivery-failed", type: "Comment", agent: "sage", key: "linear-AI-617", occurredAt: "2026-05-01T10:04:00.000Z" });

    expect(store.query({ agent: "igor" })).toHaveLength(3);
    expect(store.query({ key: "linear-AI-616" })).toHaveLength(4);
    expect(store.query({ outcome: "delivered" })[0].deliveryMode).toBe("wake-up");
    expect(store.query({ type: "Comment" })[0].agent).toBe("sage");
    expect(store.query({ since: "2026-05-01T10:02:30.000Z", until: "2026-05-01T10:03:30.000Z" })).toHaveLength(1);
  });

  it("returns a lifecycle snapshot with last success and last error", () => {
    store.append({ outcome: "delivered", agent: "igor", key: "linear-AI-616", occurredAt: "2026-05-01T10:00:00.000Z" });
    store.append({ outcome: "delivery-failed", agent: "igor", key: "linear-AI-616", errorSummary: "agent unavailable", occurredAt: "2026-05-01T10:01:00.000Z" });

    const snapshot = store.snapshot({ key: "linear-AI-616" });
    expect(snapshot.lifecycle).toHaveLength(2);
    expect(snapshot.lastSuccess?.outcome).toBe("delivered");
    expect(snapshot.lastError?.errorSummary).toBe("agent unavailable");
  });
});

describe("OperationalEventStore — retention/pruning", () => {
  let dbPath: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operational-events-prune-test-"));
    dbPath = path.join(dir, "events.db");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.OPERATIONAL_EVENT_MAX_AGE_DAYS;
    delete process.env.OPERATIONAL_EVENT_MAX_ROWS;
  });

  it("prune() removes rows older than OPERATIONAL_EVENT_MAX_AGE_DAYS", () => {
    process.env.OPERATIONAL_EVENT_MAX_AGE_DAYS = "30";
    const store = new OperationalEventStore(dbPath);
    // One row from 60 days ago (stale) and one recent
    store.append({ outcome: "received", occurredAt: new Date(Date.now() - 60 * 86_400_000).toISOString() });
    store.append({ outcome: "routed", occurredAt: new Date().toISOString() });
    expect(store.query()).toHaveLength(2);
    const removed = store.prune();
    expect(removed).toBe(1);
    const remaining = store.query();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].outcome).toBe("routed");
    store.close();
  });

  it("prune() enforces OPERATIONAL_EVENT_MAX_ROWS cap, keeping newest rows", () => {
    process.env.OPERATIONAL_EVENT_MAX_ROWS = "3";
    const store = new OperationalEventStore(dbPath);
    const outcomes = ["received", "normalized", "routed", "bag-added", "delivered"] as const;
    for (let i = 0; i < 5; i++) {
      store.append({ outcome: outcomes[i], occurredAt: new Date(Date.now() + i * 1000).toISOString() });
    }
    expect(store.query({ limit: 10 })).toHaveLength(5);
    const removed = store.prune();
    expect(removed).toBe(2);
    const remaining = store.query({ limit: 10 });
    expect(remaining).toHaveLength(3);
    // Newest 3 should be kept
    expect(remaining.map((e) => e.outcome)).toContain("delivered");
    store.close();
  });

  it("prune() logs removed row count at INFO level", () => {
    process.env.OPERATIONAL_EVENT_MAX_ROWS = "1";
    const store = new OperationalEventStore(dbPath);
    store.append({ outcome: "received", occurredAt: "2020-01-01T00:00:00.000Z" });
    store.append({ outcome: "routed", occurredAt: "2020-01-02T00:00:00.000Z" });
    const spy = jest.spyOn(console, "info").mockImplementation(() => undefined);
    store.prune();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/pruned \d+ row/));
    spy.mockRestore();
    store.close();
  });

  it("prune() does not log when no rows are removed", () => {
    const store = new OperationalEventStore(dbPath);
    store.append({ outcome: "received", occurredAt: new Date().toISOString() });
    const spy = jest.spyOn(console, "info").mockImplementation(() => undefined);
    store.prune();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    store.close();
  });

  it("prune() runs automatically on startup", () => {
    // Insert two rows via a raw DB, then open OperationalEventStore with a tight max-age
    process.env.OPERATIONAL_EVENT_MAX_AGE_DAYS = "1";
    // Pre-seed using a temporary store without age constraint
    const seed = new OperationalEventStore(dbPath);
    seed.append({ outcome: "received", occurredAt: "2020-01-01T00:00:00.000Z" });
    seed.append({ outcome: "routed", occurredAt: "2020-01-02T00:00:00.000Z" });
    seed.close();
    // Opening a new store with the strict max-age env var should prune on init
    const store = new OperationalEventStore(dbPath);
    expect(store.query({ limit: 10 })).toHaveLength(0);
    store.close();
  });

  it("prune() runs automatically every 100 appends", () => {
    process.env.OPERATIONAL_EVENT_MAX_ROWS = "50";
    const store = new OperationalEventStore(dbPath);
    // Insert 250 rows — prune fires at write 100 and write 200, each time capping at 50
    for (let i = 0; i < 250; i++) {
      store.append({ outcome: "received", occurredAt: new Date(Date.now() + i * 1000).toISOString() });
    }
    // After the 200th prune fires we have 50, then 50 more inserts → 100 total
    // Confirms pruning fired (without it, all 250 would remain)
    const remaining = store.query({ limit: 500 });
    expect(remaining.length).toBeLessThan(250);
    expect(remaining.length).toBeLessThanOrEqual(100);
    store.close();
  });
});
