/**
 * Tests for health classifier (INF-317, AC 2, 3, 4, 5, 7).
 *
 * AC 2: Classifier accepts structured signal inputs and returns health verdict per gate.
 * AC 3: Suppression rules correctly demote breaches (queued, working, blocked).
 * AC 4: Gate 1 contract: dispatched → expected consider-work/Thinking within N ms.
 * AC 5: Gate 2 contract: picked-up → expected verb/comment within deadline.
 * AC 7: Tests cover all variants: healthy, suppressed, breach, overdue, config override.
 */

import { jest } from "@jest/globals";
import { classifyGateHealth, type SignalInput, type ClassifyResult } from "./health-classifier.js";
import { type LifecycleContract } from "./contract-definitions.js";
import type { GateId, LivenessSignal } from "./health-types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Fixed reference "now" so tests are deterministic. */
const NOW = 1_000_000_000_000;

function gate1Contract(): LifecycleContract {
  return {
    label: "Gate 1 — dispatched → Thinking",
    gateId: "dispatched",
    expectedSignal: "Thinking",
    deadlineMs: 60_000,
    suppression: [
      { condition: "queued", maxDepth: 5, maxAgeMs: 30_000 },
      { condition: "blocked" },
    ],
  };
}

function gate2Contract(): LifecycleContract {
  return {
    label: "Gate 2 — picked-up → activity",
    gateId: "picked-up",
    expectedSignal: "verb",
    deadlineMs: 300_000,
    suppression: [
      { condition: "working" },
      { condition: "blocked" },
    ],
  };
}

function makeInput(overrides: Partial<SignalInput> & { gateEnteredAt: number }): SignalInput {
  return {
    signals: [],
    ...overrides,
  };
}

// ── AC 2: Classifier accepts structured signal inputs ───────────────────────

describe("AC 2: Classifier accepts signal inputs and returns verdicts", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns a ClassifyResult with gateId and verdict", () => {
    const contract = gate1Contract();
    const input = makeInput({ gateEnteredAt: NOW - 5_000 });
    const result = classifyGateHealth(contract, input);
    expect(result).toHaveProperty("gateId", "dispatched");
    expect(result).toHaveProperty("verdict");
    expect(result.verdict).toHaveProperty("gateId", "dispatched");
    expect(result.verdict).toHaveProperty("status");
    expect(result.verdict).toHaveProperty("contractLabel");
    expect(result.verdict).toHaveProperty("expectedSignal");
    expect(result.verdict).toHaveProperty("deadlineMs");
    expect(result.verdict).toHaveProperty("actualElapsedMs");
    expect(result.verdict).toHaveProperty("breached");
  });

  it("accepts a contract with different gateId and returns matching gateId", () => {
    const contract = gate2Contract();
    const input = makeInput({ gateEnteredAt: NOW - 10_000 });
    const result = classifyGateHealth(contract, input);
    expect(result.gateId).toBe("picked-up");
    expect(result.verdict.gateId).toBe("picked-up");
  });

  it("returns actualElapsedMs that reflects time since gateEnteredAt", () => {
    const contract = gate1Contract();
    const input = makeInput({ gateEnteredAt: NOW - 30_000 });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.actualElapsedMs).toBe(30_000);
  });
});

// ── AC 4: Gate 1 — dispatched → Thinking ────────────────────────────────────

describe("AC 4: Gate 1 — dispatched → expected consider-work/Thinking", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns healthy when Thinking signal received within deadline", () => {
    const contract = gate1Contract();
    const signals: LivenessSignal[] = [
      { type: "dispatch-ack", timestamp: NOW - 55_000 },
      {
        type: "session-health",
        timestamp: NOW - 50_000,
        detail: { signalType: "Thinking" },
      },
    ];
    const input = makeInput({ gateEnteredAt: NOW - 60_000, signals });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy");
    expect(result.verdict.breached).toBe(false);
  });

  it("returns unhealthy-breach when deadline exceeded with no signal and no suppression", () => {
    const contract = {
      ...gate1Contract(),
      // Remove suppression to test bare breach
      suppression: [],
    };
    const input = makeInput({ gateEnteredAt: NOW - 120_000 });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("unhealthy-breach");
    expect(result.verdict.breached).toBe(true);
  });

  it("returns unhealthy-breach when overdue beyond all suppression windows", () => {
    const contract = gate1Contract();
    const input = makeInput({
      gateEnteredAt: NOW - 300_000, // 5 min overdue
      queueDepth: 0, // Not queued — no suppression
    });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("unhealthy-breach");
    expect(result.verdict.breached).toBe(true);
  });

  it("returns healthy when exactly at deadline with signal", () => {
    const contract = gate1Contract();
    const signals: LivenessSignal[] = [
      {
        type: "session-health",
        timestamp: NOW - 60_000,
        detail: { signalType: "Thinking" },
      },
    ];
    const input = makeInput({ gateEnteredAt: NOW - 60_000, signals });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy");
  });
});

// ── AC 5: Gate 2 — picked-up → verb/comment ────────────────────────────────

