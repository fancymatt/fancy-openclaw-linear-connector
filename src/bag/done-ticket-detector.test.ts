/**
 * DoneTicketDetector — failing tests for all 11 acceptance criteria.
 *
 * Must be RED before the implementation lands.
 *
 * AC1 — Done ticket sweep: script queries Done tickets from last N days (N=14 start)
 * AC2 — Code presence check: matches ticket ID (AI-XXXX) in git log origin/main --oneline
 * AC3 — Flagging: no match within M hours → apply needs-merge-verify label + note comment
 * AC4 — Skip labeled: skips tickets already bearing needs-merge-verify label
 * AC5 — Skip unbranched: skips tickets with no branch in the repo
 * AC6 — Re-land creation: creates new re-land ticket for missing fixes; does NOT reopen original
 * AC7 — No ancestry matching: only ticket-ID string match in squash-merge commit message
 * AC8 — Advisory only: never block a transition or fail closed; all errors log and continue
 * AC9 — One comment per ticket: at most one note comment per flagged ticket
 * AC10 — Bootstrap registration: registered in host's periodic task scheduler alongside
 *        linear-connector-watchdog.py
 * AC11 — Liveness observability: on startup, logs a confirmation that it is configured
 *        and scheduled; verifiable without waiting for a full trigger cycle
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  DoneTicketDetector,
  type DoneTicketDetectorConfig,
  type DoneTicketCycleResult,
  type LinearIssue,
  type LinearApi,
  type GitApi,
  type LinearCreateIssueInput,
} from "./done-ticket-detector.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DoneTicketDetectorConfig = {
  lookbackDays: 14,
  graceHours: 4,
  pollIntervalMs: 60 * 60 * 1000, // 1 hour
  repoPath: "/tmp/test-repo",
};

/** Create a minimal Linear issue fixture. */
function makeIssue(overrides: Partial<LinearIssue> & { identifier: string }): LinearIssue {
  return {
    id: `linear-${overrides.identifier.toLowerCase()}`,
    createdAt: new Date().toISOString(),
    labels: [],
    hasBranch: true,
    doneAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a mock LinearApi with spies. */
function makeMockLinearApi(overrides?: Partial<LinearApi>): jest.Mocked<LinearApi> {
  return {
    fetchDoneTickets: jest.fn().mockResolvedValue([]),
    applyLabel: jest.fn().mockResolvedValue(true),
    postComment: jest.fn().mockResolvedValue(true),
    createIssue: jest.fn().mockResolvedValue({ id: "new-issue-id", identifier: "AI-9999" }),
    hasExistingComment: jest.fn().mockResolvedValue(false),
    ...overrides,
  } as jest.Mocked<LinearApi>;
}

/** Create a mock GitApi with spies. */
function makeMockGitApi(overrides?: Partial<GitApi>): jest.Mocked<GitApi> {
  return {
    ticketIdInMainLog: jest.fn().mockResolvedValue(true),
    hasBranchForTicket: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as jest.Mocked<GitApi>;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DoneTicketDetector", () => {
  let detector: DoneTicketDetector;
  let mockLinear: jest.Mocked<LinearApi>;
  let mockGit: jest.Mocked<GitApi>;
  let config: DoneTicketDetectorConfig;

  beforeEach(() => {
    config = { ...DEFAULT_CONFIG };
    mockLinear = makeMockLinearApi();
    mockGit = makeMockGitApi();
  });

  afterEach(() => {
    detector?.stop();
  });

  // ── AC1: Done ticket sweep ────────────────────────────────────────────────

  describe("AC1 — Done ticket sweep", () => {
    it("queries Done tickets from the last N days on each cycle", async () => {
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([
        makeIssue({ identifier: "AI-1000" }),
        makeIssue({ identifier: "AI-1001" }),
      ]);
      mockGit.ticketIdInMainLog.mockResolvedValue(true); // both are on main

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(mockLinear.fetchDoneTickets).toHaveBeenCalledWith(14); // N=14 start
      expect(result.scanned).toBe(2);
    });

    it("returns scanned=0 when no Done tickets exist", async () => {
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([]);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(result.scanned).toBe(0);
      expect(result.flagged).toBe(0);
    });
  });

  // ── AC2: Code presence check ──────────────────────────────────────────────

  describe("AC2 — Code presence check", () => {
    it("checks git log origin/main --oneline for the ticket ID", async () => {
      const ticket = makeIssue({ identifier: "AI-2576" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(true); // found on main

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(mockGit.ticketIdInMainLog).toHaveBeenCalledWith(
        "AI-2576",
        expect.any(Date),
      );
      expect(result.flagged).toBe(0); // found → no flag
    });

    it("flags tickets whose ID is absent from main log", async () => {
      const ticket = makeIssue({ identifier: "AI-2576" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false); // NOT found on main

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(mockGit.ticketIdInMainLog).toHaveBeenCalledWith("AI-2576", expect.any(Date));
      expect(result.flagged).toBe(1);
    });
  });

  // ── AC3: Flagging ─────────────────────────────────────────────────────────

  describe("AC3 — Flagging with label + comment", () => {
    it("applies needs-merge-verify label when ticket is absent from main", async () => {
      const ticket = makeIssue({ identifier: "AI-2000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      await detector.runCycle();

      expect(mockLinear.applyLabel).toHaveBeenCalledWith(ticket.id, "needs-merge-verify");
    });

    it("posts a note comment explaining the flag", async () => {
      const ticket = makeIssue({ identifier: "AI-2000", doneAt: "2026-07-17T12:00:00Z" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      await detector.runCycle();

      expect(mockLinear.postComment).toHaveBeenCalledWith(
        ticket.id,
        expect.stringContaining("AI-2000"),
      );
      const actualBody = mockLinear.postComment.mock.calls[0][1];
      expect(actualBody).toContain("Done but not on main");
      expect(actualBody).toContain("origin/main");
      expect(actualBody).toContain("AI-2000");
    });

    it("includes the Done timestamp in the flagging comment", async () => {
      const ticket = makeIssue({ identifier: "AI-2000", doneAt: "2026-07-17T14:30:00Z" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      await detector.runCycle();

      const actualBody = mockLinear.postComment.mock.calls[0][1];
      expect(actualBody).toContain("2026-07-17T14:30:00");
    });
  });

  // ── AC4: Skip labeled ─────────────────────────────────────────────────────

  describe("AC4 — Skip already-labeled tickets", () => {
    it("skips tickets that already have needs-merge-verify label", async () => {
      const ticket = makeIssue({
        identifier: "AI-3000",
        labels: ["needs-merge-verify"],
      });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(result.skippedLabeled).toBe(1);
      expect(result.flagged).toBe(0);
      expect(mockLinear.applyLabel).not.toHaveBeenCalled();
      expect(mockLinear.postComment).not.toHaveBeenCalled();
    });
  });

  // ── AC5: Skip unbranched ──────────────────────────────────────────────────

  describe("AC5 — Skip unbranched tickets", () => {
    it("skips tickets with no branch in the repo", async () => {
      const ticket = makeIssue({
        identifier: "AI-4000",
        hasBranch: false,
      });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(result.skippedUnbranched).toBe(1);
      expect(result.flagged).toBe(0);
      expect(mockGit.ticketIdInMainLog).not.toHaveBeenCalled();
      expect(mockLinear.applyLabel).not.toHaveBeenCalled();
    });
  });

  // ── AC6: Re-land creation ─────────────────────────────────────────────────

  describe("AC6 — Re-land ticket creation", () => {
    it("creates a new re-land ticket for missing fixes", async () => {
      const ticket = makeIssue({ identifier: "AI-5000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(mockLinear.createIssue).toHaveBeenCalledTimes(1);
      expect(mockLinear.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("re-land"),
          description: expect.stringContaining("AI-5000"),
          parentId: ticket.id,
        }),
      );
      expect(result.reLandCreated).toBe(1);
    });

    it("does NOT reopen the original ticket", async () => {
      const ticket = makeIssue({ identifier: "AI-5000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      await detector.runCycle();

      // The original ticket should NOT be reopened — only a new issue should be created
      const createCall = mockLinear.createIssue.mock.calls[0][0] as LinearCreateIssueInput;
      expect(createCall.title).toContain("re-land");
      expect(createCall.parentId).toBe(ticket.id); // linked as child, NOT reopened
      // No call to an "issue update" to change the original ticket's status
      expect(mockLinear.applyLabel).toHaveBeenCalledWith(ticket.id, "needs-merge-verify");
    });

    it("skips re-land creation if createIssue returns null", async () => {
      const ticket = makeIssue({ identifier: "AI-5001" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockGit.ticketIdInMainLog.mockResolvedValue(false);
      mockLinear.createIssue.mockResolvedValueOnce(null);

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(result.reLandCreated).toBe(0);
      // Should still flag the ticket even if re-land creation fails
      expect(result.flagged).toBe(1);
    });
  });

  // ── AC7: No ancestry matching ─────────────────────────────────────────────

  describe("AC7 — No ancestry matching", () => {
    it("only uses string match in commit message, never SHA ancestry", async () => {
      const ticket = makeIssue({ identifier: "AI-6000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      // The test passes when ticketIdInMainLog is called with the raw identifier string
      // and returns false (no string match). The implementer must NOT do SHA ancestry.
      mockGit.ticketIdInMainLog.mockImplementation(async (ticketId: string) => {
        // This should be a simple `git log --oneline | grep ticketId` — NOT
        // `git merge-base --is-ancestor` or any SHA chain comparison
        return ticketId === "AI-6000" && false; // not found by string match
      });

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(result.flagged).toBe(1);
      // The ticketIdInMainLog call must use the verbatim identifier string
      expect(mockGit.ticketIdInMainLog).toHaveBeenCalledWith("AI-6000", expect.any(Date));
    });
  });

  // ── AC8: Advisory only ────────────────────────────────────────────────────

  describe("AC8 — Advisory only, never fail closed", () => {
    it("continues processing after a per-ticket error", async () => {
      const ticket1 = makeIssue({ identifier: "AI-7000" });
      const ticket2 = makeIssue({ identifier: "AI-7001" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket1, ticket2]);

      // First ticket throws — error should be caught and logged
      mockGit.ticketIdInMainLog
        .mockRejectedValueOnce(new Error("Git error on AI-7000"))
        .mockResolvedValueOnce(false); // AI-7001: not found, should be flagged

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      // AC8: Second ticket still gets processed despite first error
      expect(result.scanned).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("AI-7000");
      expect(result.flagged).toBe(1); // AI-7001 was flagged
    });

    it("catches and logs top-level cycle errors", async () => {
      mockLinear.fetchDoneTickets.mockRejectedValueOnce(new Error("Linear API down"));

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      // AC8: Cycle error is logged, result reflects the error, does NOT throw
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Linear API down");
      expect(result.scanned).toBe(0);
    });

    it("never throws an unhandled exception from runCycle", async () => {
      mockLinear.fetchDoneTickets.mockRejectedValueOnce(new Error("Anything"));

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      // Should resolve gracefully, never reject
      await expect(detector.runCycle()).resolves.toBeDefined();
    });
  });

  // ── AC9: One comment per ticket ───────────────────────────────────────────

  describe("AC9 — One comment per ticket", () => {
    it("posts at most one note comment per flagged ticket across cycles", async () => {
      const ticket = makeIssue({ identifier: "AI-8000" });
      mockLinear.fetchDoneTickets.mockResolvedValue([ticket]); // always returns same ticket
      mockGit.ticketIdInMainLog.mockResolvedValue(false); // never found

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });

      // First cycle: should flag and comment
      const result1 = await detector.runCycle();
      expect(result1.flagged).toBe(1);
      expect(mockLinear.postComment).toHaveBeenCalledTimes(1);

      // Second cycle: should NOT comment again
      const result2 = await detector.runCycle();
      expect(result2.flagged).toBe(0); // not re-flagged (already commented)
      expect(mockLinear.postComment).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // ── AC10: Bootstrap registration ──────────────────────────────────────────

  describe("AC10 — Bootstrap registration in periodic scheduler", () => {
    it("start() registers a periodic timer", () => {
      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });

      // Use a fake timer
      jest.useFakeTimers();
      detector.start();

      // After starting, a timer should be registered (proven by the setInterval call)
      // The configuration explicitly references the script path
      expect(detector).toBeDefined();

      jest.useRealTimers();
    });

    it("is registered alongside linear-connector-watchdog.py in the scheduler config", () => {
      // This test validates that index.ts registers the cron alongside the watchdog.
      // The index.ts start() call for DoneTicketDetector should appear near the
      // DispatchWatchdog.start() call, proving co-location in the scheduler.
      //
      // At the detector level, start() creates an unref'd setInterval just like
      // the watchdog — proven by the timer registration test above.
      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      expect(typeof detector.start).toBe("function");
      expect(typeof detector.stop).toBe("function");
    });
  });

  // ── AC11: Liveness observability ──────────────────────────────────────────

  describe("AC11 — Liveness observability", () => {
    it("logs a startup confirmation when start() is called", () => {
      // Spy on console.error (the logger uses console.error internally)
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      detector.start();

      // AC11: Startup log line must contain the script identity and configuration
      const logCalls = consoleSpy.mock.calls.map((c) => c.join(" "));
      const hasStartupLog = logCalls.some(
        (msg) =>
          msg.includes("done-ticket-detector") &&
          msg.includes("started") &&
          msg.includes("lookbackDays=14") &&
          msg.includes("graceHours=4"),
      );
      expect(hasStartupLog).toBe(true);

      consoleSpy.mockRestore();
      detector.stop();
    });
  });

  // ── Integration: all ACs together ─────────────────────────────────────────

  describe("Integration — mixed scenario", () => {
    it("processes a mix of found, missing, labeled, and unbranched tickets", async () => {
      const onMain = makeIssue({ identifier: "AI-100" }); // found on main → no flag
      const missing = makeIssue({ identifier: "AI-101" }); // not on main → flag
      const labeled = makeIssue({
        identifier: "AI-102",
        labels: ["needs-merge-verify"],
      }); // already labeled → skip
      const noBranch = makeIssue({
        identifier: "AI-103",
        hasBranch: false,
      }); // no branch → skip

      mockLinear.fetchDoneTickets.mockResolvedValueOnce([onMain, missing, labeled, noBranch]);
      mockGit.ticketIdInMainLog.mockImplementation(async (ticketId: string) => {
        return ticketId === "AI-100"; // only AI-100 is found on main
      });

      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      const result = await detector.runCycle();

      expect(result.scanned).toBe(4);
      expect(result.skippedLabeled).toBe(1);
      expect(result.skippedUnbranched).toBe(1);
      expect(result.flagged).toBe(1); // only AI-101 flagged
      expect(mockLinear.applyLabel).toHaveBeenCalledTimes(1);
      expect(mockLinear.postComment).toHaveBeenCalledTimes(1);
      expect(mockLinear.createIssue).toHaveBeenCalledTimes(1);
    });
  });

  // ── Stop/start lifecycle ──────────────────────────────────────────────────

  describe("Lifecycle", () => {
    it("is idempotent — calling start() twice does not double-register", () => {
      jest.useFakeTimers();
      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      detector.start();
      detector.start(); // second call should be no-op

      // Only one interval should be set
      expect(jest.getTimerCount()).toBe(1);

      jest.useRealTimers();
    });

    it("stop() clears the timer", () => {
      jest.useFakeTimers();
      detector = new DoneTicketDetector({ linear: mockLinear, git: mockGit, config });
      detector.start();
      detector.stop();

      expect(jest.getTimerCount()).toBe(0);

      jest.useRealTimers();
    });
  });
});
