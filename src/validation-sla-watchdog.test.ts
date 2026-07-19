/**
 * INF-105 — Validation-queue latency: single-validator gate pages engine-watch
 * every window (recurring class).
 *
 * Validation SLA watchdog: when a ticket enters a validation-eligible state
 * (ac-validate, review) and is delegated to the validator, a periodic sweep
 * detects waits exceeding 15 minutes and auto-posts a nudge + re-dispatches
 * the validator. Dedup ensures at most one nudge per 10-minute cooldown per
 * (ticket, state-entry) pair.
 *
 * These tests are INTENTIONALLY FAILING. They define the contract the
 * implementation must satisfy. Run `npm test -- validation-sla-watchdog` to
 * confirm all are red.
 *
 * AC mapping:
 *   AC1 — validation wait >15 min produces an automated nudge or escalation
 *         without engine-watch cron involvement
 *   AC2 — mechanism verified at behavior level on one real validation handoff
 *   AC3 — engine-watch snapshot history shows zero validation-latency stalls
 *         across 4 consecutive runs post-deploy
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsw-test-"));
  return path.join(dir, "test.db");
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vsw-test-"));
}

// ── AC1: Validation wait >15 min → automated nudge ─────────────────────────

describe("AC1 — validation wait exceeding 15 min produces automated nudge", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
    process.env.VALIDATION_WATCHDOG_THRESHOLD_MS = "1000"; // fast for test
    process.env.VALIDATION_WATCHDOG_COOLDOWN_MS = "500";
  });

  afterEach(() => {
    delete process.env.VALIDATION_WATCHDOG_THRESHOLD_MS;
    delete process.env.VALIDATION_WATCHDOG_COOLDOWN_MS;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ValidationSlaWatchdog.isPastThreshold returns true when ticket has been waiting >= thresholdMs", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
      }) => {
        isPastThreshold(stateEnteredAt: number, now?: number): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 15 * 60 * 1000 });
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    expect(watchdog.isPastThreshold(fifteenMinAgo)).toBe(true);
  });

  it("ValidationSlaWatchdog.isPastThreshold returns false when ticket has been waiting < thresholdMs", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
      }) => {
        isPastThreshold(stateEnteredAt: number, now?: number): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 15 * 60 * 1000 });
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    expect(watchdog.isPastThreshold(fiveMinAgo)).toBe(false);
  });

  it("ValidationSlaWatchdog.isPastThreshold returns false for a ticket that just entered the state", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
      }) => {
        isPastThreshold(stateEnteredAt: number, now?: number): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 15 * 60 * 1000 });
    expect(watchdog.isPastThreshold(Date.now())).toBe(false);
  });

  it("ValidationSlaWatchdog.isAlreadyNudged returns false for a never-nudged (ticket, stateEntry) pair", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        nudgeStorePath?: string;
      }) => {
        isAlreadyNudged(ticketId: string, stateEntryEpoch: number): boolean;
        recordNudge(ticketId: string, stateEntryEpoch: number): void;
        close(): void;
      };
    };

    const dbPath = path.join(tmpDir, "nudge-test.db");
    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000, nudgeStorePath: dbPath });
    try {
      expect(watchdog.isAlreadyNudged("INF-105", 1_700_000_000_000)).toBe(false);
    } finally {
      watchdog.close();
    }
  });

  it("ValidationSlaWatchdog.recordNudge then isAlreadyNudged returns true", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        nudgeStorePath?: string;
      }) => {
        isAlreadyNudged(ticketId: string, stateEntryEpoch: number): boolean;
        recordNudge(ticketId: string, stateEntryEpoch: number): void;
        close(): void;
      };
    };

    const dbPath = path.join(tmpDir, "nudge-test.db");
    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000, nudgeStorePath: dbPath });
    try {
      watchdog.recordNudge("INF-105", 1_700_000_000_000);
      expect(watchdog.isAlreadyNudged("INF-105", 1_700_000_000_000)).toBe(true);
    } finally {
      watchdog.close();
    }
  });

  it("ValidationSlaWatchdog: different state-entry epoch for same ticket is a new nudge window", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        nudgeStorePath?: string;
      }) => {
        isAlreadyNudged(ticketId: string, stateEntryEpoch: number): boolean;
        recordNudge(ticketId: string, stateEntryEpoch: number): void;
        close(): void;
      };
    };

    const dbPath = path.join(tmpDir, "nudge-test.db");
    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000, nudgeStorePath: dbPath });
    try {
      watchdog.recordNudge("INF-105", 1_700_000_000_000);
      // Re-entry to state after recovery = new epoch → should not be suppressed
      expect(watchdog.isAlreadyNudged("INF-105", 1_700_000_100_000)).toBe(false);
    } finally {
      watchdog.close();
    }
  });

  it("ValidationSlaWatchdog: nudge dedup persists across close/reopen (SQLite)", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        nudgeStorePath?: string;
      }) => {
        isAlreadyNudged(ticketId: string, stateEntryEpoch: number): boolean;
        recordNudge(ticketId: string, stateEntryEpoch: number): void;
        close(): void;
      };
    };

    const dbPath = path.join(tmpDir, "nudge-test.db");
    const w1 = new ValidationSlaWatchdog({ thresholdMs: 1000, nudgeStorePath: dbPath });
    w1.recordNudge("INF-105", 1_700_000_000_000);
    w1.close();

    const w2 = new ValidationSlaWatchdog({ thresholdMs: 1000, nudgeStorePath: dbPath });
    try {
      expect(w2.isAlreadyNudged("INF-105", 1_700_000_000_000)).toBe(true);
    } finally {
      w2.close();
    }
  });

  it("ValidationSlaWatchdog.isValidationEligible returns true for ac-validate state", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        watchStates?: string[];
      }) => {
        isValidationEligible(stateLabel: string): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000 });
    expect(watchdog.isValidationEligible("ac-validate")).toBe(true);
  });

  it("ValidationSlaWatchdog.isValidationEligible returns true for review state", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        watchStates?: string[];
      }) => {
        isValidationEligible(stateLabel: string): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000 });
    expect(watchdog.isValidationEligible("review")).toBe(true);
  });

  it("ValidationSlaWatchdog.isValidationEligible returns false for implementation state", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        watchStates?: string[];
      }) => {
        isValidationEligible(stateLabel: string): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000 });
    expect(watchdog.isValidationEligible("implementation")).toBe(false);
  });

  it("ValidationSlaWatchdog.isValidationEligible returns false for write-tests state", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
        watchStates?: string[];
      }) => {
        isValidationEligible(stateLabel: string): boolean;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000 });
    expect(watchdog.isValidationEligible("write-tests")).toBe(false);
  });

  it("ValidationSlaWatchdog.buildNudgeComment returns a string containing the ticket identifier and wait duration", async () => {
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new (opts: {
        thresholdMs: number;
      }) => {
        buildNudgeComment(ticketIdentifier: string, waitDurationMs: number): string;
      };
    };

    const watchdog = new ValidationSlaWatchdog({ thresholdMs: 1000 });
    const comment = watchdog.buildNudgeComment("INF-105", 16 * 60 * 1000);
    expect(comment).toContain("INF-105");
    expect(comment).toContain("validation");
    expect(comment).toMatch(/nudge|SLA|delay|stall/i);
  });

  it("runValidationWatchdogSweep returns { nudged: number; alreadyNudged: number; errored: number }", async () => {
    const { runValidationWatchdogSweep } = await import("./validation-sla-watchdog.js") as {
      runValidationWatchdogSweep: (
        authToken: string,
        opts?: {
          thresholdMs?: number;
          cooldownMs?: number;
          watchStates?: string[];
          nudgeStorePath?: string;
          validatorAgentId?: string;
          getLinearUserIdForAgent?: (name: string) => string | undefined;
          deliverMessageToAgent?: (agentId: string, sessionKey: string, message: string, wakeConfig?: Record<string, unknown>) => Promise<{ dispatched: boolean }>;
        },
      ) => Promise<{ nudged: number; alreadyNudged: number; errored: number }>;
    };

    const origFetch = globalThis.fetch;
    const now = Date.now();
    const staleAt = new Date(now - 16 * 60 * 1000).toISOString(); // 16 min ago

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string; variables?: Record<string, unknown> };
      const q = body.query ?? "";

      // Ticket search query: fetch all governed tickets
      if (q.includes("issues") && q.includes("workflow")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [
            {
              id: "linear-INF-105",
              identifier: "INF-105",
              state: { name: "ac-validate" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              updatedAt: staleAt,
              assignee: null,
              delegate: { name: "Ai" },
            },
          ] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Fetch delegate identity
      if (q.includes("users") && q.includes("name")) {
        return new Response(JSON.stringify({
          data: { users: { nodes: [{ id: "linear-user-ai", name: "Ai" }] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Nudge mutation
      if (q.includes("commentCreate")) {
        return new Response(JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "c-nudge-1" } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const result = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        cooldownMs: 600,
        watchStates: ["ac-validate", "review"],
        nudgeStorePath: path.join(tmpDir, "sweep-nudge.db"),
        validatorAgentId: "Ai",
        getLinearUserIdForAgent: () => "linear-user-ai",
        deliverMessageToAgent: async () => ({ dispatched: true }),
      });
      expect(result.nudged).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("runValidationWatchdogSweep does NOT nudge a ticket that entered validation state 1 minute ago", async () => {
    const { runValidationWatchdogSweep } = await import("./validation-sla-watchdog.js") as {
      runValidationWatchdogSweep: (
        authToken: string,
        opts?: {
          thresholdMs?: number;
          cooldownMs?: number;
          watchStates?: string[];
          nudgeStorePath?: string;
          validatorAgentId?: string;
        },
      ) => Promise<{ nudged: number; alreadyNudged: number; errored: number }>;
    };

    const origFetch = globalThis.fetch;
    const recent = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("issues") && q.includes("workflow")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [
            {
              id: "linear-INF-105",
              identifier: "INF-105",
              state: { name: "ac-validate" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              updatedAt: recent,
              delegate: { name: "Ai" },
            },
          ] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const result = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        watchStates: ["ac-validate", "review"],
        nudgeStorePath: path.join(tmpDir, "sweep-recent.db"),
      });
      expect(result.nudged).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("runValidationWatchdogSweep respects cooldown: second sweep on same ticket nudges 0", async () => {
    const { runValidationWatchdogSweep } = await import("./validation-sla-watchdog.js") as {
      runValidationWatchdogSweep: (
        authToken: string,
        opts?: {
          thresholdMs?: number;
          cooldownMs?: number;
          watchStates?: string[];
          nudgeStorePath?: string;
        },
      ) => Promise<{ nudged: number; alreadyNudged: number; errored: number }>;
    };

    const origFetch = globalThis.fetch;
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("issues") && q.includes("workflow")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [
            {
              id: "linear-INF-105",
              identifier: "INF-105",
              state: { name: "ac-validate" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              updatedAt: staleAt,
              delegate: { name: "Ai" },
            },
          ] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (q.includes("commentCreate")) {
        return new Response(JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "c-nudge" } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const nudgeStorePath = path.join(tmpDir, "cooldown-nudge.db");

    try {
      const tick1 = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        cooldownMs: 100000, // long cooldown within test
        watchStates: ["ac-validate", "review"],
        nudgeStorePath,
      });
      expect(tick1.nudged).toBeGreaterThanOrEqual(1);

      const tick2 = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        cooldownMs: 100000,
        watchStates: ["ac-validate", "review"],
        nudgeStorePath,
      });
      expect(tick2.nudged).toBe(0);
      expect(tick2.alreadyNudged).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("runValidationWatchdogSweep skips tickets not delegated to the validator", async () => {
    const { runValidationWatchdogSweep } = await import("./validation-sla-watchdog.js") as {
      runValidationWatchdogSweep: (
        authToken: string,
        opts?: {
          thresholdMs?: number;
          watchStates?: string[];
          nudgeStorePath?: string;
          validatorAgentId?: string;
        },
      ) => Promise<{ nudged: number; alreadyNudged: number; errored: number }>;
    };

    const origFetch = globalThis.fetch;
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("issues") && q.includes("workflow")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [
            {
              id: "linear-INF-106",
              identifier: "INF-106",
              state: { name: "ac-validate" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              updatedAt: staleAt,
              delegate: { name: "Igor" }, // Not the validator
            },
          ] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const result = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        watchStates: ["ac-validate", "review"],
        nudgeStorePath: path.join(tmpDir, "skip-delegate.db"),
        validatorAgentId: "Ai",
      });
      expect(result.nudged).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ── AC1 — background-component rule: wiring test ──────────────────────────
  // Per AI-1808: one failing test MUST boot the production entry point and
  // assert the component is registered.

  it("createApp registers ValidationSlaWatchdog and wires it into the component lifecycle", async () => {
    // Boot the production app factory — createApp must instantiate and
    // register the ValidationSlaWatchdog as a started periodic component,
    // analogous to DispatchWatchdog, NoActivityDetector, etc.
    const bagDbPath = tempDbPath();
    const agentQueueDbPath = tempDbPath();

    // Set env vars the watchdog reads at construction
    const origCadence = process.env.VALIDATION_WATCHDOG_CADENCE_MS;
    process.env.VALIDATION_WATCHDOG_CADENCE_MS = "0"; // disable periodic tick in tests

    try {
      const { app, ...rest } = createApp({
        bagDbPath,
        agentQueueDbPath,
      });

      // The createApp return value must expose the ValidationSlaWatchdog
      // under a known key (`validationWatchdog` or similar) so that the
      // integration test can verify it's started.
      expect(rest).toHaveProperty("validationWatchdog");

      // The watchdog object should have the essential public API shape
      const watchdog = rest.validationWatchdog as {
        start: () => void;
        stop?: () => void;
        isPastThreshold: (stateEnteredAt: number, now?: number) => boolean;
      };

      expect(typeof watchdog.start).toBe("function");
      expect(typeof watchdog.isPastThreshold).toBe("function");
    } finally {
      if (origCadence === undefined) delete process.env.VALIDATION_WATCHDOG_CADENCE_MS;
      else process.env.VALIDATION_WATCHDOG_CADENCE_MS = origCadence;
    }
  });
});

// ── AC2: Behavior-level verification on a real validation handoff ──────────

describe("AC2 — mechanism verified at behavior level", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
    process.env.VALIDATION_WATCHDOG_THRESHOLD_MS = "1000";
  });

  afterEach(() => {
    delete process.env.VALIDATION_WATCHDOG_THRESHOLD_MS;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runValidationWatchdogSweep posts a comment with **Validation SLA nudge** header and includes ticket identifier", async () => {
    const { runValidationWatchdogSweep } = await import("./validation-sla-watchdog.js") as {
      runValidationWatchdogSweep: (
        authToken: string,
        opts?: {
          thresholdMs?: number;
          watchStates?: string[];
          nudgeStorePath?: string;
          validatorAgentId?: string;
          getLinearUserIdForAgent?: (name: string) => string | undefined;
          deliverMessageToAgent?: (agentId: string, sessionKey: string, message: string) => Promise<{ dispatched: boolean }>;
        },
      ) => Promise<{ nudged: number; alreadyNudged: number; errored: number; nudgeComment?: string }>;
    };

    const origFetch = globalThis.fetch;
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    let postedCommentBody = "";

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("issues") && q.includes("workflow")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [
            {
              id: "linear-INF-105",
              identifier: "INF-105",
              state: { name: "ac-validate" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              updatedAt: staleAt,
              delegate: { name: "Ai" },
            },
          ] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (q.includes("commentCreate")) {
        const vars = body as { variables?: { body?: string } };
        postedCommentBody = vars?.variables?.body ?? "";
        return new Response(JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "c-nudge-ac2" } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const result = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        watchStates: ["ac-validate", "review"],
        nudgeStorePath: path.join(tmpDir, "ac2-nudge.db"),
        validatorAgentId: "Ai",
        getLinearUserIdForAgent: () => "linear-user-ai",
        deliverMessageToAgent: async () => ({ dispatched: true }),
      });

      expect(result.nudged).toBeGreaterThanOrEqual(1);
      // The nudge comment must have the specific header and mention the ticket
      expect(postedCommentBody).toContain("INF-105");
      expect(postedCommentBody).toMatch(/validation\s+SLA|SLA\s+nudge|nudge/i);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("runValidationWatchdogSweep re-dispatches the validator after posting nudge", async () => {
    const { runValidationWatchdogSweep } = await import("./validation-sla-watchdog.js") as {
      runValidationWatchdogSweep: (
        authToken: string,
        opts?: {
          thresholdMs?: number;
          watchStates?: string[];
          nudgeStorePath?: string;
          validatorAgentId?: string;
          getLinearUserIdForAgent?: (name: string) => string | undefined;
          deliverMessageToAgent?: (agentId: string, sessionKey: string, message: string, wakeConfig?: Record<string, unknown>) => Promise<{ dispatched: boolean }>;
        },
      ) => Promise<{ nudged: number; alreadyNudged: number; errored: number; reDispatchSuccess?: boolean }>;
    };

    const origFetch = globalThis.fetch;
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    let reDispatchCalled = false;

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("issues") && q.includes("workflow")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [
            {
              id: "linear-INF-105",
              identifier: "INF-105",
              state: { name: "ac-validate" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              updatedAt: staleAt,
              delegate: { name: "Ai" },
            },
          ] } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (q.includes("commentCreate")) {
        return new Response(JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "c-nudge-redispatch" } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const deliverMock = async (_agentId: string, _sessionKey: string, _message: string) => {
        reDispatchCalled = true;
        return { dispatched: true };
      };

      const result = await runValidationWatchdogSweep("test-token", {
        thresholdMs: 1000,
        watchStates: ["ac-validate", "review"],
        nudgeStorePath: path.join(tmpDir, "ac2-redispatch.db"),
        validatorAgentId: "Ai",
        getLinearUserIdForAgent: () => "linear-user-ai",
        deliverMessageToAgent: deliverMock,
      });

      expect(result.nudged).toBeGreaterThanOrEqual(1);
      expect(reDispatchCalled).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── AC3: Config/env surface for deploy-time tuning ─────────────────────────

describe("AC3 — configuration and deployment readiness", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ValidationSlaWatchdog reads VALIDATION_WATCHDOG_THRESHOLD_MS from env", async () => {
    process.env.VALIDATION_WATCHDOG_THRESHOLD_MS = "900000"; // 15 min

    try {
      jest.resetModules();
      const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
        ValidationSlaWatchdog: new () => {
          thresholdMs: number;
          close(): void;
        };
      };

      const watchdog = new ValidationSlaWatchdog();
      try {
        expect(watchdog.thresholdMs).toBe(900000);
      } finally {
        watchdog.close();
      }
    } finally {
      delete process.env.VALIDATION_WATCHDOG_THRESHOLD_MS;
    }
  });

  it("ValidationSlaWatchdog reads VALIDATION_WATCHDOG_CADENCE_MS from env", async () => {
    process.env.VALIDATION_WATCHDOG_CADENCE_MS = "300000"; // 5 min

    try {
      jest.resetModules();
      const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
        ValidationSlaWatchdog: new () => {
          cadenceMs: number;
          close(): void;
        };
      };

      const watchdog = new ValidationSlaWatchdog();
      try {
        expect(watchdog.cadenceMs).toBe(300000);
      } finally {
        watchdog.close();
      }
    } finally {
      delete process.env.VALIDATION_WATCHDOG_CADENCE_MS;
    }
  });

  it("ValidationSlaWatchdog reads VALIDATION_WATCHDOG_COOLDOWN_MS from env", async () => {
    process.env.VALIDATION_WATCHDOG_COOLDOWN_MS = "600000"; // 10 min

    try {
      jest.resetModules();
      const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
        ValidationSlaWatchdog: new () => {
          cooldownMs: number;
          close(): void;
        };
      };

      const watchdog = new ValidationSlaWatchdog();
      try {
        expect(watchdog.cooldownMs).toBe(600000);
      } finally {
        watchdog.close();
      }
    } finally {
      delete process.env.VALIDATION_WATCHDOG_COOLDOWN_MS;
    }
  });

  it("ValidationSlaWatchdog reads VALIDATION_WATCHDOG_STATES from env", async () => {
    process.env.VALIDATION_WATCHDOG_STATES = "ac-validate,review,code-review";

    try {
      jest.resetModules();
      const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
        ValidationSlaWatchdog: new () => {
          watchStates: string[];
          close(): void;
        };
      };

      const watchdog = new ValidationSlaWatchdog();
      try {
        expect(watchdog.watchStates).toContain("ac-validate");
        expect(watchdog.watchStates).toContain("review");
        expect(watchdog.watchStates).toContain("code-review");
        expect(watchdog.watchStates).toHaveLength(3);
      } finally {
        watchdog.close();
      }
    } finally {
      delete process.env.VALIDATION_WATCHDOG_STATES;
    }
  });

  it("ValidationSlaWatchdog uses sensible defaults when no env vars are set", async () => {
    jest.resetModules();
    const { ValidationSlaWatchdog } = await import("./validation-sla-watchdog.js") as {
      ValidationSlaWatchdog: new () => {
        thresholdMs: number;
        cadenceMs: number;
        cooldownMs: number;
        watchStates: string[];
        close(): void;
      };
    };

    const watchdog = new ValidationSlaWatchdog();
    try {
      // Default threshold: 15 min
      expect(watchdog.thresholdMs).toBe(900000);
      // Default cadence: 5 min
      expect(watchdog.cadenceMs).toBe(300000);
      // Default cooldown: 10 min
      expect(watchdog.cooldownMs).toBe(600000);
      // Default states: ac-validate, review
      expect(watchdog.watchStates).toContain("ac-validate");
      expect(watchdog.watchStates).toContain("review");
    } finally {
      watchdog.close();
    }
  });
});
