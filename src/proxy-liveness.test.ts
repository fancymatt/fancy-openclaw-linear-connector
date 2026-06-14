import { describe, it, expect } from "@jest/globals";
import { evaluate, initialState, type MonitorState } from "./proxy-liveness.js";

const T0 = 1_000_000_000_000;
const opts = { failureThreshold: 3, reminderIntervalMs: 60 * 60 * 1000 };

describe("G-15 proxy-liveness evaluate()", () => {
  it("stays up and silent while healthy", () => {
    let s = initialState();
    for (let i = 0; i < 5; i++) {
      const r = evaluate(s, true, T0 + i, opts);
      expect(r.action).toBe("none");
      expect(r.next.status).toBe("up");
      s = r.next;
    }
  });

  it("holds silent under the failure threshold (hysteresis)", () => {
    let s = initialState();
    const r1 = evaluate(s, false, T0, opts);
    expect(r1.action).toBe("none");
    expect(r1.next.status).toBe("up");
    expect(r1.next.consecutiveFailures).toBe(1);

    const r2 = evaluate(r1.next, false, T0 + 1, opts);
    expect(r2.action).toBe("none");
    expect(r2.next.consecutiveFailures).toBe(2);
  });

  it("declares down and alerts exactly once at the threshold", () => {
    let s = initialState();
    s = evaluate(s, false, T0, opts).next; // 1
    s = evaluate(s, false, T0 + 1, opts).next; // 2
    const r3 = evaluate(s, false, T0 + 2, opts); // 3 -> threshold
    expect(r3.action).toBe("alert-down");
    expect(r3.next.status).toBe("down");
  });

  it("does not re-alert every tick while down (no spam)", () => {
    let down: MonitorState = { status: "down", consecutiveFailures: 3, lastAlertAt: T0 };
    const r = evaluate(down, false, T0 + 60_000, opts); // 1 min later
    expect(r.action).toBe("none");
    expect(r.next.status).toBe("down");
  });

  it("re-alerts on the slow reminder cadence", () => {
    const down: MonitorState = { status: "down", consecutiveFailures: 3, lastAlertAt: T0 };
    const r = evaluate(down, false, T0 + opts.reminderIntervalMs, opts);
    expect(r.action).toBe("alert-reminder");
    expect(r.next.lastAlertAt).toBe(T0 + opts.reminderIntervalMs);
  });

  it("alerts once on recovery and resets counters", () => {
    const down: MonitorState = { status: "down", consecutiveFailures: 5, lastAlertAt: T0 };
    const r = evaluate(down, true, T0 + 5000, opts);
    expect(r.action).toBe("alert-recovered");
    expect(r.next.status).toBe("up");
    expect(r.next.consecutiveFailures).toBe(0);
  });

  it("a single success clears a partial failure streak", () => {
    const partial: MonitorState = { status: "up", consecutiveFailures: 2, lastAlertAt: 0 };
    const r = evaluate(partial, true, T0, opts);
    expect(r.action).toBe("none");
    expect(r.next.consecutiveFailures).toBe(0);
  });
});
