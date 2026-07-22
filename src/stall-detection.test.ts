/**
 * INF-314 — Stall detection + auto-recovery (liveness signal, not time-in-state).
 *
 * AC coverage:
 *   AC1 — null-delegate → stalled within one detection cycle
 *   AC2 — no-ack after ACK_TIMEOUT → stalled + auto-redispatch once
 *   AC3 — no-progress after PROGRESS_TIMEOUT → stalled + redispatch once; second stall escalates
 *   AC4 — normal progress (transitions/comments within window) → never flagged
 *   AC5 — stalled tickets queryable via a single call/endpoint with reason included
 *   AC6 — ACK_TIMEOUT and PROGRESS_TIMEOUT are config, not hardcoded
 *   AC7 — regression tests for each of the three stall classes + no-false-positive active-work case
 *
 * Exported API expected from ./stall-detection.js (to be implemented by Igor):
 *   classifyStall(record, config, now?) → StallResult
 *   getStalledTickets(records, config) → StalledTicketInfo[]
 *   StallClassifierConfig  { ackTimeoutMs, progressTimeoutMs }
 *   LivenessRecord         { ticketId, dispatchedAt, ackedAt?, lastProgressAt?, delegate|null, state, redispatched }
 *   StallResult            { stalled, reason?, redispatched?, escalated? }
 *   StalledTicketInfo      { ticketId, reason }
 */

import { describe, it, expect } from "@jest/globals";
import {
  classifyStall,
  getStalledTickets,
  type LivenessRecord,
  type StallClassifierConfig,
  type StallResult,
  type StalledTicketInfo,
} from "./stall-detection.js";

const ACK_TIMEOUT_MS = 3 * 60 * 1000;      // 3 minutes (configurable per AC6)
const PROGRESS_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes (configurable per AC6)
const DEFAULT_CONFIG: StallClassifierConfig = {
  ackTimeoutMs: ACK_TIMEOUT_MS,
  progressTimeoutMs: PROGRESS_TIMEOUT_MS,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<LivenessRecord> & { ticketId: string }): LivenessRecord {
  return {
    dispatchedAt: Date.now() - 120_000,
    ackedAt: Date.now() - 115_000,
    lastProgressAt: Date.now() - 60_000,
    delegate: "igor",
    state: "implementation",
    redispatched: false,
    ...overrides,
  };
}

// ── AC1: Null delegate stall ─────────────────────────────────────────────────

