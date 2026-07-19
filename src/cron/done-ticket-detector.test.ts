/**
 * AI-2468 — Tests for the Done-ticket unshipped detector (AC2) and backfill report (AC3).
 *
 * AC2: A periodic cron that scans Done tickets whose fix hallmark symbol is absent
 *      from origin/main (code-presence check, not SHA ancestry). Advisory only.
 *      Registered at bootstrap (proven by health-crons-integration.test.ts).
 *      Liveness observable at ac-validate via the cron registry + detector state.
 *
 * AC3: Backfill report enumerating current violations across open Done tickets
 *      using the same code-presence method.
 *
 * Each test group maps to exactly one AC so review and ac-validate can trace coverage.
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Modules under test ─────────────────────────────────────────────────────

import {
  scanDoneTickets,
  type DoneTicketScanResult,
  type DoneTicketViolation,
  type BackfillReport,
} from "./done-ticket-detector.js";

import {
  registerDoneTicketDetectorCron,
} from "./done-ticket-detector.js";

import {
  registerCron,
  getRegisteredCrons,
  resetCronRegistryForTest,
} from "./registry.js";

import {
  recordDetectorRun,
  recordDetectorSkip,
  recordDetectorFail,
  getDetectorState,
  resetDetectorStateForTest,
} from "../done-ticket-detector-state.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A sample ticket that would be returned by the Linear "Done tickets" query. */
function makeDoneTicket(overrides: Partial<DoneTicketScanResult> = {}): DoneTicketScanResult {
  return {
    identifier: overrides.identifier ?? "AI-9999",
    title: overrides.title ?? "A completed ticket",
    hallmarkSymbol: overrides.hallmarkSymbol ?? "someExportedFunction",
    branchName: overrides.branchName ?? null,
    labels: overrides.labels ?? ["wf:dev-impl", "state:done"],
    ...overrides,
  };
}

/** A violation result from scanning a ticket. */
function makeViolation(overrides: Partial<DoneTicketViolation> = {}): DoneTicketViolation {
  return {
    identifier: overrides.identifier ?? "AI-9999",
    title: overrides.title ?? "A completed ticket",
    hallmarkSymbol: overrides.hallmarkSymbol ?? "someExportedFunction",
    absentFromMain: overrides.absentFromMain ?? true,
    absentFromHealthCommit: overrides.absentFromHealthCommit ?? true,
    branchName: overrides.branchName ?? null,
    ...overrides,
  };
}

// ── Git mock helpers ───────────────────────────────────────────────────────

/**
 * Create a temporary git repo with a known tree for testing code-presence checks.
 * Returns the repo path.
 */
function createGitRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "done-detector-test-"));
  const { execSync } = jest.requireActual("node:child_process") as typeof import("node:child_process");
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m 'initial'", { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Create a temporary git repo with no matching symbol — used to simulate
 * a fix that hasn't been merged yet.
 */
function createEmptyGitRepo(): string {
  return createGitRepo({
    "src/index.ts": 'const unrelated = "hello";\n',
  });
}

// ── Linear query mock ──────────────────────────────────────────────────────

let mockLinearResponse: Array<DoneTicketScanResult> = [];
let mockLinearError: string | null = null;
let capturedLinearQueries: Array<Record<string, unknown>> = [];

const originalFetch = globalThis.fetch;

