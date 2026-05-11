import { jest } from "@jest/globals";
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
    const result = tracker.startSession("igor", "linear-AI-100");
    expect(result).toBe(true);
  });

  test("startSession returns false when same session key is already active", () => {
    tracker.startSession("igor", "linear-AI-100");
    const result = tracker.startSession("igor", "linear-AI-100");
    expect(result).toBe(false);
  });

  test("startSession allows concurrent sessions with different ticket keys for same agent", () => {
    expect(tracker.startSession("igor", "linear-AI-100")).toBe(true);
    expect(tracker.startSession("igor", "linear-AI-101")).toBe(true);
    expect(tracker.startSession("igor", "linear-AI-102")).toBe(true);
    expect(tracker.isActive("igor")).toBe(true);
    expect(tracker.getActiveSessionKeys("igor").sort()).toEqual([
      "linear-AI-100",
      "linear-AI-101",
      "linear-AI-102",
    ]);
  });

  test("endSession returns null when no active session", () => {
    const result = tracker.endSession("igor");
    expect(result).toBeNull();
  });

  test("endSession with sessionKey ends only that specific session", () => {
    tracker.startSession("igor", "linear-AI-100");
    tracker.startSession("igor", "linear-AI-101");

    const result = tracker.endSession("igor", "linear-AI-100");
    expect(result).toBeNull(); // Still has AI-101 active — no pending signals yet
    expect(tracker.isActive("igor")).toBe(true);
    expect(tracker.getActiveSessionKeys("igor")).toEqual(["linear-AI-101"]);
  });

  test("endSession returns pending signals only when all sessions end", () => {
    tracker.startSession("igor", "linear-AI-100");
    tracker.startSession("igor", "linear-AI-101");
    tracker.queueSignal("igor", ["linear-AI-200"]);

    // End first session — still has one remaining, no pending signals returned yet
    const first = tracker.endSession("igor", "linear-AI-100");
    expect(first).toBeNull();
    expect(tracker.isActive("igor")).toBe(true);

    // End second session — now agent has no active sessions, return pending signals
    const second = tracker.endSession("igor", "linear-AI-101");
    expect(second).toEqual(["linear-AI-200"]);
    expect(tracker.isActive("igor")).toBe(false);
  });

  test("endSession without sessionKey clears all sessions (backward compat)", () => {
    tracker.startSession("igor", "linear-AI-100");
    tracker.startSession("igor", "linear-AI-101");
    tracker.queueSignal("igor", ["linear-AI-200"]);

    const result = tracker.endSession("igor");
    expect(result).toEqual(["linear-AI-200"]);
    expect(tracker.isActive("igor")).toBe(false);
  });

  test("endSession returns null when no pending signals", () => {
    tracker.startSession("igor", "linear-AI-100");
    const result = tracker.endSession("igor");
    expect(result).toBeNull();
  });

  test("isActive returns correct state", () => {
    expect(tracker.isActive("igor")).toBe(false);
    tracker.startSession("igor", "linear-AI-100");
    expect(tracker.isActive("igor")).toBe(true);
    tracker.endSession("igor");
    expect(tracker.isActive("igor")).toBe(false);
  });

  test("isActiveForTicket returns true only for active session keys", () => {
    tracker.startSession("igor", "linear-AI-100");
    tracker.startSession("igor", "linear-AI-101");

    expect(tracker.isActiveForTicket("igor", "linear-AI-100")).toBe(true);
    expect(tracker.isActiveForTicket("igor", "linear-AI-101")).toBe(true);
    expect(tracker.isActiveForTicket("igor", "linear-AI-999")).toBe(false);
    expect(tracker.isActiveForTicket("charles", "linear-AI-100")).toBe(false);

    tracker.endSession("igor", "linear-AI-100");
    expect(tracker.isActiveForTicket("igor", "linear-AI-100")).toBe(false);
    expect(tracker.isActiveForTicket("igor", "linear-AI-101")).toBe(true);
  });

  test("queueSignal accumulates and dedupes ticket IDs", () => {
    tracker.startSession("igor", "linear-AI-100");
    tracker.queueSignal("igor", ["linear-AI-200", "linear-AI-201"]);
    tracker.queueSignal("igor", ["linear-AI-201", "linear-AI-202"]);
    const result = tracker.endSession("igor");
    expect(result).toEqual(["linear-AI-200", "linear-AI-201", "linear-AI-202"]);
  });

  test("cleanupStale ends timed-out sessions AND returns agents with pending signals", async () => {
    // Use a 1ms timeout so sessions are immediately stale
    const shortTracker = new SessionTracker(1);
    shortTracker.startSession("igor", "linear-AI-200");
    shortTracker.queueSignal("igor", ["linear-AI-300"]);

    // Wait a tick for timeout to elapse
    await new Promise((r) => setTimeout(r, 10));

    const needsResignal = shortTracker.cleanupStale();
    expect(needsResignal).toHaveLength(1);
    expect(needsResignal[0]).toEqual({ agentId: "igor", pendingTickets: ["linear-AI-300"] });
    expect(shortTracker.isActive("igor")).toBe(false);
    shortTracker.close();
  });

  test("cleanupStale expires individual sessions independently", async () => {
    // Use a 1ms timeout so sessions are immediately stale
    const shortTracker = new SessionTracker(1);
    shortTracker.startSession("igor", "linear-AI-200");
    shortTracker.startSession("igor", "linear-AI-201");

    await new Promise((r) => setTimeout(r, 10));

    const needsResignal = shortTracker.cleanupStale();
    // Both sessions expired, no pending signals queued
    expect(needsResignal).toHaveLength(0);
    expect(shortTracker.isActive("igor")).toBe(false);
    shortTracker.close();
  });

  test("cleanupStale does nothing for sessions within timeout", () => {
    tracker.startSession("igor", "linear-AI-100");
    const needsResignal = tracker.cleanupStale();
    expect(needsResignal).toHaveLength(0);
    expect(tracker.isActive("igor")).toBe(true);
  });

  test("cleanupStale returns empty for stale sessions without pending signals", async () => {
    const shortTracker = new SessionTracker(1);
    shortTracker.startSession("igor", "linear-AI-100");
    // No signals queued

    await new Promise((r) => setTimeout(r, 10));

    const needsResignal = shortTracker.cleanupStale();
    expect(needsResignal).toHaveLength(0);
    expect(shortTracker.isActive("igor")).toBe(false);
    shortTracker.close();
  });

  test("getActiveAgents returns correct list", () => {
    expect(tracker.getActiveAgents()).toEqual([]);
    tracker.startSession("igor", "linear-AI-100");
    tracker.startSession("charles", "linear-AI-200");
    expect(tracker.getActiveAgents().sort()).toEqual(["charles", "igor"]);
    tracker.endSession("igor");
    expect(tracker.getActiveAgents()).toEqual(["charles"]);
  });

  test("getActiveSessionKey returns first key or null", () => {
    expect(tracker.getActiveSessionKey("igor")).toBeNull();
    tracker.startSession("igor", "linear-AI-100");
    expect(tracker.getActiveSessionKey("igor")).toBe("linear-AI-100");
  });

  test("getActiveSessionKeys returns all active keys for agent", () => {
    expect(tracker.getActiveSessionKeys("igor")).toEqual([]);
    tracker.startSession("igor", "linear-AI-100");
    tracker.startSession("igor", "linear-AI-101");
    expect(tracker.getActiveSessionKeys("igor").sort()).toEqual(["linear-AI-100", "linear-AI-101"]);
  });

  test("getActiveSessionInfo exposes diagnostic session metadata", () => {
    expect(tracker.getActiveSessionInfo("igor")).toBeNull();
    tracker.startSession("igor", "linear-AI-123");

    const info = tracker.getActiveSessionInfo("igor");
    expect(info).toMatchObject({
      agentId: "igor",
      sessionKey: "linear-AI-123",
    });
    expect(info?.startedAt).toEqual(expect.any(Number));
    expect(info?.ageMs).toEqual(expect.any(Number));
    expect(info?.ageMs).toBeGreaterThanOrEqual(0);
  });

  test("default connector session timeout is 25 minutes, not a two-hour lock", async () => {
    const original = process.env.SESSION_TIMEOUT_MS;
    delete process.env.SESSION_TIMEOUT_MS;
    const defaultTracker = new SessionTracker();
    defaultTracker.startSession("igor", "linear-AI-999");

    // Move wall clock forward just past the default timeout.
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(realNow + 25 * 60 * 1000 + 1);
    try {
      defaultTracker.cleanupStale();
      expect(defaultTracker.isActive("igor")).toBe(false);
    } finally {
      nowSpy.mockRestore();
      defaultTracker.close();
      if (original === undefined) delete process.env.SESSION_TIMEOUT_MS;
      else process.env.SESSION_TIMEOUT_MS = original;
    }
  });
});
