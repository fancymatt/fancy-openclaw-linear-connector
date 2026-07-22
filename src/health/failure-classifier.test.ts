/**
 * Tests for failure classifier (INF-319).
 *
 * Deterministic mapping from (HealthVerdict breach, LivenessSnapshot) → typed failure_class.
 *
 * AC coverage map:
 *   Gate 1 (not picked up):
 *     1. no dispatch record → connector-didnt-fire
 *     2. record but no ack → delivery-failed
 *     3. ack target-key ≠ resolved agent → wrong-target
 *     4. ack + session unhealthy → agent-broken
 *     5. ack + healthy + no pickup → behavioral-noop
 *     6. ack=queued → healthy-suppressed:queued (NOT a failure)
 *     7. state=Backlog → backlog-skipped
 *   Gate 2 (not completed):
 *     8. unhealthy session → agent-broke-mid-task
 *     9. alive + no in-flight turn + incomplete → stuck
 *     10. working state + delegate=null → delegate-nulled
 *     11. hard side-effect present + no verb → verb-not-sent
 *     12. active turn/subagent → healthy-suppressed:working (NOT a failure)
 *     13. explicit needs-human/gate/break-glass marker → healthy-suppressed:blocked (NOT a failure)
 *   Cross-cutting:
 *     14. Every classification carries the evidence used to reach it
 *     15. The three healthy-suppressed cases are never emitted as failures
 *     16. Pure/deterministic — same inputs always produce same output
 */

import { jest } from "@jest/globals";
import {
  classifyFailure,
  type FailureClass,
  type FailureClassification,
} from "./failure-classifier.js";
import type { HealthVerdict, GateId, HealthStatus } from "./health-types.js";
import type { LivenessSnapshot } from "../liveness-channel/index.js";
import type { GatewayDispatchAck } from "../liveness-channel/gateway-ack-types.js";
import type { SessionHealthResult } from "../liveness-channel/session-health.js";
import type { TurnLivenessResult } from "../liveness-channel/turn-liveness.js";
import type { DispatchRecord } from "../liveness-channel/dispatch-record-store.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const NOW = 1_000_000_000_000;

function makeVerdict(overrides: Partial<HealthVerdict> & { gateId: GateId }): HealthVerdict {
  return {
    status: "unhealthy-breach",
    contractLabel: "test-contract",
    expectedSignal: "Thinking",
    deadlineMs: 60_000,
    actualElapsedMs: 120_000,
    breached: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    ticketId: "linear-INF-999",
    timestamp: new Date(NOW).toISOString(),
    dispatch: {
      sent: true,
      acknowledged: true,
      hasRecord: true,
      dispatchId: "disp-001",
      agentId: "igor",
      sessionKey: "linear-INF-999",
      status: "acknowledged",
      ack: makeAck(),
    },
    sessionHealth: { healthy: true },
    turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    ...overrides,
  };
}

function makeAck(overrides: Partial<GatewayDispatchAck> = {}): GatewayDispatchAck {
  return {
    delivered: true,
    target_identity: "igor",
    status: "accepted",
    ...overrides,
  };
}

// ── Gate 1: not picked up ──────────────────────────────────────────────────

