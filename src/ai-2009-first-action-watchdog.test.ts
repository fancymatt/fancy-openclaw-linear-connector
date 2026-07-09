/**
 * AI-2009 — Connector: first-action watchdog with auto-remediation ladder
 * (redispatch, re-route, alert).
 *
 * These are FAILING tests written before implementation (TDD write-tests state).
 * They define the contract the implementer (Igor) must satisfy. Every test maps
 * back to a verbatim acceptance criterion captured at intake (astrid,
 * 2026-07-09T09:50:40Z); the AC id is called out in each describe/it.
 *
 * Contract under test — a new module `./first-action-watchdog.ts` exporting:
 *   - runFirstActionWatchdogSweep(opts): Promise<WatchdogSweepResult>
 *       One sweep over governed tickets. Arms a per-state deadline at dispatch
 *       delivery; on breach runs the escalation ladder (redispatch → unreachable
 *       + alert → optional capability-policy-respecting re-route). NEVER
 *       auto-transitions workflow state; NEVER fires on human/Matt-blocked work.
 *   - resolveRerouteTarget(policy, role, currentDelegate): string | null
 *       Re-route rung: a fallback body for the role (≠ current delegate), or null
 *       for singleton roles / roles with no fallback.
 *   - redispatchViaWatchdog(store, dispatch): { admitted; suppressed }
 *       A watchdog re-dispatch that bypasses dispatch idempotency (a genuine
 *       fresh wake — AI-1969 admit semantics), unlike an ordinary duplicate.
 *   - computePerStateDwellAggregates(rows, nowMs): PerStateDwellAggregate[]
 *       p4 metrics distillation: per-state idle/dwell aggregates.
 *
 * and a state module `./first-action-watchdog-state.ts` exporting:
 *   - getFirstActionWatchdogState(): FirstActionWatchdogState (per-ticket ladder
 *     + liveness — surfaced at /admin and /health)
 *   - resetFirstActionWatchdogStateForTest(): void
 *
 * The data plane (reading dispatch-delivery timestamps from the operational
 * event store, first-owner-action timestamps from Linear, delegate/assignee/
 * labels from the enrolled-tickets mirror) is injected via opts.listTickets so
 * the ladder logic is tested in isolation from I/O — the same injection style
 * as runSlaSweep (fetchFn / notify / wakeAgent / now).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";

// The contract module does not exist yet — load it dynamically so each test
// enumerates as an individual RED (with a clear message per AC) instead of the
// whole suite failing to collect. Once ./first-action-watchdog.ts lands, these
// bindings resolve and the assertions become the real spec.
/* eslint-disable @typescript-eslint/no-explicit-any */
let runFirstActionWatchdogSweep: any;
let resolveRerouteTarget: any;
let redispatchViaWatchdog: any;
let computePerStateDwellAggregates: any;
let getFirstActionWatchdogState: any;
let resetFirstActionWatchdogStateForTest: any;

