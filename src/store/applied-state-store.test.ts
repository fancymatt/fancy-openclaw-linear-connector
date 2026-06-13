/**
 * AI-1534 — Tests for the authoritative post-transition state cache.
 */

import {
  recordAppliedState,
  getAppliedState,
  clearAppliedState,
  _resetAppliedStateStore,
  APPLIED_STATE_TTL_MS,
} from "./applied-state-store.js";

beforeEach(() => {
  _resetAppliedStateStore();
});

describe("applied-state-store", () => {
  it("returns the recorded state within the TTL window", () => {
    const t0 = 1_000_000;
    recordAppliedState("AI-1531", "write-tests", t0);
    expect(getAppliedState("AI-1531", t0)).toBe("write-tests");
    expect(getAppliedState("AI-1531", t0 + APPLIED_STATE_TTL_MS - 1)).toBe("write-tests");
  });

  it("evicts and returns null once the TTL has elapsed", () => {
    const t0 = 1_000_000;
    recordAppliedState("AI-1531", "write-tests", t0);
    expect(getAppliedState("AI-1531", t0 + APPLIED_STATE_TTL_MS + 1)).toBeNull();
    // Subsequent reads (even within TTL of nothing) stay null — entry was evicted.
    expect(getAppliedState("AI-1531", t0 + 1)).toBeNull();
  });

  it("returns null for an unknown ticket", () => {
    expect(getAppliedState("AI-9999")).toBeNull();
  });

  it("is case- and whitespace-insensitive on the key", () => {
    const t0 = 1_000_000;
    recordAppliedState("ai-1531", "implementation", t0);
    expect(getAppliedState("  AI-1531  ", t0)).toBe("implementation");
  });

  it("the latest record wins (a re-transition overwrites)", () => {
    const t0 = 1_000_000;
    recordAppliedState("AI-1531", "write-tests", t0);
    recordAppliedState("AI-1531", "implementation", t0 + 5);
    expect(getAppliedState("AI-1531", t0 + 10)).toBe("implementation");
  });

  it("clearAppliedState drops the entry", () => {
    const t0 = 1_000_000;
    recordAppliedState("AI-1531", "write-tests", t0);
    clearAppliedState("AI-1531");
    expect(getAppliedState("AI-1531", t0)).toBeNull();
  });

  it("ignores empty issue ids", () => {
    recordAppliedState("", "write-tests");
    expect(getAppliedState("")).toBeNull();
  });
});