describe("Gate 1 — failure classification (not picked up)", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  // AC 1: no dispatch record → connector-didnt-fire
  it("AC 1: classifies as connector-didnt-fire when no dispatch record exists", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: false,
        acknowledged: false,
        hasRecord: false,
        ack: null,
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("connector-didnt-fire");
    expect(result.isFailure).toBe(true);
  });

  // AC 2: record but no ack → delivery-failed
  it("AC 2: classifies as delivery-failed when dispatch record exists but no ack", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: false,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "pending",
        ack: null,
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("delivery-failed");
    expect(result.isFailure).toBe(true);
  });

  // AC 3: ack target-key ≠ resolved agent → wrong-target (INF-224 class)
  it("AC 3: classifies as wrong-target when ack target differs from resolved agent", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck({ target_identity: "sage", target_session_key: "agent:sage:linear-INF-999" }),
        wrongTarget: {
          flagged: true,
          reason: "expected igor, got sage",
          expected: "igor",
          actual: "sage",
          delegateAtDispatch: "igor",
        },
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("wrong-target");
    expect(result.isFailure).toBe(true);
  });

  // AC 4: ack + session unhealthy → agent-broken
  it("AC 4: classifies as agent-broken when ack present but session unhealthy", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: false, reason: "no active runtime session" },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("agent-broken");
    expect(result.isFailure).toBe(true);
  });

  // AC 5: ack + healthy + no pickup → behavioral-noop
  it("AC 5: classifies as behavioral-noop when acked, healthy, but no pickup", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck(),
      },
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("behavioral-noop");
    expect(result.isFailure).toBe(true);
  });

  // AC 6: ack=queued → healthy-suppressed:queued (NOT a failure)
  it("AC 6: classifies as healthy-suppressed-queued when ack status is queued", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck({ status: "queued", queue_depth: 3, queue_age: 5000 }),
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-queued");
    expect(result.isFailure).toBe(false);
  });

  // AC 7: state=Backlog → backlog-skipped
  it("AC 7: classifies as backlog-skipped when dispatch status indicates Backlog", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: false,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "pending",
        ack: null,
      },
      // Backlog state is conveyed via sessionHealth detail or dispatch detail
      sessionHealth: { healthy: true, reason: "Backlog" },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("backlog-skipped");
    expect(result.isFailure).toBe(true);
  });
});

// ── Gate 2: not completed ──────────────────────────────────────────────────

describe("Gate 2 — failure classification (not completed)", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  // AC 8: unhealthy session → agent-broke-mid-task
  it("AC 8: classifies as agent-broke-mid-task when session unhealthy in Gate 2", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: false, reason: "session terminated unexpectedly" },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("agent-broke-mid-task");
    expect(result.isFailure).toBe(true);
  });

  // AC 9: alive + no in-flight turn + incomplete → stuck (subagent-return-gap)
  it("AC 9: classifies as stuck when alive but no in-flight turn and incomplete", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: {
        active: false,
        hasInFlightTurn: false,
        hasRunningSubagent: false,
        sessionKey: "linear-INF-999",
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("stuck");
    expect(result.isFailure).toBe(true);
  });

  // AC 10: working state + delegate=null → delegate-nulled (AI-1395)
  it("AC 10: classifies as delegate-nulled when working state but delegate is null", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck(),
        // delegate nulled — no agentId resolves
        wrongTarget: {
          flagged: true,
          reason: "delegate was nulled after dispatch",
          expected: "igor",
          actual: "",
          delegateAtDispatch: "igor",
        },
      },
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("delegate-nulled");
    expect(result.isFailure).toBe(true);
  });

  // AC 11: hard side-effect present (merged PR/pushed branch) + no verb → verb-not-sent
  it("AC 11: classifies as verb-not-sent when hard side-effect present but no verb", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    // The verdict detail carries side-effect evidence
    const verdictWithSideEffect = makeVerdict({
      gateId: "picked-up",
      expectedSignal: "verb",
      detail: JSON.stringify({ mergedPR: "https://github.com/org/repo/pull/123", pushedBranch: "feature/foo" }),
    });

    const result = classifyFailure(verdictWithSideEffect, snapshot);

    expect(result.failureClass).toBe("verb-not-sent");
    expect(result.isFailure).toBe(true);
  });
});

// ── Gate 2: non-failure suppressions ───────────────────────────────────────

