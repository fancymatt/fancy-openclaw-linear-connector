/**
 * INF-320 — Remediation actor: executes the auto/confirm remediation policy
 * per typed failure_class.
 *
 * These are FAILING tests written before implementation (TDD write-tests state).
 * They define the contract the implementer (Igor) must satisfy. Every test maps
 * back to a verbatim acceptance criterion captured at intake (astrid,
 * 2026-07-22T17:38:48.885Z); the AC id is called out in each describe/it.
 *
 * Contract under test — a new module `./remediation-actor.ts` exporting:
 *   - executeRemediation(failureClass, context): Promise<RemediationResult>
 *       Given a typed failure_class, takes the mapped remediation action,
 *       honoring the AUTO-vs-CONFIRM policy and retry caps.
 *   - getRemediationConfig(): RemediationConfig
 *       Returns the current retry cap K and auto/confirm classification.
 *
 * and a types module `./remediation-types.ts` exporting:
 *   - FailureClass (discriminated union of all failure_class values)
 *   - RemediationAction (union of all action kinds)
 *   - RemediationClass = "AUTO" | "CONFIRM"
 *   - RemediationContext, RemediationResult, RemediationConfig
 *
 * and a state module `./remediation-state.ts` exporting:
 *   - recordRemediation(result): void — persists the action record
 *   - getRemediationHistory(ticketId?): RemediationRecord[]
 *   - getRemediationHealth(): RemediationHealth — liveness for /health
 *   - resetRemediationStateForTest(): void
 *
 * The action side-effects (re-fire dispatch, retry delivery, probe gateway,
 * re-resolve session key, redispatch, re-wake agent, re-seat delegate, nudge,
 * escalate, restart session) are injected via the context so the policy logic
 * is tested in isolation from I/O — the same injection style as the
 * first-action watchdog and SLA sweep.
 */

import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";

// The contract modules do not exist yet — load them dynamically so each test
// enumerates as an individual RED (with a clear message per AC) instead of the
// whole suite failing to collect. Once the modules land, these bindings resolve
// and the assertions become the real spec.
/* eslint-disable @typescript-eslint/no-explicit-any */
let executeRemediation: any;
let getRemediationConfig: any;
let recordRemediation: any;
let getRemediationHistory: any;
let getRemediationHealth: any;
let resetRemediationStateForTest: any;

beforeAll(async () => {
  const actor = await import("./remediation-actor.js");
  ({ executeRemediation, getRemediationConfig } = actor as any);
  const state = await import("./remediation-state.js");
  ({ recordRemediation, getRemediationHistory, getRemediationHealth, resetRemediationStateForTest } = state as any);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const T0_ISO = "2026-07-22T17:38:48.885Z";

/** Build a RemediationContext with sensible defaults for tests. */
function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "INF-320",
    agentId: "igor",
    sessionKey: "linear-INF-320",
    attemptCount: 0,
    maxRetries: 3, // K = 3
    now: () => new Date(T0_ISO),
    ...overrides,
  } as any;
}

