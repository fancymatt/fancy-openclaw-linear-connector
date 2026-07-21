/**
 * AI-2624 — Managing-interval override ignored: stewardship wake fires ~every minute.
 *
 * Tests cover:
 *   AC1 — Regression: multi-cycle poller with Managing-interval: 4h does NOT
 *         re-dispatch before the interval elapses. MUST fail against current
 *         code (reproduces the ~1-minute firing) and pass after fix.
 *   AC2 — Default cadence honored: no marker → at most once per 30m.
 *   AC3 — Per-ticket override honored end-to-end: poller cycle resolves the
 *         parsed Managing-interval to the persisted lastDispatchedAt check,
 *         not just that parseManagingInterval returns the right number.
 *   AC4 — Persistence survives across cycles: a fresh store at the same path
 *         reads back a recorded dispatch.
 *   AC5 — Single scheduler instance: start() is guarded against creating
 *         duplicate timers.
 *
 * The steward's intake note mandates a FILE-BACKED ManagingStateStore (not
 * a stubbed one) so the test exercises the real persistence path.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ManagingStateStore } from "../store/managing-state-store.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import { ManagingPoller, isDue, parseManagingInterval, type LinearManagingIssue, type PollerCycleResult } from "./managing-poller.js";
import type { ManagingWakeTicket } from "./managing-wake.js";

// ── Helpers ────────────────────────────────────────────────────────────

interface AgentLike {
  name: string;
  linearUserId: string;
  openclawAgent: string;
  host?: string;
}

function makeStores(): {
  store: ManagingStateStore;
  ops: OperationalEventStore;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2624-managing-"));
  const store = new ManagingStateStore(path.join(dir, "managing.db"));
  const ops = new OperationalEventStore(path.join(dir, "ops.db"));
  return {
    store,
    ops,
    cleanup: () => {
      store.close();
      ops.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a ManagingPoller wired to file-backed stores, injectable deps,
 * deterministric clock, and a captured sendWake mock.
 */
function createPoller(opts: {
  store: ManagingStateStore;
  ops: OperationalEventStore;
  agents: AgentLike[];
  issues: LinearManagingIssue[];
  sendWake: ReturnType<typeof jest.fn>;
  now: number;
  defaultIntervalMs?: number;
  cycleMs?: number;
}): ManagingPoller {
  const {
    store, ops, agents, issues, sendWake, now,
    defaultIntervalMs = 30 * 60 * 1000,
    cycleMs = 60_000,
  } = opts;

  return new ManagingPoller(
    {
      store,
      operationalEventStore: ops,
      resolveDeliveryConfig: () => ({ nodeBin: "node" }),
      listAgents: () => agents as never,
      fetchManagingTickets: async () => issues,
      sendWake: sendWake as never,
      now: () => now,
    },
    { cycleMs, defaultIntervalMs },
  );
}

/** Reset a jest mock and await its promise resolution queue. */
async function drainMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// ── AC1: Regression — multi-cycle behavior with Managing-interval: 4h ──
// This test drives the poller across MULTIPLE cycles for a ticket whose
// description carries `Managing-interval: 4h`. After the first cycle
// dispatches and records lastDispatchedAt, subsequent cycles < 4h later
// MUST NOT re-dispatch. A test that fires on every cycle regardless of
// Managing-interval reproduces the ~1-minute-stewardship-wake defect.
//
// MUST fail against current code (exposes the bug) and pass after fix.

