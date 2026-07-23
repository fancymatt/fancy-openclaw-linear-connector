/**
 * INF-84 AC1 — reason-code resolver: stalled-ticket query returns a machine-
 * readable enum entry, not a prose guess.
 *
 * AC1: For a delegated ticket with no pickup in >2 min, a single query (CLI or
 * endpoint) returns a reason code from the defined enum — not a prose guess.
 *
 * These tests import from modules that DO NOT exist yet. They will fail with
 * MODULE_NOT_FOUND on first run — the expected TDD red state. The implementer
 * creates the corresponding source modules to make them compile and pass.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// ── Planned module paths (do not exist yet — these imports fail first run) ───
import {
  StallReasonCode,
  type StallReason,
  resolveStallReason,
  type StallResolverDeps,
} from "./index.js";

import {
  SessionTracker,
} from "../bag/session-tracker.js";

describe("INF-84 AC1: reason-code resolver", () => {
  /** Factory helpers for the injectable deps. */
  function makeDeps(overrides?: Partial<StallResolverDeps>): StallResolverDeps {
    const sessionTracker = new SessionTracker(50_000);
    return {
      sessionTracker,
      getActiveSessionKeys: (agentId: string) => sessionTracker.getActiveSessionKeys(agentId),
      isTicketActiveForAnyAgent: (sessionKey: string, exceptAgentId?: string) =>
        sessionTracker.isTicketActiveForAnyAgent(sessionKey, exceptAgentId),
      now: () => Date.now(),
      ...overrides,
    };
  }

  // ── AC1 base case: returns a typed StallReasonCode, not a string guess ──
  it("AC1.1 — returns a StallReasonCode enum value, not a free-form string", async () => {
    const deps = makeDeps();
    const result: StallReason = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 }, // 3 min ago
      deps,
    );
    // Must be one of the defined enum values — never a prose string.
    const validCodes: string[] = Object.values(StallReasonCode);
    expect(validCodes).toContain(result.reason);
    // Must NOT be a plain string that isn't in the enum.
    expect(Object.keys(StallReasonCode)).not.toContain(result.reason);
  });

  // ── AC1: wake-not-delivered — dispatch wake never reached a live session ──
  it("AC1.2 — returns wake-not-delivered when no delivery ack recorded", async () => {
    const deps = makeDeps({
      getWakeDeliveryOutcome: async (ticketId: string) => null, // never delivered
    });
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result.reason).toBe(StallReasonCode.WAKE_NOT_DELIVERED);
  });

  // ── AC1: session-dead — agent has no live session to wake into ──
  it("AC1.3 — returns session-dead when agent has no active session and wake was delivered", async () => {
    const deps = makeDeps({
      getActiveSessionKeys: () => [], // no live session
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 60_000 }),
    });
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result.reason).toBe(StallReasonCode.SESSION_DEAD);
  });

  // ── AC1: queue-starved — agent is awake, draining other tickets ──
  it("AC1.4 — returns queue-starved when agent has active sessions and this ticket is behind others", async () => {
    const deps = makeDeps({
      getActiveSessionKeys: () => ["linear-fcy-388", "linear-ill-148"], // busy on other tickets
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 60_000 }),
      getQueueDepth: async (agentId: string) => 3, // 3 tickets ahead
      getTicketDrainOrder: async (ticketId: string, agentId: string) => 2, // second in line
    });
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result.reason).toBe(StallReasonCode.QUEUE_STARVED);
    expect(result.detail).toContain("3");
  });

  // ── AC1: model-degraded — agent on slow local fallback ──
  it("AC1.5 — returns model-degraded when agent resolved model is a slow local fallback", async () => {
    const deps = makeDeps({
      getActiveSessionKeys: () => ["linear-inf-84"], // has a session for THIS ticket too
      getResolvedModel: async (agentId: string) => ({
        modelName: "ollama/gemma4:31b",
        isFallback: true,
        tokensPerSecond: 2,
        configuredDefault: "claude-sonnet-4-6",
      }),
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 60_000 }),
    });
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result.reason).toBe(StallReasonCode.MODEL_DEGRADED);
    expect(result.detail).toMatch(/2\s*tok|\d+tps/i);
  });

  // ── AC1: actively-processing — agent has picked up the ticket and is working ──
  it("AC1.6 — returns actively-processing when first action occurred after delegation", async () => {
    const deps = makeDeps({
      getActiveSessionKeys: () => ["linear-inf-84"],
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 60_000 }),
      getFirstActionAt: async (ticketId: string) => Date.now() - 30_000, // acted 30s ago
    });
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result.reason).toBe(StallReasonCode.ACTIVELY_PROCESSING);
    expect(result.detail).toMatch(/30\s*s/i);
  });

  // ── AC1: capability-blocked — agent tried but hit a gate ──
  it("AC1.7 — returns capability-blocked when agent hit a capability or auth gate", async () => {
    const deps = makeDeps({
      getActiveSessionKeys: () => ["linear-inf-84"],
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 60_000 }),
      getCapabilityBlock: async (agentId: string, ticketId: string) => ({
        blocked: true,
        reason: "missing credential: LINEAR_OAUTH_TOKEN expired",
      }),
    });
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result.reason).toBe(StallReasonCode.CAPABILITY_BLOCKED);
    expect(result.detail).toMatch(/expired/i);
  });

  // ── AC1: query is single-shot, not a multi-step log spelunk ──
  it("AC1.8 — resolveStallReason is a single async call, not a multi-step procedure", async () => {
    const deps = makeDeps();
    // The call itself proves it's a single function — if the interface required
    // three separate calls to assemble a prose guess, that would violate the AC.
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 3 * 60_000 },
      deps,
    );
    expect(result).toHaveProperty("reason");
    expect(result).toHaveProperty("detail");
    expect(typeof result.reason).toBe("string");
  });

  // ── AC1: stall younger than 2 min returns null/no-stall (not yet actionable) ──
  it("AC1.9 — returns null for a ticket delegated less than 2 min ago", async () => {
    const deps = makeDeps();
    const result = await resolveStallReason(
      "inf-84",
      "ai",
      { delegatedAtMs: Date.now() - 60_000 }, // only 1 min ago
      deps,
    );
    // Not a stall yet — not enough time has passed.
    expect(result).toBeNull();
  });
});
