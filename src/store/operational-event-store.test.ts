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