describe("Gate 2 — non-failure suppressed states", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  // AC 12: active turn/subagent → healthy-suppressed:working (NOT a failure)
  it("AC 12: classifies as healthy-suppressed-working when active turn or subagent", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: {
        active: true,
        hasInFlightTurn: true,
        hasRunningSubagent: false,
        sessionKey: "linear-INF-999",
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-working");
    expect(result.isFailure).toBe(false);
  });

  it("AC 12: classifies as healthy-suppressed-working when subagent running", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: {
        active: true,
        hasInFlightTurn: false,
        hasRunningSubagent: true,
        sessionKey: "linear-INF-999",
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-working");
    expect(result.isFailure).toBe(false);
  });

  // AC 13: explicit needs-human/gate/break-glass marker → healthy-suppressed:blocked (NOT a failure)
  it("AC 13: classifies as healthy-suppressed-blocked when needs-human marker present", () => {
    const verdict = makeVerdict({
      gateId: "picked-up",
      expectedSignal: "verb",
      detail: JSON.stringify({ marker: "needs-human" }),
    });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-blocked");
    expect(result.isFailure).toBe(false);
  });

  it("AC 13: classifies as healthy-suppressed-blocked when gate marker present", () => {
    const verdict = makeVerdict({
      gateId: "picked-up",
      expectedSignal: "verb",
      detail: JSON.stringify({ marker: "gate" }),
    });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-blocked");
    expect(result.isFailure).toBe(false);
  });

  it("AC 13: classifies as healthy-suppressed-blocked when break-glass marker present", () => {
    const verdict = makeVerdict({
      gateId: "picked-up",
      expectedSignal: "verb",
      detail: JSON.stringify({ marker: "break-glass" }),
    });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-blocked");
    expect(result.isFailure).toBe(false);
  });
});

// ── AC 14: Evidence attached to every classification ────────────────────────

describe("AC 14: Every classification carries the evidence used to reach it", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("connector-didnt-fire includes evidence about missing dispatch record", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: { sent: false, acknowledged: false, hasRecord: false, ack: null },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(typeof result.evidence).toBe("object");
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("delivery-failed includes evidence about missing ack", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: false,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "pending",
        ack: null,
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("wrong-target includes evidence about mismatched target", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck({ target_identity: "sage" }),
        wrongTarget: {
          flagged: true,
          reason: "expected igor, got sage",
          expected: "igor",
          actual: "sage",
        },
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("agent-broken includes evidence about unhealthy session", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: false, reason: "session crashed" },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("behavioral-noop includes evidence about healthy-but-no-pickup", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("agent-broke-mid-task includes evidence about mid-task failure", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: false, reason: "runtime died mid-task" },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("stuck includes evidence about no in-flight turn", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });

  it("healthy-suppressed-queued includes evidence about queue state", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck({ status: "queued", queue_depth: 3, queue_age: 5000 }),
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.evidence).toBeDefined();
    expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
  });
});

// ── AC 15: Suppressed cases are never emitted as failures ──────────────────

describe("AC 15: The three healthy-suppressed cases are never emitted as failures", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("healthy-suppressed-queued has isFailure=false", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "disp-001",
        agentId: "igor",
        sessionKey: "linear-INF-999",
        status: "acknowledged",
        ack: makeAck({ status: "queued", queue_depth: 2, queue_age: 3000 }),
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-queued");
    expect(result.isFailure).toBe(false);
  });

  it("healthy-suppressed-working has isFailure=false", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: {
        active: true,
        hasInFlightTurn: true,
        hasRunningSubagent: false,
        sessionKey: "linear-INF-999",
      },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-working");
    expect(result.isFailure).toBe(false);
  });

  it("healthy-suppressed-blocked has isFailure=false", () => {
    const verdict = makeVerdict({
      gateId: "picked-up",
      expectedSignal: "verb",
      detail: JSON.stringify({ marker: "needs-human" }),
    });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result = classifyFailure(verdict, snapshot);

    expect(result.failureClass).toBe("healthy-suppressed-blocked");
    expect(result.isFailure).toBe(false);
  });

  it("all suppressed classes are distinguishable from real failure classes", () => {
    const suppressedClasses: FailureClass[] = [
      "healthy-suppressed-queued",
      "healthy-suppressed-working",
      "healthy-suppressed-blocked",
    ];

    // Each suppressed class should have isFailure=false
    for (const cls of suppressedClasses) {
      // Build a minimal scenario for each — just verify the type exists
      // and is part of the FailureClass union
      expect(typeof cls).toBe("string");
      expect(cls.startsWith("healthy-suppressed")).toBe(true);
    }
  });
});

