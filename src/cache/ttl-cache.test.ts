/**
 * INF-193 — TTL cache & drift alerting: unit tests.
 *
 * Covers AC1 (TTL invalidation), AC2 (drift detection), and AC3 (flush).
 *
 * NOTE: these tests import from ../cache/ttl-cache.js which does NOT exist
 * yet — they will fail at import time until the implementation module is
 * created. That is the intended red-test state before `tests-ready`.
 *
 * AC mapping:
 *   AC1 — entries expire after configurable TTL (default ≤ 5m)
 *   AC2 — drift-detection log fires on stale-vs-fresh mismatch
 *   AC3 — flushAll() clears the entire cache
 */

import { jest } from "@jest/globals";
import { TtlCache, getCacheLiveness } from "../cache/ttl-cache.js";

// ══════════════════════════════════════════════════════════════════════════
// AC1 — TTL-based cache invalidation
// ══════════════════════════════════════════════════════════════════════════

describe("AC1 — TTL-based cache invalidation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns cached value before TTL expiry", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("label:state", "value");
    expect(cache.get("label:state")).toBe("value");
  });

  test("returns undefined after TTL expiry", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 100 });
    cache.set("label:state", "value");
    jest.advanceTimersByTime(200);
    expect(cache.get("label:state")).toBeUndefined();
  });

  test("default TTL is ≤ 5 minutes (300_000ms) for workflow-critical data", () => {
    const cache = new TtlCache<string>();
    // Assert the default is at most 5 minutes.
    // The exact value is the implementer's choice, as long as it's within
    // the ≤ 5m bound the AC specifies.
    const liveness = getCacheLiveness();
    expect(liveness.defaultTtlMs).toBeLessThanOrEqual(300_000);
    expect(liveness.defaultTtlMs).toBeGreaterThan(0);
  });

  test("per-entry TTL overrides the default", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    // Set with a short TTL — should expire before the default would.
    cache.set("ephemeral", "short-lived", 50);
    jest.advanceTimersByTime(100);
    expect(cache.get("ephemeral")).toBeUndefined();

    // A default-TTL entry set at the same time should still be alive.
    cache.set("persistent", "long-lived");
    jest.advanceTimersByTime(100);
    expect(cache.get("persistent")).toBe("long-lived");
  });

  test("multiple entries expire independently", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("a", "1", 50);
    cache.set("b", "2", 100);
    cache.set("c", "3");
    jest.advanceTimersByTime(80);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  test("has() reflects expiry", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 100 });
    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
    jest.advanceTimersByTime(200);
    expect(cache.has("key")).toBe(false);
  });

  test("delete() removes entry immediately", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("key", "value");
    cache.delete("key");
    expect(cache.get("key")).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC2 — Cache drift detection
// ══════════════════════════════════════════════════════════════════════════

describe("AC2 — cache drift detection", () => {
  test("detectDrift returns drifted=true and logs when stale and fresh differ", async () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("workflow:state", "In Review");

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await cache.detectDrift("workflow:state", () => "Done");

    expect(result.drifted).toBe(true);
    expect(result.key).toBe("workflow:state");
    expect(result.staleValue).toBe("In Review");
    expect(result.freshValue).toBe("Done");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("drift"),
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  test("detectDrift returns drifted=false when values match", async () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("workflow:state", "In Review");

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await cache.detectDrift("workflow:state", () => "In Review");

    expect(result.drifted).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("detectDrift returns drifted=false when key not in cache", async () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    const result = await cache.detectDrift("nonexistent", () => "Fresh");
    expect(result.drifted).toBe(false);
  });

  test("detectDrift accepts async freshResolve", async () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("async:key", "old");
    const result = await cache.detectDrift("async:key", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "old";
    });
    expect(result.drifted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3 — Manual cache-flush
// ══════════════════════════════════════════════════════════════════════════

describe("AC3 — manual cache-flush", () => {
  test("flushAll() clears all cached entries", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.size).toBe(3);

    cache.flushAll();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
  });

  test("flushAll() leaves new entries unaffected", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("old", "value");
    cache.flushAll();
    cache.set("new", "after-flush");
    expect(cache.get("new")).toBe("after-flush");
    expect(cache.get("old")).toBeUndefined();
  });

  test("liveness shows flush route state", () => {
    // The flush route must be explicitly marked as mounted at bootstrap.
    // Before registration, the route is not mounted.
    const before = getCacheLiveness();
    expect(before.flushRouteMounted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC1 — default TTL ≤ 5m (liveness field assertion)
// ══════════════════════════════════════════════════════════════════════════

describe("AC1 — cache liveness exposes default TTL", () => {
  test("getCacheLiveness returns defaultTtlMs and entry count", () => {
    const cache = new TtlCache<string>({ defaultTtlMs: 300_000 });
    cache.set("k1", "v1");
    cache.set("k2", "v2");
    const liveness = getCacheLiveness();
    expect(liveness.defaultTtlMs).toBe(300_000);
    expect(liveness.entries).toBe(2);
  });
});
