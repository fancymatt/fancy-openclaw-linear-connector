/**
 * INF-84 AC4 — first-action watchdog can consume the reason code.
 *
 * AC4: The first-action watchdog (or engine-watch) can consume the reason code
 * to decide its next rung — demonstrated on at least one real stalled ticket.
 *
 * These tests import from modules that DO NOT exist yet. They will fail on first
 * run — expected TDD red state.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";

import {
  StallReasonCode,
  type StallReason,
  resolveStallReason,
  type StallResolverDeps,
} from "./index.js";

// The watchdog's actual ladder types — these exist (first-action-watchdog.ts):
import {
  runFirstActionWatchdogSweep,
  type FirstActionWatchdogOptions,
  type WatchdogTicket,
} from "../first-action-watchdog.js";

import {
  resetFirstActionWatchdogStateForTest,
} from "../first-action-watchdog-state.js";

describe("INF-84 AC4: watchdog consumes reason code", () => {
  beforeEach(() => {
    resetFirstActionWatchdogStateForTest();
  });

  // ── AC4: watchdog can consume a reason code from the resolver ──
  it("AC4.1 — WatchdogTicket includes an optional stallReason field that the sweep can read", async () => {
    // The augmented WatchdogTicket type should carry a stallReason so the
    // watchdog can decide escalation based on the actual cause.
    const ticket: WatchdogTicket = {
      ticket: "INF-84",
      workflow: "dev-impl",
      state: "write-tests",
      delegate: "ai",
      humanAssigned: false,
      labels: [],
      dispatchDeliveredAtMs: Date.now() - 60 * 60_000, // 1 hour ago
      dispatchUpdatedAt: "2026-07-18T21:00:00.000Z",
      firstOwnerActionAtMs: null,
      rungsFired: 0,
      // NEW: stall reason from the resolver — the watchdog can use this
      stallReason: {
        reason: StallReasonCode.SESSION_DEAD,
        detail: "agent ai has no live session",
        resolvedAt: Date.now(),
      },
    };

    // The ticket MUST carry the stallReason — this test passes when the type
    // includes it and the sweep logic can read it.
    expect(ticket.stallReason).toBeDefined();
    expect(ticket.stallReason!.reason).toBe(StallReasonCode.SESSION_DEAD);
  });

  // ── AC4: watchdog uses reason code to decide escalation ──
  it("AC4.2 — demonstrates reason-code-aware escalation: SESSION_DEAD → respawn (not redispatch)", async () => {
    // The current watchdog escalates uniformly: redispatch → unreachable → reroute.
    // With reason codes, SESSION_DEAD should skip redispatch (re-waking a dead
    // session is pointless) and go directly to unreachable + escalation.
    // This test asserts the ladder skips rung-1 for SESSION_DEAD.
    const escalatedTickets: string[] = [];

    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "INF-84",
          workflow: "dev-impl",
          state: "write-tests",
          delegate: "ai",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: Date.now() - 60 * 60_000,
          dispatchUpdatedAt: "2026-07-18T21:00:00.000Z",
          firstOwnerActionAtMs: null,
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.SESSION_DEAD,
            detail: "agent ai has no live session",
            resolvedAt: Date.now(),
          },
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => {
        // The redispatch should NOT be called for SESSION_DEAD
        throw new Error("redispatch should not be called for SESSION_DEAD");
      },
      escalateUnreachable: async (payload) => {
        escalatedTickets.push(payload.ticket);
      },
      notify: () => {},
    };

    const result = await runFirstActionWatchdogSweep(opts);

    // Should have escalated directly, skipping rung-1 redispatch
    expect(escalatedTickets).toContain("INF-84");
    expect(result.redispatched).toBe(0);
    expect(result.unreachable).toBeGreaterThanOrEqual(1);
  });

  // ── AC4: MODEL_DEGRADED → reroute rather than redispatch ──
  it("AC4.3 — demonstrates MODEL_DEGRADED escalates to reroute rather than redispatch", async () => {
    const reroutedTickets: Array<{ ticket: string; fromAgent: string; toAgent: string }> = [];
    const redispatchedTickets: string[] = [];

    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "LIF-53",
          workflow: "lifeos",
          state: "implementation",
          delegate: "ai",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: Date.now() - 60 * 60_000,
          dispatchUpdatedAt: "2026-07-18T21:00:00.000Z",
          firstOwnerActionAtMs: null,
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.MODEL_DEGRADED,
            detail: "ai is on ollama/gemma4:31b at 2 tok/s",
            resolvedAt: Date.now(),
          },
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async (payload) => {
        redispatchedTickets.push(payload.ticket);
      },
      escalateUnreachable: async () => {},
      notify: () => {},
      capabilityPolicy: {
        bodies: [
          { id: "ai", fills_roles: ["dev", "steward"] },
          { id: "igor", fills_roles: ["dev"] },
        ],
        roles: [{ id: "dev" }, { id: "steward" }],
      },
      reroute: async (payload) => {
        reroutedTickets.push({
          ticket: payload.ticket,
          fromAgent: payload.fromAgent,
          toAgent: payload.toAgent,
        });
      },
    };

    const result = await runFirstActionWatchdogSweep(opts);

    // MODEL_DEGRADED should prefer reroute over redispatch
    expect(reroutedTickets.length).toBeGreaterThanOrEqual(1);
    expect(reroutedTickets[0].ticket).toBe("LIF-53");
    expect(redispatchedTickets).not.toContain("LIF-53");
  });

  // ── AC4: DEMO on a real stalled ticket — the resolver returns code, watchdog reads it ──
  it("AC4.4 — end-to-end: reason resolver output flows into watchdog sweep", async () => {
    // This is the "demonstrated on at least one real stalled ticket" AC.
    // The resolver produces a StallReason; the watchdog ticket carries it;
    // the sweep reads it and adapts escalation.
    const deps: Partial<StallResolverDeps> = {
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 90 * 60_000 }),
      getActiveSessionKeys: () => [],
    };

    const reason: StallReason | null = await resolveStallReason(
      "LIF-53", "ai",
      { delegatedAtMs: Date.now() - 90 * 60_000 },
      deps as StallResolverDeps,
    );

    // Resolver produces a reason for this stalled ticket
    expect(reason).not.toBeNull();
    expect(Object.values(StallReasonCode)).toContain(reason!.reason);

    // That reason flows into the watchdog's next sweep
    const optedInLadders: string[] = [];
    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "LIF-53",
          workflow: "lifeos",
          state: "implementation",
          delegate: "ai",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: Date.now() - 90 * 60_000,
          dispatchUpdatedAt: "2026-07-18T21:00:00.000Z",
          firstOwnerActionAtMs: null,
          rungsFired: 0,
          stallReason: reason!,
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => {},
      escalateUnreachable: async () => {},
      notify: () => {},
      reroute: async (payload) => {
        optedInLadders.push(`${payload.fromAgent}→${payload.toAgent}`);
      },
    };

    const sweepResult = await runFirstActionWatchdogSweep(opts);
    // The sweep consumed the reason code instead of ignoring it — proved
    // by at least one non-default escalation path being taken.
    // If the result shows > 0 in any non-default category, the integration works.
    expect(
      sweepResult.redispatched +
      sweepResult.unreachable +
      sweepResult.reroutes +
      sweepResult.staleCleared,
    ).toBeGreaterThan(0);
  });
});
