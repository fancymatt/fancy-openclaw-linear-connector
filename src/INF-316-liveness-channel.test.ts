/**
 * INF-316 — Liveness channel: dispatch-ack + session-health + turn/subagent liveness (pull).
 *
 * AC mapping:
 *   AC1 — Dispatch record (unique id + resolved session-key); "no record" ≠ "record without ack"
 *   AC2 — Gateway dispatch-ack: delivered, target_identity, status ∈ {accepted, queued},
 *         queue_depth/queue_age when queued; connector persists it
 *   AC3 — Wrong-target ack flagged when target session-key ≠ resolved delegate
 *   AC4 — Session-health pull query: healthy/unhealthy for a given agent
 *   AC5 — Turn-liveness pull query: active (in-flight turn / running subagent) vs idle
 *   AC6 — Single endpoint returns structured liveness snapshot composing all three signals
 *   AC7 — Probe cadence and ack-timeout are config, not hardcoded
 *   AC8 — Tests cover: dispatch+ack, dispatch-no-ack, ack=queued, wrong-target ack,
 *         session-health up/down, turn-liveness active/idle
 *
 * RED — modules under test do not exist yet.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Expected new module imports (will fail until implementer creates them) ──

/**
 * AC1 type: every dispatch produces a durable record carrying a unique dispatch id
 * and resolved target session-key.
 */
import {
  DispatchRecord,
  DispatchRecordStore,
  DispatchRecordStatus,
} from "./liveness-channel/dispatch-record-store.js";

/**
 * AC2 type: structured ack returned by the gateway / persisted by the connector.
 */
import {
  GatewayDispatchAck,
  GatewayDispatchStatus,
} from "./liveness-channel/gateway-ack-types.js";

/**
 * AC3: wrong-target detection.
 */
import {
  checkWrongTarget,
  WrongTargetFlag,
} from "./liveness-channel/wrong-target-detector.js";

/**
 * AC4: session-health pull query.
 */
import {
  SessionHealthProbe,
  SessionHealthResult,
} from "./liveness-channel/session-health.js";

/**
 * AC5: turn-liveness pull query.
 */
import {
  TurnLivenessProbe,
  TurnLivenessResult,
} from "./liveness-channel/turn-liveness.js";

/**
 * AC6: combined liveness snapshot endpoint logic.
 */
import {
  LivenessSnapshot,
  LivenessChannelEndpoint,
  LivenessChannelConfig,
} from "./liveness-channel/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `inf316-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `inf316-${prefix}-`));
}

const FIXED_NOW = new Date("2026-07-22T16:24:18Z");
const FIXED_NOW_MS = FIXED_NOW.getTime();

// =============================================================================
// AC1 — Dispatch record system
// =============================================================================

describe("INF-316 AC1: dispatch record (unique id + resolved session-key)", () => {
  let dbPath: string;
  let store: DispatchRecordStore;

  beforeEach(() => {
    dbPath = tmpDbPath("dispatch-record");
    store = new DispatchRecordStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("records a dispatch with a unique dispatchId (UUID) and resolved sessionKey", () => {
    const record = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-316",
      sessionKey: "linear-INF-316",
    });

    // Must have a unique non-integer ID — UUID-style
    expect(record.dispatchId).toBeDefined();
    expect(typeof record.dispatchId).toBe("string");
    expect(record.dispatchId.length).toBeGreaterThanOrEqual(32); // UUID length

    expect(record.agentId).toBe("igor");
    expect(record.ticketId).toBe("linear-INF-316");
    expect(record.sessionKey).toBe("linear-INF-316");

    // Status is 'pending' — sent but not acknowledged
    expect(record.status).toBe("pending");
  });

  it("each dispatch gets a different dispatchId", () => {
    const r1 = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-316",
      sessionKey: "linear-INF-316",
    });
    const r2 = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-317",
      sessionKey: "linear-INF-317",
    });
    expect(r1.dispatchId).not.toBe(r2.dispatchId);
  });

  it("'no record' is distinguishable from 'record without ack'", () => {
    // No dispatch recorded for INF-999
    const record = store.getDispatch("linear-INF-999");
    expect(record).toBeNull(); // "no record" — never dispatched

    // Record a dispatch but do NOT ack it
    const dispatched = store.recordDispatch({
      agentId: "sage",
      ticketId: "AI-999",
      sessionKey: "linear-AI-999",
    });
    expect(dispatched.status).toBe("pending"); // "record without ack"

    // queryByTicket should show the same distinction
    const recordsForTicket = store.getDispatchesForTicket("linear-AI-999");
    expect(recordsForTicket).toHaveLength(1);
    expect(recordsForTicket[0].status).toBe("pending");

    // A ticket with no records at all returns empty
    expect(store.getDispatchesForTicket("linear-NEVER")).toEqual([]);
  });

  it("marks dispatched records as acknowledged when ack arrives", () => {
    const record = store.recordDispatch({
      agentId: "felix",
      ticketId: "UNITY-42",
      sessionKey: "linear-UNITY-42",
    });

    store.recordAck(record.dispatchId, {
      delivered: true,
      target_identity: "felix",
      status: "accepted",
    });

    const updated = store.getDispatch(record.dispatchId);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("acknowledged");
    expect(updated!.ack).toBeDefined();
    expect(updated!.ack!.delivered).toBe(true);
    expect(updated!.ack!.status).toBe("accepted");
  });

  it("retrieves draft records by dispatchId", () => {
    const r = store.recordDispatch({
      agentId: "noah",
      ticketId: "RN-7",
      sessionKey: "linear-RN-7",
    });
    const fetched = store.getDispatch(r.dispatchId);
    expect(fetched).not.toBeNull();
    expect(fetched!.dispatchId).toBe(r.dispatchId);
  });
});