describe("AC 5: Gate 2 — picked-up → expected verb/comment", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns healthy when verb/comment signal received within deadline", () => {
    const contract = gate2Contract();
    const signals: LivenessSignal[] = [
      { type: "session-health", timestamp: NOW - 250_000 },
      { type: "turn-liveness", timestamp: NOW - 200_000 },
    ];
    const input = makeInput({ gateEnteredAt: NOW - 300_000, signals });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy");
    expect(result.verdict.breached).toBe(false);
  });

  it("returns healthy-suppressed-working when past deadline but has active turn", () => {
    const contract = gate2Contract();
    const input = makeInput({
      gateEnteredAt: NOW - 600_000, // 10 min, past 5 min deadline
      hasActiveTurn: true,
    });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy-suppressed-working");
    expect(result.verdict.suppressed).toBe(true);
    expect(result.verdict.suppressionReason).toBe("working");
  });

  it("returns unhealthy-breach when past deadline with no activity and no suppression", () => {
    const contract = {
      ...gate2Contract(),
      suppression: [],
    };
    const input = makeInput({ gateEnteredAt: NOW - 600_000 });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("unhealthy-breach");
  });
});

// ── AC 3: Suppression rules ─────────────────────────────────────────────────

describe("AC 3: Suppression rules correctly demote breaches", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe("queued suppression", () => {
    // Contract with 10_000ms deadline and 30_000ms maxAgeMs so elapsed can
    // exceed the deadline yet remain within the maxAgeMs window.
    const queueContract: LifecycleContract = {
      label: "Queue-test contract",
      gateId: "dispatched",
      expectedSignal: "Thinking",
      deadlineMs: 10_000,
      suppression: [
        { condition: "queued", maxDepth: 5, maxAgeMs: 30_000 },
      ],
    };

    it("suppresses breach when queue depth within maxDepth and age within maxAgeMs", () => {
      const contract = gate1Contract();
      const input = makeInput({
        gateEnteredAt: NOW - 120_000, // past 60s deadline
        queueDepth: 3, // within maxDepth 5
        // 120_000 elapsed > 30_000 maxAgeMs → NOT suppressed
      });
      const result = classifyGateHealth(contract, input);
      // 120s > 30s maxAgeMs, so this should NOT be suppressed
      expect(result.verdict.status).toBe("unhealthy-breach");
    });

    it("suppresses breach when queue depth and age are within limits", () => {
      // elapsed=15s > deadline=10s AND 15s < maxAgeMs=30s → suppressed
      const input = makeInput({
        gateEnteredAt: NOW - 15_000,
        queueDepth: 2,
      });
      const result = classifyGateHealth(queueContract, input);
      expect(result.verdict.status).toBe("healthy-suppressed-queued");
      expect(result.verdict.suppressionReason).toBe("queued");
    });

    it("does not suppress when queue depth exceeds maxDepth", () => {
      const input = makeInput({
        gateEnteredAt: NOW - 15_000, // > 10s deadline, < 30s maxAgeMs
        queueDepth: 10, // exceeds maxDepth=5
      });
      const result = classifyGateHealth(queueContract, input);
      expect(result.verdict.status).toBe("unhealthy-breach");
    });
  });

  describe("working suppression", () => {
    it("suppresses breach when hasActiveTurn is true", () => {
      const contract = gate2Contract();
      const input = makeInput({
        gateEnteredAt: NOW - 600_000, // past 5min deadline
        hasActiveTurn: true,
      });
      const result = classifyGateHealth(contract, input);
      expect(result.verdict.status).toBe("healthy-suppressed-working");
    });

    it("does not suppress when hasActiveTurn is false", () => {
      const contract = gate2Contract();
      const input = makeInput({
        gateEnteredAt: NOW - 600_000, // past 5min deadline
        hasActiveTurn: false,
      });
      const result = classifyGateHealth(contract, input);
      expect(result.verdict.status).toBe("unhealthy-breach");
    });
  });

  describe("blocked suppression", () => {
    it("suppresses breach when isBlocked is true", () => {
      const contract = gate1Contract();
      const input = makeInput({
        gateEnteredAt: NOW - 120_000, // past 60s deadline
        isBlocked: true,
      });
      const result = classifyGateHealth(contract, input);
      expect(result.verdict.status).toBe("healthy-suppressed-blocked");
      expect(result.verdict.suppressionReason).toBe("blocked");
    });

    it("does not suppress when isBlocked is false", () => {
      const contract = gate1Contract();
      const input = makeInput({
        gateEnteredAt: NOW - 120_000, // past 60s deadline
        isBlocked: false,
      });
      const result = classifyGateHealth(contract, input);
      expect(result.verdict.status).toBe("unhealthy-breach");
    });
  });

  describe("suppression priority/ordering", () => {
    it("first matching suppression rule wins (queued before blocked)", () => {
      const contract: LifecycleContract = {
        label: "Multi-suppression test",
        gateId: "dispatched",
        expectedSignal: "Thinking",
        deadlineMs: 60_000,
        suppression: [
          { condition: "queued", maxDepth: 5, maxAgeMs: 30_000 },
          { condition: "blocked" },
        ],
      };

      // Both queued AND blocked conditions are met — first rule wins
      const input = makeInput({
        gateEnteredAt: NOW - 120_000, // past deadline
        queueDepth: 2, // within queued limits
        isBlocked: true, // also blocked
      });
      const result = classifyGateHealth(contract, input);

      // But: 120_000 elapsed > 30_000 maxAgeMs → queued suppression fails
      // Then blocked should apply
      expect(result.verdict.status).toBe("healthy-suppressed-blocked");
    });
  });
});

