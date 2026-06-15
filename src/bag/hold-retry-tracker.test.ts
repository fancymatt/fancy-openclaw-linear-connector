/**
 * Unit tests for HoldRetryTracker (AI-1533).
 *
 * Covers the four acceptance-criteria test cases:
 *   - held-run-then-retry
 *   - healthy-run-no-retry
 *   - max-attempts-then-fail
 *   - transition-clears-retry-state
 */

import { HoldRetryTracker } from "./hold-retry-tracker.js";

describe("HoldRetryTracker", () => {
  describe("held-run-then-retry", () => {
    test("shouldRetryHold returns true when no transition was seen", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(true);
    });

    test("shouldRetryHold returns true within grace window", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531", 60_000)).toBe(true);
    });

    test("incrementHoldAttempt returns incremented count", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      expect(tracker.incrementHoldAttempt("igor", "linear-AI-1531")).toBe(1);
      expect(tracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(1);
    });

    test("holdAttempts persist across clearTransition calls", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");
      tracker.clearTransition("igor", "linear-AI-1531");
      expect(tracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(1);
    });
  });

  describe("healthy-run-no-retry", () => {
    test("shouldRetryHold returns false after transition recorded", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(false);
    });

    test("hasTransition returns true after recordTransition", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      expect(tracker.hasTransition("igor", "linear-AI-1531")).toBe(true);
    });

    test("shouldRetryHold false even if holdAttempts is low when transition seen", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      // Even with 0 prior attempts, a transition suppresses retry
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(false);
    });
  });

  describe("max-attempts-then-fail", () => {
    test("shouldRetryHold returns false after maxAttempts exhausted", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.incrementHoldAttempt("igor", "linear-AI-1531"); // 1
      tracker.incrementHoldAttempt("igor", "linear-AI-1531"); // 2
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(false);
    });

    test("shouldRetryHold still true at maxAttempts - 1", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.incrementHoldAttempt("igor", "linear-AI-1531"); // 1
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(true);
    });

    test("shouldRetryHold false when dispatch age exceeds graceMs", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      // Session ran for 150s → deliberate hold, not a transient error
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531", 150_000)).toBe(false);
    });

    test("shouldRetryHold true when dispatch age is exactly at graceMs", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531", 120_000)).toBe(true);
    });
  });

  describe("transition-clears-retry-state", () => {
    test("clearTicket resets both transition and attempt count", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");

      tracker.clearTicket("igor", "linear-AI-1531");

      expect(tracker.hasTransition("igor", "linear-AI-1531")).toBe(false);
      expect(tracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(0);
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(true);
    });

    test("clearTicket on healthy run re-enables retry for next dispatch", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      // Simulate two holds exhausting retries
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(false);

      // Healthy run: transition seen + clearTicket
      tracker.recordTransition("igor", "linear-AI-1531");
      tracker.clearTicket("igor", "linear-AI-1531");

      // New dispatch: should be retryable again
      expect(tracker.shouldRetryHold("igor", "linear-AI-1531")).toBe(true);
    });

    test("clearTransition preserves attempt count but clears transition flag", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");

      tracker.clearTransition("igor", "linear-AI-1531");

      expect(tracker.hasTransition("igor", "linear-AI-1531")).toBe(false);
      expect(tracker.getHoldAttempts("igor", "linear-AI-1531")).toBe(1); // preserved
    });
  });

  describe("isolation", () => {
    test("transitions are per-agent", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      expect(tracker.hasTransition("astrid", "linear-AI-1531")).toBe(false);
    });

    test("transitions are per-ticket", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.recordTransition("igor", "linear-AI-1531");
      expect(tracker.hasTransition("igor", "linear-AI-1532")).toBe(false);
    });

    test("hold attempts are per-(agent, ticket)", () => {
      const tracker = new HoldRetryTracker({ graceMs: 120_000, maxAttempts: 2 });
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");
      tracker.incrementHoldAttempt("igor", "linear-AI-1531");
      expect(tracker.getHoldAttempts("igor", "linear-AI-1532")).toBe(0);
      expect(tracker.getHoldAttempts("astrid", "linear-AI-1531")).toBe(0);
    });
  });
});