beforeEach(() => {
  if (typeof resetRemediationStateForTest === "function") {
    resetRemediationStateForTest();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// AC1 — Per failure_class, executes the INF-315-mapped action
// ════════════════════════════════════════════════════════════════════════════

describe("AC1: each failure_class maps to the correct remediation action", () => {
  it("connector-didnt-fire → re-fire dispatch (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "connector-didnt-fire" },
      makeContext(),
    );
    expect(result.action.kind).toBe("re-fire-dispatch");
    expect(result.actionClass).toBe("AUTO");
  });

  it("delivery-failed → retry delivery + probe gateway (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "delivery-failed" },
      makeContext(),
    );
    expect(result.action.kind).toBe("retry-delivery-and-probe-gateway");
    expect(result.actionClass).toBe("AUTO");
  });

  it("wrong-target → re-resolve session key + redispatch (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "wrong-target" },
      makeContext(),
    );
    expect(result.action.kind).toBe("re-resolve-session-key-and-redispatch");
    expect(result.actionClass).toBe("AUTO");
  });

  it("behavioral-noop → redispatch with stronger prompt (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "behavioral-noop" },
      makeContext(),
    );
    expect(result.action.kind).toBe("redispatch-with-stronger-prompt");
    expect(result.actionClass).toBe("AUTO");
  });

  it("stuck → re-wake agent (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "stuck" },
      makeContext(),
    );
    expect(result.action.kind).toBe("re-wake-agent");
    expect(result.actionClass).toBe("AUTO");
  });

  it("delegate-nulled → re-seat delegate + redispatch (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "delegate-nulled" },
      makeContext(),
    );
    expect(result.action.kind).toBe("re-seat-delegate-and-redispatch");
    expect(result.actionClass).toBe("AUTO");
  });

  it("verb-not-sent with hasSideEffectEvidence=true → auto-advance (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "verb-not-sent", hasSideEffectEvidence: true },
      makeContext(),
    );
    expect(result.action.kind).toBe("auto-advance");
    expect(result.actionClass).toBe("AUTO");
  });

  it("verb-not-sent with hasSideEffectEvidence=false → nudge for verb (CONFIRM)", async () => {
    const result = await executeRemediation(
      { type: "verb-not-sent", hasSideEffectEvidence: false },
      makeContext(),
    );
    expect(result.action.kind).toBe("nudge-for-verb");
    expect(result.actionClass).toBe("CONFIRM");
  });

  it("agent-broken → restart session (CONFIRM — user-gated)", async () => {
    const result = await executeRemediation(
      { type: "agent-broken" },
      makeContext(),
    );
    expect(result.action.kind).toBe("restart-session");
    expect(result.actionClass).toBe("CONFIRM");
  });

  it("agent-broke-mid-task → restart session (CONFIRM — user-gated)", async () => {
    const result = await executeRemediation(
      { type: "agent-broke-mid-task" },
      makeContext(),
    );
    expect(result.action.kind).toBe("restart-session");
    expect(result.actionClass).toBe("CONFIRM");
  });

  it("token-401 → refresh token (AUTO)", async () => {
    const result = await executeRemediation(
      { type: "token-401" },
      makeContext(),
    );
    expect(result.action.kind).toBe("refresh-token");
    expect(result.actionClass).toBe("AUTO");
  });

  it("healthy-suppressed:* → no action", async () => {
    const result = await executeRemediation(
      { type: "healthy-suppressed", subtype: "quiet-period" },
      makeContext(),
    );
    expect(result.action.kind).toBe("no-action");
    expect(result.outcome).toBe("no-action");
  });

  it("healthy-suppressed with any subtype string → no action", async () => {
    const result = await executeRemediation(
      { type: "healthy-suppressed", subtype: "rate-limit" },
      makeContext(),
    );
    expect(result.action.kind).toBe("no-action");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — AUTO actions are retry-capped (max K, config) then escalate
// ════════════════════════════════════════════════════════════════════════════

describe("AC2: AUTO actions are retry-capped then escalate", () => {
  it("executes the AUTO action when attemptCount < maxRetries", async () => {
    const result = await executeRemediation(
      { type: "connector-didnt-fire" },
      makeContext({ attemptCount: 0, maxRetries: 3 }),
    );
    expect(result.outcome).toBe("executed");
    expect(result.action.kind).toBe("re-fire-dispatch");
  });

  it("executes at attemptCount = maxRetries - 1 (last allowed retry)", async () => {
    const result = await executeRemediation(
      { type: "delivery-failed" },
      makeContext({ attemptCount: 2, maxRetries: 3 }),
    );
    expect(result.outcome).toBe("executed");
  });

  it("escalates when attemptCount reaches maxRetries (K)", async () => {
    const result = await executeRemediation(
      { type: "connector-didnt-fire" },
      makeContext({ attemptCount: 3, maxRetries: 3 }),
    );
    expect(result.outcome).toBe("escalated");
    expect(result.action.kind).toBe("escalate");
  });

  it("continues to escalate when attemptCount exceeds maxRetries", async () => {
    const result = await executeRemediation(
      { type: "behavioral-noop" },
      makeContext({ attemptCount: 5, maxRetries: 3 }),
    );
    expect(result.outcome).toBe("escalated");
    expect(result.action.kind).toBe("escalate");
  });

  it("escalation applies to all AUTO failure_class types", async () => {
    const autoTypes = [
      { type: "connector-didnt-fire" },
      { type: "delivery-failed" },
      { type: "wrong-target" },
      { type: "behavioral-noop" },
      { type: "stuck" },
      { type: "delegate-nulled" },
    ];
    for (const fc of autoTypes) {
      const result = await executeRemediation(fc, makeContext({ attemptCount: 3, maxRetries: 3 }));
      expect(result.outcome).toBe("escalated");
      expect(result.action.kind).toBe("escalate");
    }
  });

  it("respects per-context maxRetries override (K=5)", async () => {
    const result = await executeRemediation(
      { type: "stuck" },
      makeContext({ attemptCount: 3, maxRetries: 5 }),
    );
    // attemptCount 3 < maxRetries 5 → still executing, not escalated
    expect(result.outcome).toBe("executed");
    expect(result.action.kind).toBe("re-wake-agent");
  });

  it("default retry cap K is 3", () => {
    const config = getRemediationConfig();
    expect(config.maxRetries).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — CONFIRM-class actions are NEVER auto-executed
// ════════════════════════════════════════════════════════════════════════════

describe("AC3: CONFIRM-class actions are never auto-executed", () => {
  it("agent-broken surfaces as confirm-required, never executed", async () => {
    const result = await executeRemediation(
      { type: "agent-broken" },
      makeContext({ attemptCount: 0, maxRetries: 3 }),
    );
    expect(result.actionClass).toBe("CONFIRM");
    expect(result.outcome).toBe("confirm-required");
    expect(result.action.kind).toBe("restart-session");
  });

  it("agent-broke-mid-task surfaces as confirm-required, never executed", async () => {
    const result = await executeRemediation(
      { type: "agent-broke-mid-task" },
      makeContext({ attemptCount: 0, maxRetries: 3 }),
    );
    expect(result.actionClass).toBe("CONFIRM");
    expect(result.outcome).toBe("confirm-required");
  });

  it("verb-not-sent without side-effect evidence surfaces as confirm-required", async () => {
    const result = await executeRemediation(
      { type: "verb-not-sent", hasSideEffectEvidence: false },
      makeContext({ attemptCount: 0, maxRetries: 3 }),
    );
    expect(result.actionClass).toBe("CONFIRM");
    expect(result.outcome).toBe("confirm-required");
  });

  it("CONFIRM actions never have outcome 'executed' regardless of attemptCount", async () => {
    // Even at high attempt counts, CONFIRM actions don't escalate to auto-fire.
    const confirmTypes = [
      { type: "agent-broken" },
      { type: "agent-broke-mid-task" },
      { type: "verb-not-sent", hasSideEffectEvidence: false },
    ];
    for (const fc of confirmTypes) {
      const result = await executeRemediation(fc, makeContext({ attemptCount: 10, maxRetries: 3 }));
      expect(result.outcome).not.toBe("executed");
    }
  });

  it("CONFIRM actions are immune to retry-cap escalation (still confirm-required, not escalated)", async () => {
    const result = await executeRemediation(
      { type: "agent-broken" },
      makeContext({ attemptCount: 10, maxRetries: 3 }),
    );
    // CONFIRM actions don't get silently escalated — they always surface for human decision.
    expect(result.outcome).toBe("confirm-required");
  });

  it("CONFIRM result includes context surfaceable by the UI for user-initiated action", async () => {
    const ctx = makeContext({ ticketId: "INF-999", agentId: "felix" });
    const result = await executeRemediation(
      { type: "agent-broken" },
      ctx,
    );
    expect(result.context).toBeDefined();
    expect(result.context.ticketId).toBe("INF-999");
    expect(result.context.agentId).toBe("felix");
    // The action kind tells the UI what confirmation dialog to surface.
    expect(result.action.kind).toBe("restart-session");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — Every action is recorded (action, timestamp, triggering failure_class, outcome)
// ════════════════════════════════════════════════════════════════════════════

describe("AC4: every action is recorded for observability", () => {
  it("executeRemediation records the action on invocation", async () => {
    const result = await executeRemediation(
      { type: "connector-didnt-fire" },
      makeContext({ ticketId: "INF-400" }),
    );
    recordRemediation(result);

    const history = getRemediationHistory("INF-400");
    expect(history.length).toBeGreaterThanOrEqual(1);
    const rec = history[0];
    expect(rec.actionKind).toBe("re-fire-dispatch");
    expect(rec.failureClass).toBe("connector-didnt-fire");
    expect(rec.outcome).toBe("executed");
  });

  it("records carry a timestamp", async () => {
    const result = await executeRemediation(
      { type: "delivery-failed" },
      makeContext({ ticketId: "INF-401" }),
    );
    recordRemediation(result);

    const rec = getRemediationHistory("INF-401")[0];
    expect(rec.timestamp).toBeDefined();
    expect(typeof rec.timestamp).toBe("string");
    // Must be ISO-parseable.
    expect(Date.parse(rec.timestamp)).not.toBeNaN();
  });

  it("records carry the triggering failure_class", async () => {
    const result = await executeRemediation(
      { type: "delegate-nulled" },
      makeContext({ ticketId: "INF-402" }),
    );
    recordRemediation(result);

    const rec = getRemediationHistory("INF-402")[0];
    expect(rec.failureClass).toBe("delegate-nulled");
  });

  it("records carry attemptCount", async () => {
    const result = await executeRemediation(
      { type: "stuck" },
      makeContext({ ticketId: "INF-403", attemptCount: 2 }),
    );
    recordRemediation(result);

    const rec = getRemediationHistory("INF-403")[0];
    expect(rec.attemptCount).toBe(2);
  });

  it("history is retrievable filtered by ticketId", async () => {
    const r1 = await executeRemediation({ type: "stuck" }, makeContext({ ticketId: "INF-410" }));
    const r2 = await executeRemediation({ type: "delivery-failed" }, makeContext({ ticketId: "INF-411" }));
    recordRemediation(r1);
    recordRemediation(r2);

    const h410 = getRemediationHistory("INF-410");
    const h411 = getRemediationHistory("INF-411");
    expect(h410.every((r: any) => r.ticketId === "INF-410")).toBe(true);
    expect(h411.every((r: any) => r.ticketId === "INF-411")).toBe(true);
  });

  it("history returns chronological order (oldest first)", async () => {
    const r1 = await executeRemediation({ type: "stuck" }, makeContext({ ticketId: "INF-420", now: () => new Date("2026-07-22T10:00:00Z") }));
    recordRemediation(r1);
    const r2 = await executeRemediation({ type: "delivery-failed" }, makeContext({ ticketId: "INF-420", now: () => new Date("2026-07-22T11:00:00Z") }));
    recordRemediation(r2);
    const r3 = await executeRemediation({ type: "behavioral-noop" }, makeContext({ ticketId: "INF-420", now: () => new Date("2026-07-22T12:00:00Z") }));
    recordRemediation(r3);

    const history = getRemediationHistory("INF-420");
    expect(history.length).toBe(3);
    expect(Date.parse(history[0].timestamp)).toBeLessThanOrEqual(Date.parse(history[1].timestamp));
    expect(Date.parse(history[1].timestamp)).toBeLessThanOrEqual(Date.parse(history[2].timestamp));
  });

  it("escalated actions are also recorded", async () => {
    const result = await executeRemediation(
      { type: "connector-didnt-fire" },
      makeContext({ ticketId: "INF-430", attemptCount: 3, maxRetries: 3 }),
    );
    recordRemediation(result);

    const rec = getRemediationHistory("INF-430")[0];
    expect(rec.outcome).toBe("escalated");
    expect(rec.actionKind).toBe("escalate");
  });

  it("confirm-required actions are also recorded", async () => {
    const result = await executeRemediation(
      { type: "agent-broken" },
      makeContext({ ticketId: "INF-431" }),
    );
    recordRemediation(result);

    const rec = getRemediationHistory("INF-431")[0];
    expect(rec.outcome).toBe("confirm-required");
    expect(rec.actionClass).toBe("CONFIRM");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — Idempotent/safe under repeated invocation
// ════════════════════════════════════════════════════════════════════════════

describe("AC5: idempotent/safe under repeated invocation", () => {
  it("same failure_class produces the same action mapping on repeated calls", async () => {
    const ctx = makeContext({ attemptCount: 0, maxRetries: 3 });
    const r1 = await executeRemediation({ type: "delivery-failed" }, ctx);
    const r2 = await executeRemediation({ type: "delivery-failed" }, ctx);
    expect(r1.action.kind).toBe(r2.action.kind);
    expect(r1.actionClass).toBe(r2.actionClass);
  });

  it("healthy-suppressed always returns no-action regardless of attemptCount", async () => {
    const ctx = makeContext({ maxRetries: 3 });
    for (const attempt of [0, 1, 5, 100]) {
      const result = await executeRemediation(
        { type: "healthy-suppressed", subtype: "quiet" },
        { ...ctx, attemptCount: attempt },
      );
      expect(result.action.kind).toBe("no-action");
      expect(result.outcome).toBe("no-action");
    }
  });

  it("healthy-suppressed is exempt from escalation", async () => {
    const result = await executeRemediation(
      { type: "healthy-suppressed", subtype: "rate-limit" },
      makeContext({ attemptCount: 99, maxRetries: 3 }),
    );
    expect(result.outcome).not.toBe("escalated");
    expect(result.action.kind).toBe("no-action");
  });

  it("result includes an ISO timestamp", async () => {
    const result = await executeRemediation(
      { type: "stuck" },
      makeContext({ now: () => new Date(T0_ISO) }),
    );
    expect(result.recordedAt).toBeDefined();
    expect(typeof result.recordedAt).toBe("string");
    expect(Date.parse(result.recordedAt)).not.toBeNaN();
  });

  it("result echoes the context (ticketId, agentId)", async () => {
    const ctx = makeContext({ ticketId: "INF-500", agentId: "sage" });
    const result = await executeRemediation({ type: "stuck" }, ctx);
    expect(result.context.ticketId).toBe("INF-500");
    expect(result.context.agentId).toBe("sage");
  });

  it("same verb-not-sent + evidence=true always maps to auto-advance", async () => {
    const ctx = makeContext();
    const r1 = await executeRemediation({ type: "verb-not-sent", hasSideEffectEvidence: true }, ctx);
    const r2 = await executeRemediation({ type: "verb-not-sent", hasSideEffectEvidence: true }, ctx);
    expect(r1.action.kind).toBe("auto-advance");
    expect(r2.action.kind).toBe("auto-advance");
  });

  it("same verb-not-sent + evidence=false always maps to nudge (CONFIRM)", async () => {
    const ctx = makeContext();
    const r1 = await executeRemediation({ type: "verb-not-sent", hasSideEffectEvidence: false }, ctx);
    const r2 = await executeRemediation({ type: "verb-not-sent", hasSideEffectEvidence: false }, ctx);
    expect(r1.action.kind).toBe("nudge-for-verb");
    expect(r2.action.kind).toBe("nudge-for-verb");
    expect(r1.actionClass).toBe("CONFIRM");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 (liveness half) — getRemediationHealth() for /health surfacing
// ════════════════════════════════════════════════════════════════════════════

describe("AC4 liveness: getRemediationHealth() exposes observability data", () => {
  it("returns totalActions count starting at 0 after reset", () => {
    resetRemediationStateForTest();
    const health = getRemediationHealth();
    expect(health.totalActions).toBe(0);
  });

  it("returns recentActions array reflecting recorded actions", async () => {
    const result = await executeRemediation(
      { type: "stuck" },
      makeContext({ ticketId: "INF-600" }),
    );
    recordRemediation(result);

    const health = getRemediationHealth();
    expect(health.totalActions).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(health.recentActions)).toBe(true);
    expect(health.recentActions.length).toBeGreaterThanOrEqual(1);
  });
});