beforeAll(async () => {
  const mod = await import("./first-action-watchdog.js");
  ({
    runFirstActionWatchdogSweep,
    resolveRerouteTarget,
    redispatchViaWatchdog,
    computePerStateDwellAggregates,
  } = mod as any);
  const state = await import("./first-action-watchdog-state.js");
  ({ getFirstActionWatchdogState, resetFirstActionWatchdogStateForTest } = state as any);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

// A minimal workflow def with a per-state first-action deadline override
// (AC1: "per-state YAML override"). write-tests overrides to 45m; implementation
// has no override and must inherit the sweep default.
const WORKFLOW_DEF_YAML = `
id: dev-impl
name: Dev Implementation
initial: write-tests
states:
  - id: write-tests
    owner_role: test-author
    sla: 48h
    first_action_deadline: 45m
  - id: implementation
    owner_role: dev
    sla: 72h
  - id: done
    owner_role: steward
`;

// Capability policy shape mirrors config/capability-policy.yaml
// (escalation-gate PolicyBody/PolicyRole). `test-author` is exclusive (singleton
// — TestDrivenDevelopmentAgent); `dev` is multi-body (felix/igor/…).
const CAPABILITY_POLICY = {
  capabilities: [{ id: "linear:transition" }],
  containers: [
    { id: "dev", grants: ["linear:transition"] },
    { id: "steward", grants: ["linear:transition", "human:escalate"] },
  ],
  roles: [
    { id: "dev", requires: ["linear:transition"] },
    { id: "test-author", requires: ["linear:transition"], exclusive: true },
    { id: "steward", requires: ["human:escalate"] },
  ],
  bodies: [
    { id: "felix", container: "dev", fills_roles: ["dev"] },
    { id: "igor", container: "dev", fills_roles: ["dev"] },
    { id: "tdd", container: "dev", fills_roles: ["test-author"] },
    { id: "astrid", container: "steward", fills_roles: ["steward"] },
  ],
};

const MINUTE = 60_000;
const T0 = 1_700_000_000_000; // fixed epoch base — no wall clock in tests

let tmpDir: string;
let workflowDefPath: string;

/** A watchdog ticket record as produced by the (injected) data plane. */
type Ticket = {
  ticket: string;
  workflow: string;
  state: string;
  delegate: string;
  humanAssigned: boolean;
  labels: string[];
  dispatchDeliveredAtMs: number;
  dispatchUpdatedAt: string;
  firstOwnerActionAtMs: number | null;
  isReentry?: boolean;
  rungsFired?: number;
};

function ticket(overrides: Partial<Ticket>): Ticket {
  return {
    ticket: "AI-3001",
    workflow: "dev-impl",
    state: "write-tests",
    delegate: "tdd",
    humanAssigned: false,
    labels: ["wf:dev-impl", "state:write-tests"],
    dispatchDeliveredAtMs: T0,
    dispatchUpdatedAt: new Date(T0).toISOString(),
    firstOwnerActionAtMs: null,
    ...overrides,
  };
}

/** Build a fully-wired opts object with spy hooks the tests can assert on. */
function makeOpts(tickets: Ticket[], overrides: Record<string, unknown> = {}) {
  const redispatch = jest.fn(async (_d: unknown) => ({ admitted: true }));
  const escalateUnreachable = jest.fn(async (_d: unknown) => undefined);
  const reroute = jest.fn(async (_d: unknown) => undefined);
  const transition = jest.fn(async (_d: unknown) => undefined);
  const notify = jest.fn((_a: unknown) => undefined);
  return {
    spies: { redispatch, escalateUnreachable, reroute, transition, notify },
    opts: {
      authToken: "Bearer test",
      workflowDefPath,
      listTickets: async () => tickets,
      now: () => T0 + 60 * MINUTE, // 60m after dispatch — past the 45m deadline
      defaultDeadlineMs: 30 * MINUTE,
      maxRungs: 3,
      capabilityPolicy: CAPABILITY_POLICY,
      notify,
      redispatch,
      escalateUnreachable,
      reroute,
      transition,
      ...overrides,
    } as never,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2009-watchdog-"));
  workflowDefPath = path.join(tmpDir, "dev-impl.yaml");
  fs.writeFileSync(workflowDefPath, WORKFLOW_DEF_YAML, "utf8");
  if (typeof resetFirstActionWatchdogStateForTest === "function") {
    resetFirstActionWatchdogStateForTest();
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// AC1 — Deadline arming on dispatch delivery, per-state YAML override + default
// ════════════════════════════════════════════════════════════════════════════

describe("AC1: per-state deadline arms at dispatch delivery", () => {
  it("arms a deadline = deliveredAt + per-state override (write-tests: 45m from YAML)", async () => {
    const { opts } = makeOpts([ticket({})], {
      now: () => T0 + 10 * MINUTE, // within 45m — armed, not breached
    });
    await runFirstActionWatchdogSweep(opts);

    const ladder = getFirstActionWatchdogState().ladders.find(
      (l) => l.ticket === "AI-3001",
    );
    expect(ladder).toBeDefined();
    expect(Date.parse(ladder!.armedAt)).toBe(T0);
    // 45m override from the workflow def, NOT the 30m sweep default.
    expect(Date.parse(ladder!.deadlineAt)).toBe(T0 + 45 * MINUTE);
    expect(ladder!.rungsFired).toBe(0);
  });

  it("falls back to the sweep default deadline when the state has no YAML override", async () => {
    const { opts } = makeOpts([ticket({ state: "implementation", delegate: "igor" })], {
      now: () => T0 + 10 * MINUTE,
    });
    await runFirstActionWatchdogSweep(opts);

    const ladder = getFirstActionWatchdogState().ladders.find(
      (l) => l.ticket === "AI-3001",
    );
    // implementation has no first_action_deadline → inherit defaultDeadlineMs (30m)
    expect(Date.parse(ladder!.deadlineAt)).toBe(T0 + 30 * MINUTE);
  });

  it("does NOT fire any rung when the owner acted before the deadline", async () => {
    const { opts, spies } = makeOpts([
      ticket({ firstOwnerActionAtMs: T0 + 20 * MINUTE }), // acted at 20m < 45m
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(spies.escalateUnreachable).not.toHaveBeenCalled();
    expect(result.breached).toBe(0);
  });

  it("does NOT fire before the deadline even with no owner action yet", async () => {
    const { opts, spies } = makeOpts([ticket({})], {
      now: () => T0 + 30 * MINUTE, // 30m < 45m override
    });
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(result.breached).toBe(0);
    // still armed, awaiting the deadline
    expect(getFirstActionWatchdogState().armedCount).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 rung 1 — Deadline breach triggers an automatic re-dispatch (fresh wake)
// ════════════════════════════════════════════════════════════════════════════

describe("AC2 rung 1: breach → automatic re-dispatch", () => {
  it("re-dispatches the delegate when the deadline is breached with no owner action", async () => {
    const { opts, spies } = makeOpts([ticket({})]); // now = T0+60m > 45m deadline
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.breached).toBe(1);
    expect(spies.redispatch).toHaveBeenCalledTimes(1);
    expect(spies.redispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: "AI-3001", state: "write-tests", agent: "tdd" }),
    );
    // Each rung is logged in the ladder history.
    const ladder = getFirstActionWatchdogState().ladders.find((l) => l.ticket === "AI-3001");
    expect(ladder!.rungsFired).toBe(1);
    expect(ladder!.history.map((h) => h.rung)).toContain("redispatch");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Re-dispatch must bypass dispatch idempotency (genuine fresh wake,
//        AI-1969 admit semantics) — not suppressed as a duplicate.
// ════════════════════════════════════════════════════════════════════════════

describe("AC2: watchdog re-dispatch bypasses idempotency suppression", () => {
  const dispatch = {
    ticketKey: "linear-AI-3001",
    workflowState: "write-tests",
    agent: "tdd",
    updatedAt: new Date(T0).toISOString(),
  };

  it("an ordinary duplicate dispatch (same tuple + updatedAt) IS suppressed", () => {
    const store = new DispatchIdempotencyStore(":memory:");
    const first = store.checkAndRecord(
      dispatch.ticketKey, dispatch.workflowState, dispatch.agent, dispatch.updatedAt,
    );
    expect(first.suppressed).toBe(false); // admitted the first time

    const second = store.checkAndRecord(
      dispatch.ticketKey, dispatch.workflowState, dispatch.agent, dispatch.updatedAt,
    );
    expect(second.suppressed).toBe(true); // idempotency guard blocks the replay
  });

  it("redispatchViaWatchdog admits the SAME tuple past the idempotency guard", () => {
    const store = new DispatchIdempotencyStore(":memory:");
    // Seed a prior identical dispatch record.
    store.checkAndRecord(
      dispatch.ticketKey, dispatch.workflowState, dispatch.agent, dispatch.updatedAt,
    );
    // Sanity: it would be suppressed via the normal path (proven above).

    const result = redispatchViaWatchdog(store, dispatch);
    expect(result.admitted).toBe(true);
    expect(result.suppressed).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 rung 2 — After N failed rungs: mark delegate unreachable + alert ops
// ════════════════════════════════════════════════════════════════════════════

describe("AC2 rung 2: rung exhaustion → unreachable + ops alert", () => {
  it("marks the delegate unreachable and alerts the ops channel after maxRungs failed rungs", async () => {
    // rungsFired already at the cap from prior sweeps → this breach exhausts the ladder.
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })], { maxRungs: 3 });
    const result = await runFirstActionWatchdogSweep(opts);

    // Rung 1 (re-dispatch) is NOT re-attempted once exhausted.
    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(result.unreachable).toBe(1);

    // Ops alert carries ticket / state / delegate / history for the on-call human.
    expect(spies.notify).toHaveBeenCalledTimes(1);
    const alert = spies.notify.mock.calls[0][0] as Record<string, unknown>;
    expect(alert.ticket).toBe("AI-3001");
    expect(alert.state).toBe("write-tests");
    expect(alert.delegate).toBe("tdd");
    expect(Array.isArray(alert.history)).toBe(true);

    expect(spies.escalateUnreachable).toHaveBeenCalledTimes(1);
    const ladder = getFirstActionWatchdogState().ladders.find((l) => l.ticket === "AI-3001");
    expect(ladder!.unreachable).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 rung 3 — Optional re-route to a fallback body, respecting capability policy;
//               NEVER for singleton roles without a fallback.
// ════════════════════════════════════════════════════════════════════════════

describe("AC2 rung 3: re-route respects capability policy", () => {
  it("resolves a fallback body (≠ current delegate) for a multi-body role", () => {
    // dev is filled by felix + igor; current delegate igor → fallback felix.
    expect(resolveRerouteTarget(CAPABILITY_POLICY, "dev", "igor")).toBe("felix");
  });

  it("returns null for a singleton (exclusive) role — never re-route test-author", () => {
    expect(resolveRerouteTarget(CAPABILITY_POLICY, "test-author", "tdd")).toBeNull();
  });

  it("returns null when the role has no alternate body available", () => {
    // steward is filled only by astrid → no fallback.
    expect(resolveRerouteTarget(CAPABILITY_POLICY, "steward", "astrid")).toBeNull();
  });

  it("does NOT re-route a singleton-role ticket even at rung exhaustion", async () => {
    // write-tests → owner_role test-author (singleton). Exhausted ladder must
    // alert-only, never re-route.
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })], { maxRungs: 3 });
    await runFirstActionWatchdogSweep(opts);
    expect(spies.reroute).not.toHaveBeenCalled();
  });

  it("re-routes a multi-body-role ticket to the fallback at rung exhaustion", async () => {
    // implementation → owner_role dev (felix/igor). Delegate igor unreachable → felix.
    const { opts, spies } = makeOpts(
      [ticket({ state: "implementation", delegate: "igor", rungsFired: 3 })],
      { maxRungs: 3 },
    );
    await runFirstActionWatchdogSweep(opts);
    expect(spies.reroute).toHaveBeenCalledTimes(1);
    expect(spies.reroute).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: "AI-3001", fromAgent: "igor", toAgent: "felix", role: "dev" }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — NEVER auto-transitions state; NEVER fires on human/Matt-blocked tickets
// ════════════════════════════════════════════════════════════════════════════

describe("AC3: no auto-transition, no nudging human/Matt-blocked work", () => {
  it("never auto-transitions workflow state, even on a breached ticket", async () => {
    const { opts, spies } = makeOpts([ticket({})]);
    const result = await runFirstActionWatchdogSweep(opts);
    expect(result.breached).toBe(1);
    expect(spies.transition).not.toHaveBeenCalled();
    expect(result.transitions).toBe(0);
  });

  it("excludes human-assigned tickets (assignee is a human) from the ladder", async () => {
    const { opts, spies } = makeOpts([ticket({ humanAssigned: true })]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
    expect(result.humanExcluded).toBe(1);
    expect(result.breached).toBe(0);
    // Excluded tickets are not armed at all.
    expect(getFirstActionWatchdogState().ladders.find((l) => l.ticket === "AI-3001")).toBeUndefined();
  });

  it("excludes Matt-blocked tickets carrying a needs-human label", async () => {
    const { opts, spies } = makeOpts([
      ticket({ labels: ["wf:dev-impl", "state:write-tests", "needs-human"] }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(result.humanExcluded).toBe(1);
    expect(result.breached).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — Re-entry / revision dispatches get identical watchdog coverage
// ════════════════════════════════════════════════════════════════════════════

describe("AC4: re-entry/revision dispatches are covered identically to first-pass", () => {
  it("arms and ladders a re-entry dispatch the same as a first-pass dispatch", async () => {
    const { opts, spies } = makeOpts([
      ticket({ ticket: "AI-4001", isReentry: false }),
      ticket({ ticket: "AI-4002", isReentry: true }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.breached).toBe(2);
    expect(spies.redispatch).toHaveBeenCalledTimes(2);

    const state = getFirstActionWatchdogState();
    const first = state.ladders.find((l) => l.ticket === "AI-4001");
    const reentry = state.ladders.find((l) => l.ticket === "AI-4002");
    expect(first).toBeDefined();
    expect(reentry).toBeDefined();
    // Identical coverage: both armed at delivery, both fired rung 1.
    expect(reentry!.rungsFired).toBe(first!.rungsFired);
    expect(Date.parse(reentry!.deadlineAt) - Date.parse(reentry!.armedAt)).toBe(
      Date.parse(first!.deadlineAt) - Date.parse(first!.armedAt),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 (metrics half) — p4 distillation: per-state idle/dwell aggregates
// ════════════════════════════════════════════════════════════════════════════

describe("AC5: per-state idle/dwell aggregates for the metrics dashboard", () => {
  it("aggregates dwell (time in state) and idle (delivery → first action) per state", () => {
    const rows = [
      // write-tests: entered T0, first action at +40m, exited at +50m
      { state: "write-tests", enteredAtMs: T0, firstOwnerActionAtMs: T0 + 40 * MINUTE, exitedAtMs: T0 + 50 * MINUTE },
      // write-tests: entered T0, never acted, exited at +80m → idle == dwell
      { state: "write-tests", enteredAtMs: T0, firstOwnerActionAtMs: null, exitedAtMs: T0 + 80 * MINUTE },
      // implementation: entered T0, first action +10m, still open (exit null) → dwell to now
      { state: "implementation", enteredAtMs: T0, firstOwnerActionAtMs: T0 + 10 * MINUTE, exitedAtMs: null },
    ];
    const nowMs = T0 + 100 * MINUTE;
    const aggs = computePerStateDwellAggregates(rows, nowMs);

    const wt = aggs.find((a) => a.state === "write-tests");
    const impl = aggs.find((a) => a.state === "implementation");
    expect(wt).toBeDefined();
    expect(impl).toBeDefined();

    expect(wt!.count).toBe(2);
    // dwell = (50m) + (80m) = 130m ; idle = (40m) + (80m) = 120m
    expect(wt!.totalDwellMs).toBe((50 + 80) * MINUTE);
    expect(wt!.totalIdleMs).toBe((40 + 80) * MINUTE);
    expect(wt!.maxDwellMs).toBe(80 * MINUTE);

    // open row dwell measured to now (100m); idle = 10m
    expect(impl!.count).toBe(1);
    expect(impl!.totalDwellMs).toBe(100 * MINUTE);
    expect(impl!.totalIdleMs).toBe(10 * MINUTE);
  });
});
