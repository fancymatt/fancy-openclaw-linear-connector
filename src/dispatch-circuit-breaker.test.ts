/**
 * Tests for DispatchCircuitBreaker — transition-stuck alert suppression
 * on ad-hoc (label-less / non-wf:*) tickets.
 *
 * Covers INF-94: the dispatch-circuit-breaker fires `transition-stuck` on
 * ad-hoc tickets that have no workflow and therefore no transitions to advance.
 * These tests assert the fix: ad-hoc tickets bypass the transition-stuck check,
 * while governed wf:* tickets continue to alert when genuinely stalled.
 *
 * Acceptance criteria:
 *   AC1: An ad-hoc ticket (no wf: label) with an active delegate does NOT
 *        emit transition-stuck warnings after any number of cadence wakes.
 *   AC2: Genuine workflow tickets (wf:*) DO trip transition-stuck when a
 *        real transition stalls (no regression).
 *   AC3: For ad-hoc tickets, "progress" is keyed on delegate activity
 *        (comment / updatedAt / ack), not on state transition.
 *   AC4: Regression test: ad-hoc ticket in Doing with delegate receiving
 *        ≥3 wakes and posting a comment → zero transition-stuck emissions.
 */

import { DispatchCircuitBreaker } from "./dispatch-circuit-breaker.js";

function wfLabels(state: string): string[] {
  return ["wf:dev-impl", `state:${state}`];
}

function adhocLabels(): string[] {
  return [];
}