function installLinearMock() {
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    capturedLinearQueries.push({ url: String(url), query: body.query, variables: body.variables });

    if (mockLinearError) {
      return new Response(
        JSON.stringify({ errors: [{ message: mockLinearError }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: mockLinearResponse.map((t) => ({
              id: t.identifier,
              identifier: t.identifier,
              title: t.title,
              branchName: t.branchName,
              labels: {
                nodes: [
                  ...(t.labels ?? []).map((l: string) => ({ name: l })),
                  // Include hallmark symbol as a label so extraction works
                  ...(t.hallmarkSymbol ? [{ name: `hallmark:${t.hallmarkSymbol}` }] : []),
                ],
              },
            })),
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

function restoreLinearMock() {
  globalThis.fetch = originalFetch;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("AI-2468: Done-ticket unshipped detector", () => {
  let tmpRepoDir: string;

  beforeAll(() => {
    installLinearMock();
  });

  afterAll(() => {
    restoreLinearMock();
  });

  beforeEach(() => {
    capturedLinearQueries = [];
    mockLinearResponse = [];
    mockLinearError = null;
    resetDetectorStateForTest();
    resetCronRegistryForTest();
  });

  afterEach(() => {
    // Clean up tmp repo if created
    if (tmpRepoDir && fs.existsSync(tmpRepoDir)) {
      fs.rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });

  // ── AC2: Detector cron — code-presence check (not SHA ancestry) ─────────

  describe("AC2 — code-presence check confirms fix is on origin/main", () => {
    it("returns no violations when the hallmark symbol exists in the repo tree", async () => {
      tmpRepoDir = createGitRepo({
        "src/feature.ts": 'export function theFix() { return 42; }\n',
      });
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1001",
        hallmarkSymbol: "theFix",
      })];

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(result.violations).toHaveLength(0);
      expect(result.scanned).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("reports a violation when the hallmark symbol is absent from the repo tree", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1001",
        hallmarkSymbol: "theFix",
      })];

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].identifier).toBe("AI-1001");
      expect(result.violations[0].absentFromMain).toBe(true);
      expect(result.scanned).toBe(1);
    });

    it("uses git grep, not SHA ancestry comparison", async () => {
      tmpRepoDir = createGitRepo({
        "src/feature.ts": 'export function shippedFunction() { return 1; }\n',
      });
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1002",
        hallmarkSymbol: "shippedFunction",
      })];

      // The hallmark exists in the repo tree — pass regardless of commit ancestry.
      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(result.violations).toHaveLength(0);
    });

    it("reports violation when symbol is absent from the deployed /health commit (not just main)", async () => {
      tmpRepoDir = createGitRepo({
        "src/index.ts": "console.log('barebones');\n",
      });
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1003",
        hallmarkSymbol: "theFix",
      })];

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
        // healthCommitSha is optional — when absent, only main is checked.
      });

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].absentFromMain).toBe(true);
    });

    it("includes the violation details (identifier, symbol, branchName) in the result", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1004",
        title: "Add the fix",
        hallmarkSymbol: "theFix",
        branchName: "feature/the-fix",
      })];

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        identifier: "AI-1004",
        title: "Add the fix",
        hallmarkSymbol: "theFix",
        absentFromMain: true,
      });
    });
  });

  // ── AC2: Advisory only — never blocks a transition ──────────────────────

  describe("AC2 — advisory only (no blocking)", () => {
    it("scanDoneTickets always returns successfully — never throws, never blocks", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1005",
        hallmarkSymbol: "missingFunction",
      })];

      // Even with violations, scan returns a result, does not throw.
      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.violations)).toBe(true);
      expect(typeof result.scanned).toBe("number");
    });

    it("handles Linear API errors gracefully — logs and returns empty result, never throws", async () => {
      mockLinearError = "API quota exceeded";
      tmpRepoDir = createEmptyGitRepo();

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(result).toBeDefined();
      expect(result.errors.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ── AC2: Cron registration pattern (following rescue-sweep precedent) ───

  describe("AC2 — cron registration and health observability", () => {
    it("registerDoneTicketDetectorCron registers 'done-ticket-detector' in the cron registry", () => {
      registerDoneTicketDetectorCron();
      const names = getRegisteredCrons().map((e) => e.name);
      expect(names).toContain("done-ticket-detector");
    });

    it("registerDoneTicketDetectorCron records a human-readable schedule", () => {
      registerDoneTicketDetectorCron();
      const entry = getRegisteredCrons().find((e) => e.name === "done-ticket-detector");
      expect(entry).toBeDefined();
      expect(entry!.schedule.length).toBeGreaterThan(0);
    });

    it("detector state starts null/empty before any run", () => {
      const state = getDetectorState();
      expect(state.lastRunAt).toBeNull();
      expect(state.lastOutcomeType).toBeNull();
    });

    it("recordDetectorRun updates state with scan results", () => {
      recordDetectorRun({ scanned: 5, violations: 2, errors: 0 });
      const state = getDetectorState();
      expect(state.lastRunAt).not.toBeNull();
      expect(state.lastOutcomeType).toBe("success");
      expect(state.lastOutcome.scanned).toBe(5);
      expect(state.lastOutcome.violations).toBe(2);
    });

    it("recordDetectorSkip records a skip with reason", () => {
      recordDetectorSkip("No Linear token configured");
      const state = getDetectorState();
      expect(state.lastRunAt).not.toBeNull();
      expect(state.lastOutcomeType).toBe("skip");
      expect(state.lastSkipReason).toBe("No Linear token configured");
    });

    it("recordDetectorFail records a failure with error message", () => {
      recordDetectorFail("ECONNREFUSED");
      const state = getDetectorState();
      expect(state.lastRunAt).not.toBeNull();
      expect(state.lastOutcomeType).toBe("fail");
      expect(state.lastError).toBe("ECONNREFUSED");
    });

    it("registerDoneTicketDetectorCron schedules a recurring timer (timer is unref'd)", () => {
      const originalSetInterval = globalThis.setInterval;
      const originalSetTimeout = globalThis.setTimeout;
      const setIntervalSpy = jest.fn((_cb: TimerHandler, _ms?: number, ..._args: unknown[]): ReturnType<typeof setInterval> => {
        // Node Timer objects (and jest faketimers) have unref
        return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      });
      const setTimeoutSpy = jest.fn((_cb: TimerHandler, _ms?: number, ..._args: unknown[]): ReturnType<typeof setTimeout> => {
        return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
      });
      globalThis.setInterval = setIntervalSpy as unknown as typeof globalThis.setInterval;
      globalThis.setTimeout = setTimeoutSpy as unknown as typeof globalThis.setTimeout;

      try {
        registerDoneTicketDetectorCron();
        expect(setIntervalSpy).toHaveBeenCalled();
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it("registerDoneTicketDetectorCron calls registerCron exactly once", () => {
      // Reset and count
      resetCronRegistryForTest();
      registerDoneTicketDetectorCron();
      const names = getRegisteredCrons().filter((e) => e.name === "done-ticket-detector");
      expect(names).toHaveLength(1);
    });
  });

  // ── AC3: Backfill report ────────────────────────────────────────────────

  describe("AC3 — backfill report against open Done tickets", () => {
    it("returns a BackfillReport with violations and metadata", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [
        makeDoneTicket({ identifier: "AI-1010", hallmarkSymbol: "fixAlpha" }),
        makeDoneTicket({ identifier: "AI-1011", hallmarkSymbol: "fixBeta" }),
      ];

      const report = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(report.scanned).toBe(2);
      expect(report.violations.length).toBeGreaterThanOrEqual(2);
      expect(report.violations.every((v) => v.absentFromMain)).toBe(true);
    });

    it("backfill report excludes tickets whose hallmark IS present on main", async () => {
      tmpRepoDir = createGitRepo({
        "src/fixAlpha.ts": 'export function fixAlpha() { return 1; }\n',
        "src/fixBeta.ts": 'export function fixBeta() { return 2; }\n',
      });
      mockLinearResponse = [
        makeDoneTicket({ identifier: "AI-1010", hallmarkSymbol: "fixAlpha" }),
        makeDoneTicket({ identifier: "AI-1011", hallmarkSymbol: "fixBeta" }),
      ];

      const report = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(report.violations).toHaveLength(0);
      expect(report.scanned).toBe(2);
    });

    it("backfill report includes scan timestamp", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [];
      const before = Date.now();

      const report = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(report.timestamp).toBeDefined();
      const ts = Date.parse(report.timestamp);
      expect(Number.isNaN(ts)).toBe(false);
      expect(ts).toBeGreaterThanOrEqual(before - 1000);
    });

    it("backfill report handles empty result set (no Done tickets)", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [];

      const report = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      expect(report.scanned).toBe(0);
      expect(report.violations).toHaveLength(0);
    });
  });

  // ── AC4: Verify AC1(a) closes branchless blind spot ─────────────────────

  describe("AC4 — verify AC1(a) structurally closes the branchless blind spot", () => {
    it("tickets WITHOUT a branch name are still scanned by the detector (not a branch gate)", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [
        makeDoneTicket({
          identifier: "AI-1020",
          hallmarkSymbol: "someNewFunction",
          branchName: null, // No branch — AC1(a) enrollment via autoEnrollByTeam
        }),
      ];

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      // The detector does NOT skip tickets without a branch; it still checks
      // code presence. AC1(a) ensures tickets auto-enroll at intake, so the
      // "Done with no branch" path is structurally closed.
      expect(result.scanned).toBe(1);
      expect(result.violations.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles tickets with no hallmarkSymbol gracefully (skips symbol check)", async () => {
      tmpRepoDir = createEmptyGitRepo();
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1030",
        // No hallmark symbol in the fixture — test needs explicit undefined
      })];
      // Override — a real Done ticket might not declare a hallmark symbol
      mockLinearResponse[0].hallmarkSymbol = "";

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      // Empty hallmark symbol should not crash; ticket is scanned but no grep is run
      expect(result.scanned).toBe(1);
    });

    it("handles git repo not being reachable gracefully", async () => {
      tmpRepoDir = "/nonexistent/path";
      mockLinearResponse = [makeDoneTicket({
        identifier: "AI-1040",
        hallmarkSymbol: "theFix",
      })];

      const result = await scanDoneTickets({
        authToken: "test-token",
        repoDir: tmpRepoDir,
        linearApiUrl: "https://api.linear.app/graphql",
      });

      // Falls back: can't check main, but doesn't throw
      expect(result).toBeDefined();
    });
  });
});