describe("AC1: null-delegate while in a working state", () => {
  it("classifies a ticket with delegate=null as stalled (reason: null-delegate)", () => {
    const record = makeRecord({
      ticketId: "INF-314-AC1-1",
      delegate: null,       // delegate went null — the INF-311 scenario
      state: "implementation",
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("null-delegate");
  });

  it("does NOT stall a ticket whose delegate is set, regardless of other timeouts", () => {
    const record = makeRecord({
      ticketId: "INF-314-AC1-2",
      delegate: "igor",     // delegate present = not orphaned
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    // Time-based checks may still apply (covered by AC2/AC3), but null-delegate
    // is a distinct immediate-reason that takes priority when delegate is null.
    // If the delegate is set, null-delegate MUST NOT fire no matter what.
    expect(result.reason).not.toBe("null-delegate");
  });

  it("immediate — within one detection cycle, not waiting for a timeout", () => {
    const record = makeRecord({
      ticketId: "INF-314-AC1-3",
      delegate: null,
      dispatchedAt: Date.now() - 1_000,   // dispatched only 1s ago
      ackedAt: undefined,
      lastProgressAt: undefined,
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    // Still immediately stalled — null delegate overrides any "too early" guard
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("null-delegate");
  });

  it("does not fail when delegate is null but state is terminal (done/escape — not working)", () => {
    const record = makeRecord({
      ticketId: "INF-314-AC1-4",
      delegate: null,
      state: "done",        // terminal — no longer being "worked"
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    // Terminal states are not subject to stall detection — the ticket is finished
    expect(result.stalled).toBe(false);
  });
});

// ── AC2: No-ack stall ────────────────────────────────────────────────────────

describe("AC2: no ack within ACK_TIMEOUT", () => {
  it("stalls a ticket never acked when ACK_TIMEOUT has elapsed", () => {
    const dispatchedAt = Date.now() - (ACK_TIMEOUT_MS + 10_000); // beyond timeout
    const record = makeRecord({
      ticketId: "INF-314-AC2-1",
      dispatchedAt,
      ackedAt: undefined,    // never acked
      lastProgressAt: undefined,
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-ack");
  });

  it("does NOT stall before ACK_TIMEOUT elapses", () => {
    const dispatchedAt = Date.now() - (ACK_TIMEOUT_MS - 10_000); // still within window
    const record = makeRecord({
      ticketId: "INF-314-AC2-2",
      dispatchedAt,
      ackedAt: undefined,
      lastProgressAt: undefined,
    });

    const result = classifyStall(record, DEFAULT_CONFIG, Date.now());
    expect(result.stalled).toBe(false);
  });

  it("sets redispatched=true on first stall detection for a no-ack ticket", () => {
    const dispatchedAt = Date.now() - (ACK_TIMEOUT_MS + 10_000);
    const record = makeRecord({
      ticketId: "INF-314-AC2-3",
      dispatchedAt,
      ackedAt: undefined,
      redispatched: false,   // first stall
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    expect(result.stalled).toBe(true);
    expect(result.redispatched).toBe(true);
    expect(result.escalated).toBe(false); // first stall = redispatch, not escalate
  });

  it("escalates a second stall after redispatch for a no-ack ticket (does not loop silently)", () => {
    const dispatchedAt = Date.now() - (ACK_TIMEOUT_MS + 10_000);
    const record = makeRecord({
      ticketId: "INF-314-AC2-4",
      dispatchedAt,
      ackedAt: undefined,
      redispatched: true,    // already redispatched once
    });

    const result = classifyStall(record, DEFAULT_CONFIG);
    expect(result.stalled).toBe(true);
    expect(result.redispatched).toBe(false);
    expect(result.escalated).toBe(true); // second stall = escalate
  });
});

// ── AC3: No-progress stall ───────────────────────────────────────────────────

describe("AC3: acked but no progress within PROGRESS_TIMEOUT", () => {
  it("stalls a ticket acked but with no progress after PROGRESS_TIMEOUT", () => {
    const now = Date.now();
    const dispatchedAt = now - (PROGRESS_TIMEOUT_MS + 120_000);
    const ackedAt = now - (PROGRESS_TIMEOUT_MS + 60_000); // acked shortly after dispatch
    // lastProgressAt = ackedAt — no progress since ack

    const record = makeRecord({
      ticketId: "INF-314-AC3-1",
      dispatchedAt,
      ackedAt,
      lastProgressAt: ackedAt, // no progress since ack
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-progress");
  });

  it("does NOT stall before PROGRESS_TIMEOUT elapses", () => {
    const now = Date.now();
    const dispatchedAt = now - 60_000;
    const ackedAt = now - 55_000;
    // last progress = ackedAt, only 55s ago — well within 12m window

    const record = makeRecord({
      ticketId: "INF-314-AC3-2",
      dispatchedAt,
      ackedAt,
      lastProgressAt: ackedAt,
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(false);
  });

  it("redispatches on first no-progress stall", () => {
    const now = Date.now();
    const dispatchedAt = now - (PROGRESS_TIMEOUT_MS + 120_000);
    const ackedAt = now - (PROGRESS_TIMEOUT_MS + 60_000);

    const record = makeRecord({
      ticketId: "INF-314-AC3-3",
      dispatchedAt,
      ackedAt,
      lastProgressAt: ackedAt,
      redispatched: false,
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(true);
    expect(result.redispatched).toBe(true);  // first stall = redispatch
    expect(result.escalated).toBe(false);
  });

  it("escalates a second no-progress stall after redispatch (does not loop)", () => {
    const now = Date.now();
    const dispatchedAt = now - (PROGRESS_TIMEOUT_MS + 120_000);
    const ackedAt = now - (PROGRESS_TIMEOUT_MS + 60_000);

    const record = makeRecord({
      ticketId: "INF-314-AC3-4",
      dispatchedAt,
      ackedAt,
      lastProgressAt: ackedAt,
      redispatched: true,  // already redispatched once
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(true);
    expect(result.redispatched).toBe(false);
    expect(result.escalated).toBe(true); // second stall = escalate, not loop
  });
});

// ── AC4: No false positive on active work ────────────────────────────────────

describe("AC4: active work never flagged", () => {
  it("does NOT stall a ticket with recent progress (comment/transition within PROGRESS_TIMEOUT)", () => {
    const now = Date.now();
    const dispatchedAt = now - 300_000; // 5 min ago
    const ackedAt = now - 295_000;      // acked 5s later
    const lastProgressAt = now - 60_000; // progress 1 min ago — well within 12m window

    const record = makeRecord({
      ticketId: "INF-314-AC4-1",
      dispatchedAt,
      ackedAt,
      lastProgressAt,
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(false);
  });

  it("does NOT stall a ticket with a state transition within PROGRESS_TIMEOUT", () => {
    const now = Date.now();
    // dispatch → ack → state transition (progress) within window
    const record = makeRecord({
      ticketId: "INF-314-AC4-2",
      dispatchedAt: now - 600_000,   // 10 min ago
      ackedAt: now - 595_000,
      lastProgressAt: now - 120_000,  // state transition 2 min ago
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(false);
  });

  it("does NOT stall when ack window has not expired and delegate is present", () => {
    // Fresh dispatch — too early for any stall check to trigger
    const now = Date.now();
    const record = makeRecord({
      ticketId: "INF-314-AC4-3",
      dispatchedAt: now - 30_000,   // 30s ago
      ackedAt: undefined,            // not yet acked
      lastProgressAt: undefined,
      delegate: "igor",
    });

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(false);
  });
});

// ── AC5: Queryable stalled tickets ────────────────────────────────────────────

describe("AC5: stalled tickets queryable via call/endpoint (reason included)", () => {
  it("getStalledTickets returns an array of stalled tickets with their reasons", () => {
    const now = Date.now();
    const records: LivenessRecord[] = [
      // Stalled: null delegate
      makeRecord({
        ticketId: "INF-314-AC5-1",
        delegate: null,
        state: "implementation",
      }),
      // Stalled: no ack (time elapsed)
      {
        ticketId: "INF-314-AC5-2",
        dispatchedAt: now - (ACK_TIMEOUT_MS + 30_000),
        ackedAt: undefined,
        lastProgressAt: undefined,
        delegate: "igor",
        state: "implementation",
        redispatched: false,
      },
      // NOT stalled: active progress
      makeRecord({
        ticketId: "INF-314-AC5-3",
        lastProgressAt: now - 30_000,
      }),
    ];

    const stalled = getStalledTickets(records, { ...DEFAULT_CONFIG, now });
    expect(Array.isArray(stalled)).toBe(true);

    // AC5-1 and AC5-2 should be listed
    expect(stalled.length).toBe(2);

    const ids = stalled.map((s) => s.ticketId);
    expect(ids).toContain("INF-314-AC5-1");
    expect(ids).toContain("INF-314-AC5-2");
    expect(ids).not.toContain("INF-314-AC5-3");

    // Each entry must include the reason
    const reason1 = stalled.find((s) => s.ticketId === "INF-314-AC5-1")!.reason;
    expect(reason1).toBe("null-delegate");

    const reason2 = stalled.find((s) => s.ticketId === "INF-314-AC5-2")!.reason;
    expect(reason2).toBe("no-ack");
  });

  it("returns empty array when no tickets are stalled", () => {
    const now = Date.now();
    const records: LivenessRecord[] = [
      makeRecord({ ticketId: "INF-314-AC5-4", lastProgressAt: now - 30_000 }),
      makeRecord({ ticketId: "INF-314-AC5-5", lastProgressAt: now - 60_000 }),
    ];

    const stalled = getStalledTickets(records, { ...DEFAULT_CONFIG, now });
    expect(stalled).toEqual([]);
  });
});

// ── AC6: Configurable thresholds ─────────────────────────────────────────────

describe("AC6: ACK_TIMEOUT and PROGRESS_TIMEOUT are configurable", () => {
  it("stalling behavior respects a custom ACK_TIMEOUT", () => {
    const now = Date.now();
    const fastAckTimeout = 30_000; // 30s for test speed
    const dispatchedAt = now - 40_000; // 40s ago — beyond 30s window

    const record = makeRecord({
      ticketId: "INF-314-AC6-1",
      dispatchedAt,
      ackedAt: undefined,
      lastProgressAt: undefined,
    });

    const result = classifyStall(record, { ackTimeoutMs: fastAckTimeout, progressTimeoutMs: PROGRESS_TIMEOUT_MS }, now);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-ack");
  });

  it("stalling behavior respects a custom PROGRESS_TIMEOUT", () => {
    const now = Date.now();
    const fastProgressTimeout = 30_000; // 30s
    const dispatchedAt = now - 120_000;
    const ackedAt = now - 115_000;
    const lastProgressAt = ackedAt; // no progress since ack, 115s ago → beyond 30s

    const record = makeRecord({
      ticketId: "INF-314-AC6-2",
      dispatchedAt,
      ackedAt,
      lastProgressAt,
    });

    const result = classifyStall(record, { ackTimeoutMs: ACK_TIMEOUT_MS, progressTimeoutMs: fastProgressTimeout }, now);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-progress");
  });

  it("does not stall when configured timeout is longer than elapsed time", () => {
    const now = Date.now();
    const longAckTimeout = 600_000; // 10 min
    const dispatchedAt = now - 120_000; // only 2 min ago

    const record = makeRecord({
      ticketId: "INF-314-AC6-3",
      dispatchedAt,
      ackedAt: undefined,
    });

    const result = classifyStall(record, { ackTimeoutMs: longAckTimeout, progressTimeoutMs: PROGRESS_TIMEOUT_MS }, now);
    expect(result.stalled).toBe(false);
  });

  it("does not fail when both timeouts are zero (immediate-mode edge case)", () => {
    const now = Date.now();
    const record = makeRecord({
      ticketId: "INF-314-AC6-4",
      dispatchedAt: now - 1,
      ackedAt: undefined,
      lastProgressAt: undefined,
      delegate: "igor", // not null-delegate, triggers no-ack check
    });

    // Zero timeouts = immediate classification
    // With ackTimeoutMs=0 and no ack, this should immediately stall
    const result = classifyStall(record, { ackTimeoutMs: 0, progressTimeoutMs: 0 }, now);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-ack");
  });
});

// ── AC7: Regression tests (every stall class + no false positive) ────────────

describe("AC7: regression — each stall class + no false positive", () => {
  it("regression: null-delegate stall", () => {
    const record = makeRecord({
      ticketId: "INF-314-AC7-NULL",
      delegate: null,
      state: "code-review",
    });
    const result = classifyStall(record, DEFAULT_CONFIG);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("null-delegate");
  });

  it("regression: no-ack stall", () => {
    const now = Date.now();
    const record = makeRecord({
      ticketId: "INF-314-AC7-NOACK",
      dispatchedAt: now - (ACK_TIMEOUT_MS + 5_000),
      ackedAt: undefined,
      lastProgressAt: undefined,
    });
    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-ack");
  });

  it("regression: no-progress stall", () => {
    const now = Date.now();
    const record = makeRecord({
      ticketId: "INF-314-AC7-NOPROG",
      dispatchedAt: now - (PROGRESS_TIMEOUT_MS + 120_000),
      ackedAt: now - (PROGRESS_TIMEOUT_MS + 60_000),
      lastProgressAt: now - (PROGRESS_TIMEOUT_MS + 60_000),
    });
    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(true);
    expect(result.reason).toBe("no-progress");
  });

  it("regression: active work is not a false positive", () => {
    const now = Date.now();
    const record = makeRecord({
      ticketId: "INF-314-AC7-ACTIVE",
      dispatchedAt: now - 600_000,
      ackedAt: now - 595_000,
      lastProgressAt: now - 60_000,  // progress 1m ago
      delegate: "igor",
    });
    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(false);
  });
});
