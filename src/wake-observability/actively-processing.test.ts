/**
 * INF-84 AC5 — `actively-processing` eliminates false-alarm stalls.
 *
 * AC5: The `actively-processing` code eliminates at least one class of current
 * false-alarm "stalls" (agent was working, just slowly).
 *
 * Current false-alarm class: an agent that has started work (first action
 * recorded after delegation) but is proceeding slowly — today's watchdog and
 * sweeps see "no terminal action → stalled" and escalate unnecessarily.
 *
 * With reason-code awareness, `ACTIVELY_PROCESSING` prevents escalation:
 * the watchdog skips the ticket entirely when the resolver says the agent is
 * working.
 *
 * These tests import from modules that DO NOT exist yet. They will fail on first
 * run — expected TDD red state.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";

import { StallReasonCode, resolveStallReason, type StallReason, type StallResolverDeps } from "./index.js";

import {
  WatchdogTicket,
  runFirstActionWatchdogSweep,
  type FirstActionWatchdogOptions,
} from "../first-action-watchdog.js";

import {
  resetFirstActionWatchdogStateForTest,
} from "../first-action-watchdog-state.js";

describe("INF-84 AC5: actively-processing eliminates false-alarm stalls", () => {
  beforeEach(() => {
    resetFirstActionWatchdogStateForTest();
  });

  // ── AC5: the resolver returns ACTIVELY_PROCESSING when agent has acted ──
  it("AC5.1 — resolver returns ACTIVELY_PROCESSING for a ticket where first action occurred after delegation", async () => {
    const deps: Partial<StallResolverDeps> = {
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 30 * 60_000 }),
      getActiveSessionKeys: () => ["linear-lif-53"],
      getFirstActionAt: async (_ticketId: string) => Date.now() - 60_000, // acted 1 min ago
      getResolvedModel: async (_agentId: string) => ({
        modelName: "ollama/gemma4:31b",
        isFallback: true,
        tokensPerSecond: 2,
        configuredDefault: "claude-sonnet-4-6",
      }),
    };

    const reason = await resolveStallReason(
      "LIF-53", "ai",
      { delegatedAtMs: Date.now() - 10 * 60_000 },
      deps as StallResolverDeps,
    );

    // Agent IS working, even if slowly — should report actively-processing
    expect(reason).not.toBeNull();
    expect(reason!.reason).toBe(StallReasonCode.ACTIVELY_PROCESSING);
  });

  // ── AC5: watchdog skips tickets with ACTIVELY_PROCESSING reason ──
  it("AC5.2 — watchdog sweep does NOT escalate a ticket that has ACTIVELY_PROCESSING reason", async () => {
    // This demonstrates the false-alarm elimination: a ticket the resolver
    // classifies as ACTIVELY_PROCESSING is skipped by the watchdog even when
    // it would otherwise breach — agent is working, just slowly.
    let redispatched = false;
    let escalated = false;

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
          firstOwnerActionAtMs: Date.now() - 60_000, // acted — just working slowly
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.ACTIVELY_PROCESSING,
            detail: "agent ai is working on LIF-53 on ollama/gemma4:31b at 2 tok/s",
            resolvedAt: Date.now(),
          },
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => { redispatched = true; },
      escalateUnreachable: async () => { escalated = true; },
      notify: () => {},
    };

    const result = await runFirstActionWatchdogSweep(opts);

    // With ACTIVELY_PROCESSING, even a breached ticket is NOT escalated —
    // the reason code tells us the agent is working, just slowly.
    // The ticket IS breached (dispatch 1hr ago, deadline 45min), but the
    // reason-code-aware skip prevents escalation.
    expect(result.breached).toBe(1); // breach detected
    expect(redispatched).toBe(false); // but no redispatch fired
    expect(escalated).toBe(false); // and no unreachable escalation
    expect(result.redispatched).toBe(0);
    expect(result.unreachable).toBe(0);
  });

  // ── AC5: same ticket WITHOUT actively-processing, first action within
  //     deadline → normal deadline check prevents breach (positive control) ──
  it("AC5.3 — same ticket, first action within deadline, no stallReason — normal deadline check prevents breach", async () => {
    // Control: dispatch is recent enough that firstOwnerActionAtMs falls
    // within the deadline. No ACTIVELY_PROCESSING reason means the normal
    // first-action check applies — agent acted in time, no breach.
    // Proves AC5.2's pass isn't a false negative (the deadline itself is
    // what prevents escalation when it should).
    let redispatched = false;

    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "LIF-53",
          workflow: "lifeos",
          state: "implementation",
          delegate: "ai",
          humanAssigned: false,
          labels: [],
          // Dispatch 30 min ago + 45-min deadline → deadline is 15 min from now.
          // Action 1 min ago is within the deadline → actedInTime → no breach.
          dispatchDeliveredAtMs: Date.now() - 30 * 60_000,
          dispatchUpdatedAt: "2026-07-18T21:00:00.000Z",
          firstOwnerActionAtMs: Date.now() - 60_000, // acted within deadline
          rungsFired: 0,
          // NO stallReason — old watchdog behavior
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => { redispatched = true; },
      escalateUnreachable: async () => {},
      notify: () => {},
    };

    const result = await runFirstActionWatchdogSweep(opts);

    // Normal deadline check: agent acted in time → no breach.
    expect(redispatched).toBe(false);
    expect(result.breached).toBe(0);
  });

  // ── AC5: real scenario — agent on slow model takes 5+ minutes to respond ──
  it("AC5.4 — an agent that started work but is on a 2 tok/s model is not escalated", async () => {
    // This is the concrete false-alarm class Matt identified: an agent that
    // falls through to a slow local model. It ACKed the ticket and started
    // working, but the first real action (state transition / comment) may take
    // 5+ minutes. Today that looks like a stall. With AC5, it doesn't.
    const noEscalation: string[] = [];

    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "INF-84",
          workflow: "dev-impl",
          state: "implementation",
          delegate: "ai",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: Date.now() - 10 * 60_000,
          dispatchUpdatedAt: "2026-07-18T21:00:00.000Z",
          firstOwnerActionAtMs: null, // hasn't had time to act yet
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.ACTIVELY_PROCESSING,
            detail: "agent ai session is live, model is ollama/gemma4:31b at 2 tok/s — first action expected within 5-10 min",
            resolvedAt: Date.now(),
          },
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => { noEscalation.push("redispatch"); },
      escalateUnreachable: async () => { noEscalation.push("unreachable"); },
      notify: () => {},
    };

    const result = await runFirstActionWatchdogSweep(opts);
    expect(noEscalation).toEqual([]);
    expect(result.breached).toBe(0);
  });

  // ── AC5: the opposite — a MODEL_DEGRADED ticket WITHOUT actively-processing session ──
  it("AC5.5 — an agent on slow model with NO active session IS escalated as model-degraded, not actively-processing", async () => {
    const deps: Partial<StallResolverDeps> = {
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 30 * 60_000 }),
      getActiveSessionKeys: () => [], // NO active session!
      getResolvedModel: async (_agentId: string) => ({
        modelName: "ollama/gemma4:31b",
        isFallback: true,
        tokensPerSecond: 2,
        configuredDefault: "claude-sonnet-4-6",
      }),
    };

    const reason = await resolveStallReason(
      "LIF-55", "ai",
      { delegatedAtMs: Date.now() - 10 * 60_000 },
      deps as StallResolverDeps,
    );

    // No session → not actively-processing → model-degraded
    expect(reason).not.toBeNull();
    expect(reason!.reason).toBe(StallReasonCode.MODEL_DEGRADED);
  });
});