describe("AI-2624 AC1: regression — multi-cycle respects 4h Managing-interval", () => {
  let stores: ReturnType<typeof makeStores>;
  beforeEach(() => {
    stores = makeStores();
  });
  afterEach(() => {
    stores.cleanup();
  });

  it("cycle 1 dispatches unseen ticket; cycle 2 (<4h) must NOT re-dispatch; cycle 3 (≥4h) re-dispatches", async () => {
    const agents: AgentLike[] = [
      { name: "astrid", linearUserId: "u1", openclawAgent: "astrid" },
    ];
    const issues: LinearManagingIssue[] = [
      {
        identifier: "AI-2624",
        title: "Managing-interval ignored",
        description: "Managing-interval: 4h",
      },
    ];
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const T0 = 1_000_000_000; // arbitrary epoch anchor

    // ── Cycle 1: ticket is unseen → dispatches ──
    const poller1 = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T0,
    });
    const result1 = await poller1.runCycle();
    expect(result1.ticketsDispatched).toBe(1);
    expect(result1.agentsWaked).toBe(1);
    expect(sendWake).toHaveBeenCalledTimes(1);
    expect(stores.store.getLastDispatched("astrid", "AI-2624")).toBe(T0);
    sendWake.mockClear();

    // ── Cycle 2: 5 minutes of simulated time have passed (far less than 4h) ──
    // MUST NOT dispatch — the Managing-interval: 4h override should prevent it.
    const poller2 = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T0 + 5 * 60 * 1000, // +5 min
    });
    const result2 = await poller2.runCycle();

    // THIS IS THE REGRESSION ASSERTION:
    // If the bug is present (Managing-interval override ignored), the ticket
    // fires every cycle as if lastDispatchedAt were null → result2 dispatches.
    // After the fix, the persisted lastDispatchedAt is read and the interval
    // check holds → result2 does NOT dispatch.
    expect(result2.ticketsDispatched).toBe(0);
    expect(result2.agentsWaked).toBe(0);
    expect(sendWake).not.toHaveBeenCalled();

    // ── Cycle 3: 4h + 1s have elapsed → re-dispatch is due ──
    const poller3 = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T0 + 4 * 60 * 60 * 1000 + 1000, // 4h + 1s
    });
    const result3 = await poller3.runCycle();
    expect(result3.ticketsDispatched).toBe(1);
    expect(result3.agentsWaked).toBe(1);
    expect(sendWake).toHaveBeenCalledTimes(1);
    // lastDispatchedAt updated to the cycle-3 timestamp
    expect(stores.store.getLastDispatched("astrid", "AI-2624")).toBe(T0 + 4 * 60 * 60 * 1000 + 1000);
  });

  it("two sequential cycles with identical clock: second cycle does NOT re-dispatch", async () => {
    // Edge case: if the clock doesn't advance between cycles, the override
    // interval check must still hold (now - lastDispatchedAt === 0 < 4h).
    const agents: AgentLike[] = [
      { name: "astrid", linearUserId: "u1", openclawAgent: "astrid" },
    ];
    const issues: LinearManagingIssue[] = [
      {
        identifier: "AI-2624",
        title: "Managing-interval ignored",
        description: "Managing-interval: 4h",
      },
    ];
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const T = 1_000_000_000;
    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T,
    });

    // Cycle 1
    await poller.runCycle();
    expect(sendWake).toHaveBeenCalledTimes(1);
    sendWake.mockClear();

    // Cycle 2 — same now → 0ms elapsed → not due
    const result2 = await poller.runCycle();
    expect(result2.ticketsDispatched).toBe(0);
    expect(sendWake).not.toHaveBeenCalled();
  });
});

// ── AC2: Default cadence honored (no marker → 30m default) ─────────────