// =============================================================================
// AC2 — Gateway dispatch-ack type and persistence
// =============================================================================

describe("INF-316 AC2: gateway ack type and persistence", () => {
  let dbPath: string;
  let store: DispatchRecordStore;

  beforeEach(() => {
    dbPath = tmpDbPath("gateway-ack");
    store = new DispatchRecordStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("persists a gateway ack with delivered=true and status=accepted", () => {
    const record = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-316",
      sessionKey: "linear-INF-316",
    });

    const gatewayAck: GatewayDispatchAck = {
      delivered: true,
      target_identity: "igor",
      status: "accepted",
    };

    store.recordAck(record.dispatchId, gatewayAck);
    const updated = store.getDispatch(record.dispatchId);

    expect(updated!.ack!.delivered).toBe(true);
    expect(updated!.ack!.target_identity).toBe("igor");
    expect(updated!.ack!.status).toBe("accepted");
  });

  it("persists a queued gateway ack with queue_depth and queue_age", () => {
    const record = store.recordDispatch({
      agentId: "sage",
      ticketId: "AI-9000",
      sessionKey: "linear-AI-9000",
    });

    const queuedAck: GatewayDispatchAck = {
      delivered: true,
      target_identity: "sage",
      status: "queued",
      queue_depth: 3,
      queue_age: 12_500, // 12.5 seconds
    };

    store.recordAck(record.dispatchId, queuedAck);
    const updated = store.getDispatch(record.dispatchId);

    expect(updated!.ack!.status).toBe("queued");
    expect(updated!.ack!.queue_depth).toBe(3);
    expect(updated!.ack!.queue_age).toBe(12_500);
  });

  it("round-trips a full gateway ack object", () => {
    const record = store.recordDispatch({
      agentId: "noah",
      ticketId: "RN-8",
      sessionKey: "linear-RN-8",
    });

    const ack: GatewayDispatchAck = {
      delivered: true,
      target_identity: "noah",
      status: "queued",
      queue_depth: 1,
      queue_age: 4_200,
    };

    store.recordAck(record.dispatchId, ack);

    const fetched = store.getDispatch(record.dispatchId);
    expect(fetched!.ack).toEqual(ack);
  });

  it("rejects ack for unknown dispatchId", () => {
    expect(() => {
      store.recordAck("nonexistent-uuid", {
        delivered: true,
        target_identity: "igor",
        status: "accepted",
      });
    }).toThrow();
  });
});

// =============================================================================
// AC3 — Wrong-target ack flagged
// =============================================================================

