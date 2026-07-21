/**
 * INF-282 / INF-227: Failing tests for wiring DispatchLeaseStore check into
 * the reconciliation wake path.
 *
 * Acceptance criteria (verbatim):
 *   [ ] reconciliationWakeFn checks DispatchLeaseStore before delivering wake
 *   [ ] Duplicate wake suppressed if unexpired lease exists for (agent, ticket)
 *   [ ] Connector restart doesn't re-wake tickets with active leases
 *   [ ] Existing lease paths unchanged
 *   [ ] Tests: lease-acquired prevent, lease-expired allow, restart scenario
 *
 * These tests MUST be RED until the implementer wires the lease check. They
 * will compile-fail first (missing types) and, once the module compiles, the
 * lease-gate tests will fail because the unmodified reconciliationWakeFn calls
 * deliverMessageToAgent without checking DispatchLeaseStore first.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

import {
  reconciliationWakeFn,
  type ReconciliationWakeOptions,
  type ReconciliationWakeResult,
} from "./reconciliation-wake.js";
import type { DispatchLeaseStore, LeaseEntry } from "../store/dispatch-lease-store.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type SendWakeMock = jest.Mock<(agentId: string, ticketId: string, message: string, config: unknown) => Promise<{ dispatched: boolean }>>;

function mockSendWake(dispatched = true): SendWakeMock {
  return jest.fn<(agentId: string, ticketId: string, message: string, config: unknown) => Promise<{ dispatched: boolean }>>()
    .mockResolvedValue({ dispatched }) as unknown as SendWakeMock;
}

function mockLeaseStore(overrides?: Partial<DispatchLeaseStore>): jest.Mocked<DispatchLeaseStore> {
  return {
    hasActiveLease: jest.fn().mockReturnValue(false),
    acquireLease: jest.fn().mockReturnValue(true),
    releaseLease: jest.fn(),
    getLease: jest.fn().mockReturnValue(null),
    pruneExpired: jest.fn().mockReturnValue(0),
    ...overrides,
  } as unknown as jest.Mocked<DispatchLeaseStore>;
}

function defaultOptions(overrides?: Partial<ReconciliationWakeOptions>): ReconciliationWakeOptions {
  return {
    agentId: "test-agent",
    ticketId: "linear-TEST-42",
    leaseStore: mockLeaseStore(),
    leaseTtlMs: 300_000,
    sendWake: mockSendWake(true),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AC1 — reconciliationWakeFn checks DispatchLeaseStore before delivering wake
// ════════════════════════════════════════════════════════════════════════════

describe("AC1: reconciliationWakeFn checks DispatchLeaseStore before delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls hasActiveLease on the lease store before delivering", async () => {
    const leaseStore = mockLeaseStore();
    const opts = defaultOptions({ leaseStore });

    await reconciliationWakeFn(opts);

    // Must check the lease before any delivery attempt
    expect(leaseStore.hasActiveLease).toHaveBeenCalledWith(
      "test-agent",
      "linear-TEST-42",
    );
  });

  it("does NOT call sendWake when hasActiveLease returns true", async () => {
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest.fn().mockReturnValue(true),
    });
    const opts = defaultOptions({ leaseStore, sendWake });

    const result = await reconciliationWakeFn(opts);

    // Delivery must be suppressed — actual wake function must NOT be called
    expect(sendWake).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(true);
    expect(result.dispatched).toBe(false);
  });

  it("proceeds to deliver when hasActiveLease returns false and lease is acquirable", async () => {
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest.fn().mockReturnValue(false),
      acquireLease: jest.fn().mockReturnValue(true),
    });
    const opts = defaultOptions({ leaseStore, sendWake });

    const result = await reconciliationWakeFn(opts);

    expect(result.suppressed).toBe(false);
    expect(result.dispatched).toBe(true);
    expect(sendWake).toHaveBeenCalledTimes(1);
  });

  it("acquires a lease AFTER checking no active lease exists, BEFORE delivering", async () => {
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest.fn().mockReturnValue(false),
      acquireLease: jest.fn().mockReturnValue(true),
    });
    const opts = defaultOptions({ leaseStore, sendWake, leaseTtlMs: 600_000 });

    await reconciliationWakeFn(opts);

    // Order: check → acquire → deliver
    // Use invocationCallOrder to verify ordering (standard Jest, no plugin needed)
    const checkOrder = leaseStore.hasActiveLease.mock.invocationCallOrder[0];
    const acquireOrder = leaseStore.acquireLease.mock.invocationCallOrder[0];
    const deliverOrder = sendWake.mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(acquireOrder);
    expect(acquireOrder).toBeLessThan(deliverOrder);
    expect(leaseStore.acquireLease).toHaveBeenCalledWith("test-agent", "linear-TEST-42", 600_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Duplicate wake suppressed if unexpired lease exists for (agent, ticket)
// ════════════════════════════════════════════════════════════════════════════

describe("AC2: duplicate wake suppressed for unexpired lease", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("suppresses wake when a lease exists from a delivery within the TTL", async () => {
    // Simulate: lease was acquired 60s ago, TTL is 300s — still active
    const sendWake = mockSendWake(false);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest.fn().mockReturnValue(true),
      getLease: jest.fn().mockReturnValue({
        agentId: "test-agent",
        ticketId: "linear-TEST-42",
        acquiredAt: Date.now() - 60_000,
        ttlMs: 300_000,
      } as LeaseEntry),
    });
    const opts = defaultOptions({ leaseStore, sendWake });

    const result = await reconciliationWakeFn(opts);

    // Must be suppressed — lease still valid
    expect(result.suppressed).toBe(true);
    expect(result.reason).toMatch(/lease|active|duplicate/i);
    // No delivery must have been attempted
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("suppresses a second concurrent invocation for the same (agent, ticket)", async () => {
    // Two simultaneous reconciliation cycles for the same ticket.
    // First call acquires lease; second call sees it and suppresses.
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore();
    // First call: no active lease → acquire succeeds
    // Second call: active lease exists → suppress
    (leaseStore.hasActiveLease as jest.Mock)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    (leaseStore.acquireLease as jest.Mock)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const opts = defaultOptions({ leaseStore, sendWake });

    const [result1, result2] = await Promise.all([
      reconciliationWakeFn(opts),
      reconciliationWakeFn(opts),
    ]);

    // First call: delivered
    expect(result1.suppressed).toBe(false);
    expect(result1.dispatched).toBe(true);
    // Second call: suppressed by lease
    expect(result2.suppressed).toBe(true);
    expect(result2.dispatched).toBe(false);
    // Only one actual delivery should have occurred
    expect(sendWake).toHaveBeenCalledTimes(1);
  });

  it("delivers to a DIFFERENT agent for the same ticket when only the first agent has a lease", async () => {
    // Agent A has a lease for ticket TEST-42, but Agent B (a different
    // delegation) should still go through — leases are per (agent, ticket) pair.
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest
        .fn()
        .mockImplementation((agentId: string, _ticketId: string) => agentId === "agent-a"),
      acquireLease: jest
        .fn()
        .mockImplementation(() => true),
    });

    const resultA = await reconciliationWakeFn(defaultOptions({
      agentId: "agent-a",
      ticketId: "linear-TEST-42",
      leaseStore,
      sendWake,
    }));
    const resultB = await reconciliationWakeFn(defaultOptions({
      agentId: "agent-b",
      ticketId: "linear-TEST-42",
      leaseStore,
      sendWake,
    }));

    // Agent A: suppressed (lease exists)
    expect(resultA.suppressed).toBe(true);
    // Agent B: allowed (no lease for agent-b + TEST-42)
    expect(resultB.suppressed).toBe(false);
    expect(resultB.dispatched).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — Connector restart doesn't re-wake tickets with active leases
// ════════════════════════════════════════════════════════════════════════════

describe("AC3: connector restart respects persisted leases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("survives restart: lease store loaded from SQLite prevents re-wake", async () => {
    // Simulate restart: lease store is rehydrated from SQLite. Tickets
    // that were delivered before the crash still have unexpired leases.
    const sendWake = mockSendWake(false);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest
        .fn()
        .mockImplementation((_agentId: string, ticketId: string) =>
          ticketId === "linear-TEST-42" || ticketId === "linear-TEST-55",
        ),
    });

    const result42 = await reconciliationWakeFn(defaultOptions({
      agentId: "agent-emi",
      ticketId: "linear-TEST-42",
      leaseStore,
      sendWake,
    }));
    const result55 = await reconciliationWakeFn(defaultOptions({
      agentId: "agent-emi",
      ticketId: "linear-TEST-55",
      leaseStore,
      sendWake,
    }));
    const result99 = await reconciliationWakeFn(defaultOptions({
      agentId: "agent-emi",
      ticketId: "linear-TEST-99",
      leaseStore,
      sendWake,
    }));

    // TEST-42 and TEST-55 had leases from before restart → suppressed
    expect(result42.suppressed).toBe(true);
    expect(result55.suppressed).toBe(true);
    // TEST-99 had no lease → not suppressed
    expect(result99.suppressed).toBe(false);
  });

  it("allows re-wake after lease expires — restart scenario", async () => {
    // Simulate: lease was acquired just before crash (e.g. 310s ago) with
    // 300s TTL. By the time the connector restarts, the lease has expired.
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest.fn().mockReturnValue(false), // expired → no active lease
      acquireLease: jest.fn().mockReturnValue(true),
    });

    const result = await reconciliationWakeFn(defaultOptions({
      agentId: "agent-emi",
      ticketId: "linear-TEST-42",
      leaseStore,
      sendWake,
      leaseTtlMs: 300_000,
    }));

    // Lease expired → wake is allowed again
    expect(result.suppressed).toBe(false);
    expect(result.dispatched).toBe(true);
    expect(sendWake).toHaveBeenCalledTimes(1);
    // A new lease should have been acquired
    expect(leaseStore.acquireLease).toHaveBeenCalledWith(
      "agent-emi",
      "linear-TEST-42",
      300_000,
    );
  });

  it("prunes expired leases during reconciliation wake initialization", async () => {
    // When reconciliationWakeFn encounters expired leases, it should
    // call pruneExpired to clean up before checking
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore({
      hasActiveLease: jest.fn().mockReturnValue(false),
      acquireLease: jest.fn().mockReturnValue(true),
    });

    await reconciliationWakeFn(defaultOptions({ leaseStore, sendWake }));

    // On startup reconciliation, prune expired leases to prevent stale
    // lease accumulation in SQLite
    expect(leaseStore.pruneExpired).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — Existing lease paths unchanged
// ════════════════════════════════════════════════════════════════════════════

describe("AC4: existing lease paths unchanged", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("deliverToAgent (webhook path) continues to check leases as before", async () => {
    // This test verifies that the fix doesn't break the existing lease path.
    // The webhook handler's deliverToAgent already provides lease checking.
    // After the fix, reconciliationWakeFn should provide the same check
    // where deliverToAgent was bypassed.

    // The existing lease path (deliverToAgent) is not in scope for this change.
    // This test documents the no-regression expectation.
    const sendWake = mockSendWake(true);
    const leaseStore = mockLeaseStore();
    const opts = defaultOptions({ leaseStore, sendWake });

    // reconciliationWakeFn should internally use the same DispatchLeaseStore
    // interface that deliverToAgent uses. It must not introduce a second lease
    // data source or bypass the existing store.
    const result = await reconciliationWakeFn(opts);

    // Must go through DispatchLeaseStore.hasActiveLease (not a new/different check)
    expect(leaseStore.hasActiveLease).toHaveBeenCalled();
    expect(leaseStore.hasActiveLease).toHaveBeenCalledWith("test-agent", "linear-TEST-42");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — Scenario tests: lease-acquired prevent, lease-expired allow, restart
// ════════════════════════════════════════════════════════════════════════════

describe("AC5: scenario tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("lease-acquired prevent", () => {
    it("prevents delivery when reconciliationWakeFn calls for a ticket with an acquired lease", async () => {
      // Scenario: A ticket was just delivered via deliverToAgent (webhook path)
      // which acquires a lease. The reconciliation sweep runs moments later and
      // tries to wake the same agent for the same ticket. Must be suppressed.
      const sendWake = mockSendWake(true);
      const leaseStore = mockLeaseStore({
        hasActiveLease: jest.fn().mockReturnValue(true), // lease just acquired by deliverToAgent
      });
      const opts = defaultOptions({ leaseStore, sendWake });

      const result = await reconciliationWakeFn(opts);

      expect(result.suppressed).toBe(true);
      expect(result.dispatched).toBe(false);
      expect(sendWake).not.toHaveBeenCalled();
    });

    it("prevents delivery when the ticket is already being processed — same-cycle guard", async () => {
      // Scenario: Two reconciliation paths fire for the same (agent, ticket)
      // within the same microtick. First acquires lease, second sees it.
      const sendWake = mockSendWake(true);
      const leaseStore = mockLeaseStore();
      (leaseStore.hasActiveLease as jest.Mock)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      (leaseStore.acquireLease as jest.Mock)
        .mockReturnValueOnce(true);

      const opts1 = defaultOptions({ leaseStore, sendWake });
      const opts2 = defaultOptions({ leaseStore, sendWake });

      const [r1, r2] = await Promise.all([
        reconciliationWakeFn(opts1),
        reconciliationWakeFn(opts2),
      ]);

      expect(r1.suppressed).toBe(false);
      expect(r1.dispatched).toBe(true);
      expect(r2.suppressed).toBe(true);
      expect(sendWake).toHaveBeenCalledTimes(1);
    });
  });

  describe("lease-expired allow", () => {
    it("allows delivery when the lease expired between reconciliation cycles", async () => {
      // Scenario: Lease acquired 10 minutes ago with 5-minute TTL.
      // A reconciliation cycle fires for the second time — the lease is
      // now expired, so the wake should be allowed again.
      const sendWake = mockSendWake(true);
      const leaseStore = mockLeaseStore({
        hasActiveLease: jest.fn().mockReturnValue(false), // expired
        acquireLease: jest.fn().mockReturnValue(true),
      });

      const result = await reconciliationWakeFn(defaultOptions({
        agentId: "agent-emi",
        ticketId: "linear-TEST-42",
        leaseStore,
        sendWake,
        leaseTtlMs: 300_000,
      }));

      expect(result.suppressed).toBe(false);
      expect(result.dispatched).toBe(true);
    });

    it("allows delivery for a ticket where lease was explicitly released", async () => {
      // Scenario: The agent ended their session and the lease was released.
      // Reconciliation runs later and should be able to re-wake.
      const sendWake = mockSendWake(true);
      const leaseStore = mockLeaseStore({
        hasActiveLease: jest.fn().mockReturnValue(false),
        acquireLease: jest.fn().mockReturnValue(true),
      });

      const result = await reconciliationWakeFn(defaultOptions({
        agentId: "agent-emi",
        ticketId: "linear-TEST-55",
        leaseStore,
        sendWake,
      }));

      expect(result.suppressed).toBe(false);
      expect(result.dispatched).toBe(true);
    });
  });

  describe("restart scenario", () => {
    it("does not re-wake tickets whose leases survived connector restart", async () => {
      // Scenario: Connector restarts. SQLite-backed lease store is read from
      // disk. Tickets with unexpired leases (acquired before restart) must not
      // be re-woken by the reconciliation sweep's startup drain.
      const sendWake = mockSendWake(false);
      const leaseStore = mockLeaseStore({
        hasActiveLease: jest.fn().mockImplementation(
          (_agentId: string, ticketId: string) =>
            ["linear-TEST-10", "linear-TEST-20", "linear-TEST-30"].includes(ticketId),
        ),
        getLease: jest.fn().mockImplementation(
          (_agentId: string, ticketId: string): LeaseEntry | null => {
            if (["linear-TEST-10", "linear-TEST-20", "linear-TEST-30"].includes(ticketId)) {
              return {
                agentId: "agent-emi",
                ticketId,
                acquiredAt: Date.now() - 120_000,
                ttlMs: 300_000,
              };
            }
            return null;
          },
        ),
      });

      const ticketsToWake = [
        "linear-TEST-10", // has unexpired lease → suppress
        "linear-TEST-15", // no lease → allow
        "linear-TEST-20", // has unexpired lease → suppress
        "linear-TEST-25", // no lease → allow
        "linear-TEST-30", // has unexpired lease → suppress
      ];

      const results = await Promise.all(
        ticketsToWake.map((ticketId) =>
          reconciliationWakeFn(defaultOptions({ agentId: "agent-emi", ticketId, leaseStore, sendWake }))
        ),
      );

      // Tickets 10, 20, 30: suppressed
      expect(results[0].suppressed).toBe(true);
      expect(results[2].suppressed).toBe(true);
      expect(results[4].suppressed).toBe(true);
      // Tickets 15, 25: allowed
      expect(results[1].suppressed).toBe(false);
      expect(results[3].suppressed).toBe(false);
    });

    it("re-wakes tickets whose leases expired during the restart gap", async () => {
      // Scenario: Connector was down for 10 minutes. Leases acquired before
      // the crash had 5-minute TTLs. All have expired. Reconciliation startup
      // drain should re-wake them.
      const sendWake = mockSendWake(true);
      const leaseStore = mockLeaseStore({
        hasActiveLease: jest.fn().mockReturnValue(false), // all expired
        acquireLease: jest.fn().mockReturnValue(true),
      });

      const tickets = ["linear-TEST-40", "linear-TEST-41", "linear-TEST-42"];
      const results = await Promise.all(
        tickets.map((ticketId) =>
          reconciliationWakeFn(defaultOptions({ agentId: "agent-emi", ticketId, leaseStore, sendWake }))
        ),
      );

      // All should be delivered — leases expired during downtime
      for (const r of results) {
        expect(r.suppressed).toBe(false);
        expect(r.dispatched).toBe(true);
      }
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Export shape — module contract for reconciliation-wake.ts
// ════════════════════════════════════════════════════════════════════════════

describe("export contract — reconciliation-wake module", () => {
  it("exports reconciliationWakeFn as an async function", () => {
    expect(typeof reconciliationWakeFn).toBe("function");
  });

  it("ReconciliationWakeResult has suppressed and dispatched fields", async () => {
    const result: ReconciliationWakeResult = {
      suppressed: false,
      dispatched: true,
    };
    expect(result).toBeDefined();
    expect(typeof result.suppressed).toBe("boolean");
    expect(typeof result.dispatched).toBe("boolean");
  });

  it("ReconciliationWakeOptions specifies the required fields", () => {
    const opts: ReconciliationWakeOptions = {
      agentId: "test",
      ticketId: "linear-TEST-1",
      leaseStore: mockLeaseStore(),
      leaseTtlMs: 300_000,
      sendWake: mockSendWake(true),
    };
    expect(typeof opts.agentId).toBe("string");
    expect(typeof opts.ticketId).toBe("string");
    expect(typeof opts.leaseTtlMs).toBe("number");
    expect(opts.leaseStore).toBeDefined();
  });
});