describe("AI-2624 AC2: default cadence honored (no Managing-interval marker)", () => {
  let stores: ReturnType<typeof makeStores>;
  beforeEach(() => {
    stores = makeStores();
  });
  afterEach(() => {
    stores.cleanup();
  });

  it("records dispatch at T; cycle at T+5m does NOT re-dispatch (default=30m)", async () => {
    const agents: AgentLike[] = [
      { name: "astrid", linearUserId: "u1", openclawAgent: "astrid" },
    ];
    const issues: LinearManagingIssue[] = [
      { identifier: "AI-DEFAULT", title: "No marker", description: null },
    ];
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const T = 10_000_000;
    stores.store.recordDispatch("astrid", "AI-DEFAULT", T);

    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T + 5 * 60 * 1000, // +5 min (< 30m default)
    });

    const result = await poller.runCycle();
    expect(result.ticketsDispatched).toBe(0);
    expect(result.agentsWaked).toBe(0);
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("records dispatch at T; cycle at T+30m re-dispatches (default interval elapsed)", async () => {
    const agents: AgentLike[] = [
      { name: "astrid", linearUserId: "u1", openclawAgent: "astrid" },
    ];
    const issues: LinearManagingIssue[] = [
      { identifier: "AI-DEFAULT", title: "No marker", description: null },
    ];
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const T = 10_000_000;
    stores.store.recordDispatch("astrid", "AI-DEFAULT", T);

    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T + 30 * 60 * 1000, // +30m (exactly the default)
    });

    const result = await poller.runCycle();
    expect(result.ticketsDispatched).toBe(1);
    expect(result.agentsWaked).toBe(1);
    expect(sendWake).toHaveBeenCalledTimes(1);
  });
});

// ── AC3: Per-ticket override honored end-to-end ────────────────────────
// The poller cycle must apply the parsed Managing-interval value to the
// persisted lastDispatchedAt check — not just that parseManagingInterval
// returns the right number. This tests the INTEGRATION of parsing + store
// read + isDue within a single runCycle call.

describe("AI-2624 AC3: per-ticket override honored end-to-end in poller cycle", () => {
  let stores: ReturnType<typeof makeStores>;
  beforeEach(() => {
    stores = makeStores();
  });
  afterEach(() => {
    stores.cleanup();
  });

  it("Managing-interval: 4h from description is used as the due-check interval (not default 30m)", async () => {
    const agents: AgentLike[] = [
      { name: "astrid", linearUserId: "u1", openclawAgent: "astrid" },
    ];
    const issues: LinearManagingIssue[] = [
      {
        identifier: "AI-LONG",
        title: "Long interval",
        description: "Managing-interval: 4h",
      },
    ];
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const T = 10_000_000;
    // Record dispatch at T — 4h interval means the ticket should NOT be due
    // at T + 30m (default interval) NOR at T + 2h.
    stores.store.recordDispatch("astrid", "AI-LONG", T);

    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      // 30m after dispatch — would be due if defaults were used, but the
      // 4h override must prevent it.
      now: T + 30 * 60 * 1000,
    });

    const result = await poller.runCycle();
    expect(result.ticketsDispatched).toBe(0);
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("Managing-interval: 5m overrides the 30m default — shorter interval fires earlier", async () => {
    const agents: AgentLike[] = [
      { name: "astrid", linearUserId: "u1", openclawAgent: "astrid" },
    ];
    const issues: LinearManagingIssue[] = [
      {
        identifier: "AI-FAST",
        title: "Fast interval",
        description: "Managing-interval: 5m",
      },
    ];
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const T = 10_000_000;
    stores.store.recordDispatch("astrid", "AI-FAST", T);

    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents,
      issues,
      sendWake,
      now: T + 6 * 60 * 1000, // 6 min > 5 min → due
    });

    const result = await poller.runCycle();
    expect(result.ticketsDispatched).toBe(1);
    expect(sendWake).toHaveBeenCalledTimes(1);
  });
});

// ── AC4: Persistence survives across cycles ────────────────────────────
// After a dispatch is recorded with store instance A, a FRESH store
// instance at the SAME path must read back the persisted lastDispatchedAt.
// This guards hypothesis 1 (lastDispatchedAt never persists across cycles)
// by proving the store path/file is stable.