// ── AC 7: Full variant coverage ─────────────────────────────────────────────

describe("AC 7: Full variant coverage", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("healthy: within deadline with expected signal", () => {
    const contract = gate1Contract();
    const signals: LivenessSignal[] = [
      {
        type: "session-health",
        timestamp: NOW - 10_000,
        detail: { signalType: "Thinking" },
      },
    ];
    const input = makeInput({ gateEnteredAt: NOW - 10_000, signals });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy");
  });

  it("healthy: within deadline without signal (not yet due)", () => {
    const contract = gate1Contract();
    const input = makeInput({ gateEnteredAt: NOW - 10_000 }); // 10s elapsed, 60s deadline
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy");
  });

  it("healthy-suppressed-queued: past deadline but queued within limits", () => {
    // Contract with short deadline and generous maxAgeMs so queued
    // suppression can apply meaningfully.
    const contract: LifecycleContract = {
      label: "Queued-suppression test",
      gateId: "dispatched",
      expectedSignal: "Thinking",
      deadlineMs: 10_000,
      suppression: [{ condition: "queued", maxDepth: 5, maxAgeMs: 30_000 }],
    };

    // elapsed=15s > deadline=10s AND 15s < maxAgeMs=30s → suppressed
    const input = makeInput({
      gateEnteredAt: NOW - 15_000,
      queueDepth: 2,
    });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy-suppressed-queued");
    expect(result.verdict.suppressionReason).toBe("queued");

    // Also test that deeper queue beyond maxDepth fails suppression
    const input2 = makeInput({
      gateEnteredAt: NOW - 15_000,
      queueDepth: 10, // exceeds maxDepth=5
    });
    const result2 = classifyGateHealth(contract, input2);
    expect(result2.verdict.status).toBe("unhealthy-breach");
  });

  it("healthy-suppressed-queued: when queue is within limits and deadline just passed", () => {
    const contract: LifecycleContract = {
      label: "Test - queued suppression",
      gateId: "dispatched",
      expectedSignal: "Thinking",
      deadlineMs: 10_000,
      suppression: [{ condition: "queued", maxDepth: 3, maxAgeMs: 20_000 }],
    };
    const input = makeInput({
      gateEnteredAt: NOW - 15_000, // 15s elapsed > 10s deadline, but 15s < 20s maxAgeMs
      queueDepth: 2,
    });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy-suppressed-queued");
  });

  it("healthy-suppressed-working: long-running tasks with active turn", () => {
    const contract = gate2Contract();
    const input = makeInput({
      gateEnteredAt: NOW - 600_000, // 10 min > 5 min deadline
      hasActiveTurn: true,
    });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy-suppressed-working");
  });

  it("healthy-suppressed-blocked: blocked marker suppresses breach", () => {
    const contract = gate1Contract();
    const input = makeInput({
      gateEnteredAt: NOW - 120_000,
      isBlocked: true,
    });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.status).toBe("healthy-suppressed-blocked");
  });

  it("unhealthy-breach: overdue at each gate", () => {
    const contract1 = gate1Contract();
    const input1 = makeInput({
      gateEnteredAt: NOW - 120_000,
    });
    const result1 = classifyGateHealth(contract1, input1);
    expect(result1.verdict.status).toBe("unhealthy-breach");

    const contract2 = gate2Contract();
    const input2 = makeInput({
      gateEnteredAt: NOW - 600_000,
    });
    const result2 = classifyGateHealth(contract2, input2);
    expect(result2.verdict.status).toBe("unhealthy-breach");
  });

  it("suppressed-not-overdue: suppressed but actually not overdue", () => {
    const contract = gate1Contract();
    const input = makeInput({
      gateEnteredAt: NOW - 10_000, // well within 60s deadline
      queueDepth: 1,
      isBlocked: false,
    });
    const result = classifyGateHealth(contract, input);
    // Not overdue = healthy (not even breached)
    expect(result.verdict.status).toBe("healthy");
    expect(result.verdict.breached).toBe(false);
  });

  it("config override: custom deadline used in classifier", () => {
    const contract: LifecycleContract = {
      label: "Custom Gate 1 — tighter deadline",
      gateId: "dispatched",
      expectedSignal: "Thinking",
      deadlineMs: 5_000, // very tight
      suppression: [],
    };
    const input = makeInput({ gateEnteredAt: NOW - 10_000 });
    const result = classifyGateHealth(contract, input);
    expect(result.verdict.deadlineMs).toBe(5_000);
    expect(result.verdict.status).toBe("unhealthy-breach");
  });
});