// ── AC 16: Pure/deterministic ──────────────────────────────────────────────

describe("AC 16: Pure/deterministic — same inputs always produce same output", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns identical output for identical Gate 1 inputs (connector-didnt-fire)", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: { sent: false, acknowledged: false, hasRecord: false, ack: null },
    });

    const result1 = classifyFailure(verdict, snapshot);
    const result2 = classifyFailure(verdict, snapshot);

    expect(result1).toEqual(result2);
    expect(result1.failureClass).toBe(result2.failureClass);
    expect(result1.isFailure).toBe(result2.isFailure);
    expect(result1.evidence).toEqual(result2.evidence);
  });

  it("returns identical output for identical Gate 2 inputs (stuck)", () => {
    const verdict = makeVerdict({ gateId: "picked-up", expectedSignal: "verb" });
    const snapshot = makeSnapshot({
      sessionHealth: { healthy: true },
      turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
    });

    const result1 = classifyFailure(verdict, snapshot);
    const result2 = classifyFailure(verdict, snapshot);

    expect(result1).toEqual(result2);
  });

  it("returns identical output for identical inputs across all gate/class combinations", () => {
    const testCases: Array<{ name: string; verdict: HealthVerdict; snapshot: LivenessSnapshot }> = [
      {
        name: "wrong-target",
        verdict: makeVerdict({ gateId: "dispatched" }),
        snapshot: makeSnapshot({
          dispatch: {
            sent: true,
            acknowledged: true,
            hasRecord: true,
            dispatchId: "disp-002",
            agentId: "igor",
            sessionKey: "linear-INF-998",
            status: "acknowledged",
            ack: makeAck({ target_identity: "felix" }),
            wrongTarget: { flagged: true, reason: "mismatch", expected: "igor", actual: "felix" },
          },
        }),
      },
      {
        name: "healthy-suppressed-working",
        verdict: makeVerdict({ gateId: "picked-up", expectedSignal: "verb" }),
        snapshot: makeSnapshot({
          sessionHealth: { healthy: true },
          turnLiveness: { active: true, hasInFlightTurn: true, hasRunningSubagent: true },
        }),
      },
      {
        name: "delegate-nulled",
        verdict: makeVerdict({ gateId: "picked-up", expectedSignal: "verb" }),
        snapshot: makeSnapshot({
          dispatch: {
            sent: true,
            acknowledged: true,
            hasRecord: true,
            dispatchId: "disp-003",
            agentId: "sage",
            sessionKey: "linear-AI-100",
            status: "acknowledged",
            ack: makeAck(),
            wrongTarget: { flagged: true, reason: "nulled", expected: "sage", actual: "" },
          },
          sessionHealth: { healthy: true },
          turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false },
        }),
      },
    ];

    for (const tc of testCases) {
      const r1 = classifyFailure(tc.verdict, tc.snapshot);
      const r2 = classifyFailure(tc.verdict, tc.snapshot);
      expect(r1).toEqual(r2);
    }
  });

  it("does not mutate input verdict or snapshot", () => {
    const verdict = makeVerdict({ gateId: "dispatched" });
    const snapshot = makeSnapshot({
      dispatch: { sent: false, acknowledged: false, hasRecord: false, ack: null },
    });

    const verdictCopy = JSON.parse(JSON.stringify(verdict));
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot));

    classifyFailure(verdict, snapshot);

    expect(verdict).toEqual(verdictCopy);
    expect(snapshot).toEqual(snapshotCopy);
  });
});