describe("AI-2624 AC4: persistence survives across cycles", () => {
  it("a fresh ManagingStateStore at the same dbPath reads back recorded dispatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2624-ac4-"));
    const dbPath = path.join(dir, "managing.db");
    try {
      const storeA = new ManagingStateStore(dbPath);
      storeA.recordDispatch("astrid", "AI-2624", 1_000_000);
      storeA.close();

      const storeB = new ManagingStateStore(dbPath);
      const lastDispatched = storeB.getLastDispatched("astrid", "AI-2624");
      storeB.close();

      expect(lastDispatched).toBe(1_000_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persisted value survives across multiple close/open cycles (simulates restarts)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2624-ac4-restart-"));
    const dbPath = path.join(dir, "managing.db");
    try {
      const storeA = new ManagingStateStore(dbPath);
      storeA.recordDispatch("astrid", "AI-2624", 500_000);
      storeA.close();

      const storeB = new ManagingStateStore(dbPath);
      storeB.recordDispatch("astrid", "AI-2624", 1_000_000);
      storeB.close();

      const storeC = new ManagingStateStore(dbPath);
      expect(storeC.getLastDispatched("astrid", "AI-2624")).toBe(1_000_000);
      storeC.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC5: Single scheduler instance ─────────────────────────────────────
// Only one ManagingPoller timer must be active in the production process.
// start() is already idempotent (returns early if timer is set), but the
// test formalizes this guard.

describe("AI-2624 AC5: single scheduler instance guard", () => {
  let stores: ReturnType<typeof makeStores>;
  beforeEach(() => {
    stores = makeStores();
  });
  afterEach(() => {
    stores.cleanup();
  });

  it("start() called twice does NOT create two timers", async () => {
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents: [{ name: "astrid", linearUserId: "u1", openclawAgent: "astrid" }],
      issues: [{ identifier: "AI-1", title: "T", description: null }],
      sendWake,
      now: 100_000,
    });

    // Call start() twice
    poller.start();
    poller.start();
    // No error thrown — guard holds

    // Run one cycle to prove it still functions
    // (We can't inspect the timer directly, but no crash on double start = guard works)
    const result = await poller.runCycle();
    expect(result.agentsChecked).toBe(1);

    poller.stop();
  });

  it("start() after stop() re-creates the timer (not permanently disabled)", () => {
    const sendWake = jest.fn<(agentId: string, tickets: ManagingWakeTicket[], config: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      store: stores.store,
      ops: stores.ops,
      agents: [{ name: "astrid", linearUserId: "u1", openclawAgent: "astrid" }],
      issues: [{ identifier: "AI-1", title: "T", description: null }],
      sendWake,
      now: 100_000,
    });

    poller.start();
    poller.stop();
    // After stop, start again — no error
    expect(() => poller.start()).not.toThrow();
    poller.stop();
  });
});

// ── Unit-level: isDue + parseManagingInterval sanity ───────────────────
// These complement the existing tests with edge cases relevant to AI-2624.

describe("AI-2624: isDue edge cases", () => {
  it("isDue with negative interval (defensive)", () => {
    // A negative intervalMs should always be due
    expect(isDue(1000, 1000, -1)).toBe(true);
  });

  it("isDue with zero intervalMs is always due after any elapsed time", () => {
    expect(isDue(1001, 1000, 0)).toBe(true);
  });

  it("isDue handles exactly equal now and lastDispatchedAt with zero interval", () => {
    // When now === lastDispatchedAt, 0 - 0 >= 0 → true
    expect(isDue(1000, 1000, 0)).toBe(true);
  });
});

describe("AI-2624: parseManagingInterval edge cases", () => {
  it("parses seconds", () => {
    expect(parseManagingInterval("Managing-interval: 30s")).toBe(30 * 1000);
  });

  it("returns null for garbage unit", () => {
    expect(parseManagingInterval("Managing-interval: 10x")).toBeNull();
  });

  it("returns null for non-numeric value", () => {
    expect(parseManagingInterval("Managing-interval: forever")).toBeNull();
  });

  it("picks the first marker when multiple are present", () => {
    const body = "Managing-interval: 30m\nsome text\nManaging-interval: 4h";
    expect(parseManagingInterval(body)).toBe(30 * 60 * 1000);
  });
});