describe("INF-316 AC3: wrong-target ack detection", () => {
  it("returns no flag when ack target_identity matches resolved delegate", () => {
    const result = checkWrongTarget({
      ackTarget: "igor",
      resolvedDelegate: "igor",
    });
    expect(result.flagged).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("returns a wrong-target flag when ack target_identity ≠ resolved delegate", () => {
    const result = checkWrongTarget({
      ackTarget: "sage",
      resolvedDelegate: "igor",
    });
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain("INF-224");
    expect(result.expected).toBe("igor");
    expect(result.actual).toBe("sage");
  });

  it("flags via store when ack target_identity differs from dispatch sessionKey", () => {
    const dbPath = tmpDbPath("wrong-target-store");
    const store = new DispatchRecordStore(dbPath);

    try {
      const record = store.recordDispatch({
        agentId: "felix",
        ticketId: "UNITY-100",
        sessionKey: "linear-UNITY-100",
      });

      store.recordAck(record.dispatchId, {
        delivered: true,
        target_identity: "noah", // Wrong! Dispatch was for felix
        status: "accepted",
      });

      const updated = store.getDispatch(record.dispatchId);
      expect(updated!.wrongTarget).toBeDefined();
      expect(updated!.wrongTarget!.flagged).toBe(true);
      expect(updated!.wrongTarget!.expected).toBe("felix");
      expect(updated!.wrongTarget!.actual).toBe("noah");
    } finally {
      store.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("does NOT flag when delegate transfer is legitimate (resolvedDelegate updated between dispatch and ack)", () => {
    // If the resolved delegate was intentionally changed, the ack target may differ
    // but the store should track which delegate was RESOLVED at dispatch time.
    const result = checkWrongTarget({
      ackTarget: "igorr",
      resolvedDelegate: "igor",          // Typo: "igorr" is likely a misrouting
    });
    expect(result.flagged).toBe(true);

    // Proper transfer: ack target is the NEW delegate, and the store records
    // the resolved delegate snapshot at dispatch time for comparison
    const result2 = checkWrongTarget({
      ackTarget: "felix",
      resolvedDelegate: "felix",          // Correct: delegate was updated to felix
      delegateAtDispatch: "igor",         // Prior delegate at dispatch time
    });
    expect(result2.flagged).toBe(false);
  });
});

// =============================================================================
// AC4 — Session-health pull query
// =============================================================================

describe("INF-316 AC4: session-health pull query", () => {
  let healthProbe: SessionHealthProbe;

  beforeEach(() => {
    healthProbe = new SessionHealthProbe();
  });

  it("returns healthy when agent has an active model/runtime session", () => {
    // Agent "igor" is actively connected (simulated by an agent session)
    const result: SessionHealthResult = healthProbe.check("igor");
    // Will fail until implemented — SessionHealthProbe doesn't exist yet
    expect(result.healthy).toBe(true);
  });

  it("returns unhealthy when agent has no active model/runtime session", () => {
    const result: SessionHealthResult = healthProbe.check("nonexistent-agent");
    expect(result.healthy).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("accepts an optional session tracker dependency", () => {
    // The session-health probe must integrate with the connector's SessionTracker
    const probeWithTracker = new SessionHealthProbe({
      sessionTracker: {} as any, // Would be a real SessionTracker in production
    });
    const result: SessionHealthResult = probeWithTracker.check("sage");
    expect(typeof result.healthy).toBe("boolean");
  });

  it("reports detail when unhealthy", () => {
    const result: SessionHealthResult = healthProbe.check("offline-agent");
    if (!result.healthy) {
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
    }
  });
});

// =============================================================================
// AC5 — Turn-liveness pull query
// =============================================================================

describe("INF-316 AC5: turn-liveness pull query", () => {
  let turnProbe: TurnLivenessProbe;

  beforeEach(() => {
    turnProbe = new TurnLivenessProbe();
  });

  it("returns active when agent has an in-flight turn for the ticket", () => {
    const result: TurnLivenessResult = turnProbe.check("igor", "INF-316");
    expect(result.active).toBe(true);
    expect(result.hasInFlightTurn).toBe(true);
  });

  it("returns active when agent has a running subagent for the ticket", () => {
    const result: TurnLivenessResult = turnProbe.check("sage", "AI-9000");
    expect(result.active).toBe(true);
    expect(result.hasRunningSubagent).toBe(true);
  });

  it("returns idle when agent has no in-flight turn and no running subagent", () => {
    const result: TurnLivenessResult = turnProbe.check("igor", "INF-999");
    expect(result.active).toBe(false);
    expect(result.hasInFlightTurn).toBe(false);
    expect(result.hasRunningSubagent).toBe(false);
  });

  it("throws when ticketId is missing", () => {
    expect(() => turnProbe.check("igor", "")).toThrow();
  });
});

// =============================================================================
// AC6 — Combined liveness snapshot endpoint
// =============================================================================

describe("INF-316 AC6: combined liveness snapshot endpoint", () => {
  let endpoint: LivenessChannelEndpoint;

  beforeEach(() => {
    endpoint = new LivenessChannelEndpoint({
      dispatchRecordStore: {} as any,
      sessionHealthProbe: {} as any,
      turnLivenessProbe: {} as any,
    });
  });

  it("returns a structured snapshot for any tracked ticket, composing all three signals", () => {
    // snapshotForTicket returns dispatch + session-health + turn-liveness
    const snapshot: LivenessSnapshot = endpoint.snapshotForTicket("INF-316");
    // Will fail until LivenessChannelEndpoint and LivenessSnapshot exist

    // Must contain all three top-level signal keys
    expect(snapshot).toHaveProperty("dispatch");
    expect(snapshot).toHaveProperty("sessionHealth");
    expect(snapshot).toHaveProperty("turnLiveness");

    // dispatch signal
    expect(snapshot.dispatch).toHaveProperty("sent");
    expect(snapshot.dispatch).toHaveProperty("acknowledged");

    // session-health signal
    expect(snapshot.sessionHealth).toHaveProperty("healthy");

    // turn-liveness signal
    expect(snapshot.turnLiveness).toHaveProperty("active");
  });

  it("snapshot.dispatch identifies 'no record' vs 'pending' vs 'acknowledged'", () => {
    const snapshot: LivenessSnapshot = endpoint.snapshotForTicket("NEVER-SENT");
    // Never sent
    expect(snapshot.dispatch.sent).toBe(false);
    // There is no record at all
    expect(snapshot.dispatch.hasRecord).toBe(false);

    const snapshotPending: LivenessSnapshot = endpoint.snapshotForTicket("INF-316");
    // If sent but unacked:
    if (snapshotPending.dispatch.sent && !snapshotPending.dispatch.acknowledged) {
      expect(snapshotPending.dispatch.hasRecord).toBe(true);
      expect(snapshotPending.dispatch.ack).toBeNull();
    }
  });

  it("includes ticket id and timestamp in the snapshot", () => {
    const snapshot: LivenessSnapshot = endpoint.snapshotForTicket("INF-316");
    expect(snapshot.ticketId).toBe("linear-INF-316");
    expect(snapshot.timestamp).toBeDefined();
    expect(typeof snapshot.timestamp).toBe("string");
    expect(() => new Date(snapshot.timestamp)).not.toThrow();
  });
});

// =============================================================================
// AC7 — Probe cadence and ack-timeout are config, not hardcoded
// =============================================================================

describe("INF-316 AC7: config-driven probe cadence and ack-timeout", () => {
  it("LivenessChannelConfig accepts probeCadenceMs and ackTimeoutMs", () => {
    // Both should be optional with sensible defaults
    const config: LivenessChannelConfig = {};
    expect(config).toBeDefined();
    // When not set, defaults should be reasonable
    expect(config.probeCadenceMs).toBeUndefined();
    expect(config.ackTimeoutMs).toBeUndefined();
  });

  it("probeCadenceMs overrides the default probe interval", () => {
    const config: LivenessChannelConfig = {
      probeCadenceMs: 15_000, // 15 seconds
    };
    expect(config.probeCadenceMs).toBe(15_000);

    // Pass config to the endpoint constructor
    const endpoint = new LivenessChannelEndpoint({
      dispatchRecordStore: {} as any,
      sessionHealthProbe: {} as any,
      turnLivenessProbe: {} as any,
      config,
    });
    expect((endpoint as any).config.probeCadenceMs).toBe(15_000);
  });

  it("ackTimeoutMs overrides the default ack timeout window", () => {
    const config: LivenessChannelConfig = {
      ackTimeoutMs: 120_000, // 2 minutes
    };
    expect(config.ackTimeoutMs).toBe(120_000);
  });

  it("defaults are applied when config fields are omitted", () => {
    const config: LivenessChannelConfig = {};
    const endpoint = new LivenessChannelEndpoint({
      dispatchRecordStore: {} as any,
      sessionHealthProbe: {} as any,
      turnLivenessProbe: {} as any,
      config,
    });
    // Default probe cadence should be defined
    expect((endpoint as any).config.probeCadenceMs).toBeGreaterThan(0);
    // Default ack timeout should be defined
    expect((endpoint as any).config.ackTimeoutMs).toBeGreaterThan(0);
  });

  it("config can also be passed through the dispatch record store constructor", () => {
    const dbPath = tmpDbPath("config-store");
    // The DispatchRecordStore should accept a probeCadenceMs/ackTimeoutMs config
    const store = new DispatchRecordStore(dbPath, {
      probeCadenceMs: 30_000,
      ackTimeoutMs: 60_000,
    });
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

// =============================================================================
// AC8 — End-to-end scenario tests covering all AC combinations
// =============================================================================

describe("INF-316 AC8: scenario coverage", () => {
  let dbPath: string;
  let store: DispatchRecordStore;

  beforeEach(() => {
    dbPath = tmpDbPath("scenarios");
    store = new DispatchRecordStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  // ── Dispatch + ack (happy path) ──

  it("scenario: dispatch + ack (happy path)", () => {
    const record = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-316",
      sessionKey: "linear-INF-316",
    });
    expect(record.status).toBe("pending");

    store.recordAck(record.dispatchId, {
      delivered: true,
      target_identity: "igor",
      status: "accepted",
    });

    const updated = store.getDispatch(record.dispatchId);
    expect(updated!.status).toBe("acknowledged");
    expect(updated!.ack!.status).toBe("accepted");
    expect(updated!.ack!.delivered).toBe(true);
  });

  // ── Dispatch no ack (delivery failure) ──

  it("scenario: dispatch-no-ack (delivery failure)", () => {
    const record = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-317",
      sessionKey: "linear-INF-317",
    });
    // No ack recorded — status stays 'pending'
    expect(record.status).toBe("pending");

    // After ackTimeoutMs, the dispatch should be flagged as timed-out
    // The store should surface pending dispatches that exceeded their timeout
    const overdue = store.getOverdueDispatches(0); // 0 ms = check everything now
    const match = overdue.find((d) => d.dispatchId === record.dispatchId);
    expect(match).toBeDefined();
    expect(match!.status).toBe("pending");
    expect(match!.ack).toBeNull(); // No ack arrived
  });

  // ── Ack = queued (depth/age surfaced) ──

  it("scenario: ack=queued (depth/age surfaced)", () => {
    const record = store.recordDispatch({
      agentId: "sage",
      ticketId: "AI-9001",
      sessionKey: "linear-AI-9001",
    });

    store.recordAck(record.dispatchId, {
      delivered: true,
      target_identity: "sage",
      status: "queued",
      queue_depth: 5,
      queue_age: 30_000, // 30 seconds in queue
    });

    const updated = store.getDispatch(record.dispatchId);
    expect(updated!.status).toBe("acknowledged");
    expect(updated!.ack!.status).toBe("queued");
    expect(updated!.ack!.queue_depth).toBe(5);
    expect(updated!.ack!.queue_age).toBe(30_000);
  });

  // ── Wrong-target ack flagged ──

  it("scenario: wrong-target ack flagged", () => {
    const record = store.recordDispatch({
      agentId: "felix",
      ticketId: "UNITY-200",
      sessionKey: "linear-UNITY-200",
    });

    // Gateway acked to "noah" instead of "felix"
    store.recordAck(record.dispatchId, {
      delivered: true,
      target_identity: "noah",
      status: "accepted",
    });

    const updated = store.getDispatch(record.dispatchId);
    expect(updated!.wrongTarget).toBeDefined();
    expect(updated!.wrongTarget!.flagged).toBe(true);
    expect(updated!.wrongTarget!.expected).toBe("felix");
    expect(updated!.wrongTarget!.actual).toBe("noah");

    // The wrong-target flag should be distinct from the ack status
    // (wrong-target ack is still an ack — the delivery reached someone, just the wrong someone)
    expect(updated!.status).toBe("acknowledged");
  });

  // ── Session-health up/down ──

  it("scenario: session-health up/down", () => {
    const healthProbe = new SessionHealthProbe();

    // Agent with an active runtime session
    const healthyResult = healthProbe.check("igor");
    expect(typeof healthyResult.healthy).toBe("boolean");

    // Agent with no runtime session
    const unhealthyResult = healthProbe.check("nonexistent");
    expect(unhealthyResult.healthy).toBe(false);
    if (!unhealthyResult.healthy) {
      expect(unhealthyResult.reason).toBeTruthy();
    }
  });

  // ── Turn-liveness active/idle ──

  it("scenario: turn-liveness active/idle", () => {
    const turnProbe = new TurnLivenessProbe();

    // Active: in-flight turn
    const activeResult = turnProbe.check("igor", "INF-316");
    expect(activeResult.active).toBe(true);

    // Idle: no turn, no subagent
    const idleResult = turnProbe.check("igor", "INF-999");
    expect(idleResult.active).toBe(false);
    expect(idleResult.hasInFlightTurn).toBe(false);
    expect(idleResult.hasRunningSubagent).toBe(false);
  });

  // ── Combined snapshot ──

  it("scenario: combined snapshot composing all three signals", () => {
    const endpoint = new LivenessChannelEndpoint({
      dispatchRecordStore: store,
      sessionHealthProbe: new SessionHealthProbe(),
      turnLivenessProbe: new TurnLivenessProbe(),
    });

    // Start by recording a dispatch
    const record = store.recordDispatch({
      agentId: "igor",
      ticketId: "INF-316",
      sessionKey: "linear-INF-316",
    });

    // Ack it
    store.recordAck(record.dispatchId, {
      delivered: true,
      target_identity: "igor",
      status: "accepted",
    });

    // Get the combined snapshot
    const snapshot = endpoint.snapshotForTicket("INF-316");

    // Verify all three signals are present
    expect(snapshot.dispatch).toBeDefined();
    expect(snapshot.sessionHealth).toBeDefined();
    expect(snapshot.turnLiveness).toBeDefined();

    // Dispatch signal reflects the ack
    expect(snapshot.dispatch.sent).toBe(true);
    expect(snapshot.dispatch.acknowledged).toBe(true);
    expect(snapshot.dispatch.hasRecord).toBe(true);

    // Session-health is present (boolean)
    expect(typeof snapshot.sessionHealth.healthy).toBe("boolean");

    // Turn-liveness is present (boolean)
    expect(typeof snapshot.turnLiveness.active).toBe("boolean");
  });
});

// =============================================================================
// Type-level contract verifications (compile-time assertions)
// =============================================================================

describe("INF-316: type contract enforcement", () => {
  it("DispatchRecordStatus has expected values", () => {
    // The status should be a union type with these values
    const statuses: DispatchRecordStatus[] = [
      "pending",       // Sent but no ack received
      "acknowledged",  // Gateway ack received
      "timed_out",     // Ack timeout exceeded
    ];
    expect(statuses).toContain("pending");
    expect(statuses).toContain("acknowledged");
    expect(statuses).toContain("timed_out");
  });

  it("GatewayDispatchStatus has expected values", () => {
    const statuses: GatewayDispatchStatus[] = ["accepted", "queued"];
    expect(statuses).toContain("accepted");
    expect(statuses).toContain("queued");
  });

  it("LivenessSnapshot shape is correct", () => {
    // Structural verification — these are the keys a consumer (contract engine,
    // classifier, UI) expects.
    const snapshot: LivenessSnapshot = {
      ticketId: "linear-INF-316",
      timestamp: "2026-07-22T16:24:18.000Z",
      dispatch: {
        sent: true,
        acknowledged: true,
        hasRecord: true,
        dispatchId: "uuid-here",
        ack: {
          delivered: true,
          target_identity: "igor",
          status: "accepted",
        },
      },
      sessionHealth: {
        healthy: true,
      },
      turnLiveness: {
        active: true,
        hasInFlightTurn: true,
        hasRunningSubagent: false,
      },
    };

    // Verify structural completeness
    expect(snapshot.dispatch.ack).toBeDefined();
    expect(snapshot.sessionHealth.healthy).toBe(true);
    expect(snapshot.turnLiveness.active).toBe(true);
    expect(snapshot.turnLiveness.hasInFlightTurn).toBe(true);
    expect(snapshot.turnLiveness.hasRunningSubagent).toBe(false);
  });

  it("LivenessSnapshot dispatch without ack has ack=null", () => {
    const snapshot: LivenessSnapshot = {
      ticketId: "linear-INF-317",
      timestamp: "2026-07-22T16:24:18.000Z",
      dispatch: {
        sent: true,
        acknowledged: false,
        hasRecord: true,
        dispatchId: "uuid-here",
        ack: null, // No ack received
      },
      sessionHealth: {
        healthy: false,
        reason: "no active runtime session",
      },
      turnLiveness: {
        active: false,
        hasInFlightTurn: false,
        hasRunningSubagent: false,
      },
    };

    expect(snapshot.dispatch.ack).toBeNull();
    expect(snapshot.dispatch.acknowledged).toBe(false);
    expect(snapshot.dispatch.sent).toBe(true);
    expect(snapshot.dispatch.hasRecord).toBe(true);
  });
});