describe("DispatchCircuitBreaker (INF-94)", () => {
  let breaker: DispatchCircuitBreaker;

  beforeEach(() => {
    breaker = new DispatchCircuitBreaker({ maxWakesBeforeAlert: 3 });
  });

  // ── AC1 / AC4: Ad-hoc tickets ──────────────────────────────────────────

  it("AC1: ad-hoc ticket with active delegate does not alert after multiple wakes", () => {
    const ticket = "DOCS-4";
    breaker.recordWake(ticket, adhocLabels());

    // Simulate delegate posting a comment (activity signal).
    breaker.recordDelegateActivity(ticket);

    // Record additional wakes — should not trigger transition-stuck.
    breaker.recordWake(ticket, adhocLabels());
    breaker.recordWake(ticket, adhocLabels());
    breaker.recordWake(ticket, adhocLabels());

    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(false);
    expect(result.stateLabel).toBeNull();
    expect(result.reason).toContain("ad-hoc");
  });

  it("AC4: ad-hoc ticket in Doing with delegate receives ≥3 wakes + comment — zero transition-stuck", () => {
    const ticket = "INF-94-test";
    // Ad-hoc ticket: labels do NOT include wf:*
    const labels: string[] = [];

    // Simulate 3+ cadence wakes for an ad-hoc ticket in Doing
    breaker.recordWake(ticket, labels); // wake 1
    breaker.recordDelegateActivity(ticket); // delegate posts a comment
    breaker.recordWake(ticket, labels); // wake 2
    breaker.recordWake(ticket, labels); // wake 3
    breaker.recordWake(ticket, labels); // wake 4 — past the alert threshold

    // Delegate is actively working — should NOT transition-stuck
    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(false);
    expect(result.wakeCount).toBeGreaterThanOrEqual(3);
    expect(result.stateLabel).toBeNull();
  });

  it("AC3: ad-hoc ticket progress is keyed on delegate activity, not state transition", () => {
    const ticket = "DOCS-5";
    breaker.recordWake(ticket, adhocLabels());

    // Without any delegate activity, an ad-hoc ticket that received wakes
    // should NOT transition-stuck (it has no wf: label to judge against).
    const noActivityResult = breaker.evaluate(ticket);
    expect(noActivityResult.shouldAlert).toBe(false);
    expect(noActivityResult.reason).toContain("ad-hoc");

    // With delegate activity recorded, still no alert.
    breaker.recordDelegateActivity(ticket);
    const withActivityResult = breaker.evaluate(ticket);
    expect(withActivityResult.shouldAlert).toBe(false);
  });

  it("ad-hoc ticket without any delegate activity after 5 wakes still does not alert", () => {
    // Even without delegate activity, an ad-hoc ticket should not trip
    // transition-stuck — it has no transitions to make.
    const ticket = "CHORE-42";
    for (let i = 0; i < 5; i++) {
      breaker.recordWake(ticket, adhocLabels());
    }
    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(false);
    expect(result.stateLabel).toBeNull();
  });

  // ── AC2: wf:* tickets (no regression) ──────────────────────────────────

  it("AC2: wf:* ticket with no progress after 3+ wakes alerts transition-stuck", () => {
    const ticket = "AI-1000";
    breaker.recordWake(ticket, wfLabels("write-tests")); // wake 1
    breaker.recordWake(ticket, wfLabels("write-tests")); // wake 2
    breaker.recordWake(ticket, wfLabels("write-tests")); // wake 3
    // No delegate activity and no transition — genuinely stalled

    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(true);
    expect(result.stateLabel).toBe("wf:dev-impl");
    expect(result.wakeCount).toBe(3);
  });

  it("AC2: wf:* ticket with delegate activity does NOT alert", () => {
    const ticket = "AI-1001";
    breaker.recordWake(ticket, wfLabels("implementation"));
    breaker.recordDelegateActivity(ticket); // delegate commented / transitioned

    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(false);
  });

  it("AC2: wf:* ticket with few wakes below threshold does not alert", () => {
    const ticket = "AI-1002";
    breaker.recordWake(ticket, wfLabels("write-tests"));
    breaker.recordWake(ticket, wfLabels("write-tests"));

    // Only 2 wakes — below the threshold of 3, no alert even if stalled.
    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(false);
    expect(result.wakeCount).toBe(2);
  });

  it("AC2: wf:* ticket alerts after threshold even with multiple state labels", () => {
    const ticket = "AI-1003";
    const labels = ["wf:dev-impl", "state:in-review", "ui-impact"];
    for (let i = 0; i < 4; i++) {
      breaker.recordWake(ticket, labels);
    }
    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(true);
    expect(result.stateLabel).toBe("wf:dev-impl");
  });

  // ── Ad-hoc tickets with mixing of different label states ───────────────

  it("ticket with non-wf labels (ui-impact only) treated as ad-hoc, no alert", () => {
    // A ticket that has labels but none matching wf:* should be treated as ad-hoc.
    const ticket = "TASK-1";
    const nonWfLabels = ["ui-impact", "state:doing", "bug"];
    for (let i = 0; i < 4; i++) {
      breaker.recordWake(ticket, nonWfLabels);
    }
    const result = breaker.evaluate(ticket);
    expect(result.shouldAlert).toBe(false);
    expect(result.stateLabel).toBeNull();
  });

  // ── reset behavior ─────────────────────────────────────────────────────

  it("reset clears tracking for a ticket", () => {
    const ticket = "AI-1004";
    breaker.recordWake(ticket, wfLabels("write-tests"));
    breaker.recordWake(ticket, wfLabels("write-tests"));
    breaker.recordWake(ticket, wfLabels("write-tests"));

    expect(breaker.evaluate(ticket).shouldAlert).toBe(true);

    breaker.reset(ticket);
    expect(breaker.evaluate(ticket).shouldAlert).toBe(false);
    expect(breaker.evaluate(ticket).wakeCount).toBe(0);
  });

  // ── Multiple tickets tracked independently ─────────────────────────────

  it("tracks multiple tickets independently (ad-hoc silent, wf:* alerts)", () => {
    const adhoc = "CHORE-1";
    const wfTicket = "AI-2000";

    breaker.recordWake(adhoc, []);
    breaker.recordWake(wfTicket, wfLabels("write-tests"));
    breaker.recordWake(adhoc, []);
    breaker.recordWake(wfTicket, wfLabels("write-tests"));
    breaker.recordWake(adhoc, []);
    breaker.recordWake(wfTicket, wfLabels("write-tests"));

    expect(breaker.evaluate(adhoc).shouldAlert).toBe(false);
    expect(breaker.evaluate(wfTicket).shouldAlert).toBe(true);

    // Delegate activity on the wf ticket should clear its alert but leave ad-hoc unchanged.
    breaker.recordDelegateActivity(wfTicket);
    expect(breaker.evaluate(wfTicket).shouldAlert).toBe(false);
    expect(breaker.evaluate(adhoc).shouldAlert).toBe(false);
  });
});
