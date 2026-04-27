import { SessionTracker } from "./session-tracker.js";

describe("SessionTracker", () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker(30_000); // 30s timeout for tests
  });

  afterEach(() => {
    tracker.close();
  });

  test("startSession succeeds when no active session", () => {
    const result = tracker.startSession("igor", "session-1");
    expect(result).toBe(true);
  });

  test("startSession returns false when session already active", () => {
    tracker.startSession("igor", "session-1");
    const result = tracker.startSession("igor", "session-2");
    expect(result).toBe(false);
  });

  test("endSession returns null when no active session", () => {
    const result = tracker.endSession("igor");
    expect(result).toBeNull();
  });

  test("endSession returns pending signals", () => {
    tracker.startSession("igor", "session-1");
    tracker.queueSignal("igor", ["AI-100", "AI-101"]);
    const result = tracker.endSession("igor");
    expect(result).toEqual(["AI-100", "AI-101"]);
  });

  test("endSession returns null when no pending signals", () => {
    tracker.startSession("igor", "session-1");
    const result = tracker.endSession("igor");
    expect(result).toBeNull();
  });

  test("isActive returns correct state", () => {
    expect(tracker.isActive("igor")).toBe(false);
    tracker.startSession("igor", "session-1");
    expect(tracker.isActive("igor")).toBe(true);
    tracker.endSession("igor");
    expect(tracker.isActive("igor")).toBe(false);
  });

  test("queueSignal accumulates and dedupes ticket IDs", () => {
    tracker.startSession("igor", "session-1");
    tracker.queueSignal("igor", ["AI-100", "AI-101"]);
    tracker.queueSignal("igor", ["AI-101", "AI-102"]);
    const result = tracker.endSession("igor");
    expect(result).toEqual(["AI-100", "AI-101", "AI-102"]);
  });

  test("cleanupStale ends timed-out sessions AND returns agents with pending signals", async () => {
    // Use a 1ms timeout so sessions are immediately stale
    const shortTracker = new SessionTracker(1);
    shortTracker.startSession("igor", "session-1");
    shortTracker.queueSignal("igor", ["AI-200"]);

    // Wait a tick for timeout to elapse
    await new Promise((r) => setTimeout(r, 10));

    const needsResignal = shortTracker.cleanupStale();
    expect(needsResignal).toHaveLength(1);
    expect(needsResignal[0]).toEqual({ agentId: "igor", pendingTickets: ["AI-200"] });
    expect(shortTracker.isActive("igor")).toBe(false);
    shortTracker.close();
  });

  test("cleanupStale does nothing for sessions within timeout", () => {
    tracker.startSession("igor", "session-1");
    const needsResignal = tracker.cleanupStale();
    expect(needsResignal).toHaveLength(0);
    expect(tracker.isActive("igor")).toBe(true);
  });

  test("cleanupStale returns empty for stale sessions without pending signals", async () => {
    const shortTracker = new SessionTracker(1);
    shortTracker.startSession("igor", "session-1");
    // No signals queued

    await new Promise((r) => setTimeout(r, 10));

    const needsResignal = shortTracker.cleanupStale();
    expect(needsResignal).toHaveLength(0);
    expect(shortTracker.isActive("igor")).toBe(false);
    shortTracker.close();
  });

  test("getActiveAgents returns correct list", () => {
    expect(tracker.getActiveAgents()).toEqual([]);
    tracker.startSession("igor", "session-1");
    tracker.startSession("charles", "session-2");
    expect(tracker.getActiveAgents().sort()).toEqual(["charles", "igor"]);
    tracker.endSession("igor");
    expect(tracker.getActiveAgents()).toEqual(["charles"]);
  });

  test("getActiveSessionKey returns key or null", () => {
    expect(tracker.getActiveSessionKey("igor")).toBeNull();
    tracker.startSession("igor", "session-abc");
    expect(tracker.getActiveSessionKey("igor")).toBe("session-abc");
  });
});
