/**
 * AI-2008 — Dispatch delivery acknowledgment + retry — no fire-and-forget wakes.
 *
 * Store-level contract for the loud-failure outcome (AC3).
 *
 * The operational event store is the operational-event-store of record (AC2:
 * "each attempt logged to the operational event store"; AC3: the exhaustion
 * warning must be a first-class, queryable outcome — not a stray log line).
 *
 * These tests exercise the EXISTING OperationalEventStore surface, so they fail
 * on assertions (not import errors): today `dispatch-undeliverable` is not a
 * recognized outcome, so `append` rejects it and it is not classified as an
 * error.
 *
 * AC mapping:
 *   AC3 — "After final retry failure: a `dispatch-undeliverable` warning is
 *          emitted (visible in /health warnings and /admin) ... loud, not a
 *          silent log line."
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OperationalEventStore,
  OPERATIONAL_EVENT_OUTCOMES,
} from "./store/operational-event-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2008-outcome-"));
  return path.join(dir, "operational-events.db");
}

describe("AI-2008 AC3: dispatch-undeliverable is a first-class operational outcome", () => {
  let dbPath: string;
  let store: OperationalEventStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new OperationalEventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("registers `dispatch-undeliverable` in the outcome vocabulary", () => {
    // A grep-able, exhaustion warning must be a declared outcome so it can be
    // queried and surfaced — not a free-text log line.
    expect(OPERATIONAL_EVENT_OUTCOMES as readonly string[]).toContain(
      "dispatch-undeliverable",
    );
  });

  it("accepts and round-trips a dispatch-undeliverable event naming ticket/state/delegate/gateway", () => {
    expect(() =>
      store.append({
        outcome: "dispatch-undeliverable",
        agent: "igor",
        key: "linear-AI-2008",
        sessionKey: "linear-AI-2008",
        workflowState: "implementation",
        attemptCount: 3,
        detail: {
          ticket: "AI-2008",
          state: "implementation",
          delegate: "igor",
          gateway: "grover",
        },
      }),
    ).not.toThrow();

    const events = store.query({ key: "linear-AI-2008" });
    const undeliverable = events.find((e) => e.outcome === "dispatch-undeliverable");
    expect(undeliverable).toBeDefined();
    const detail = undeliverable!.detail as Record<string, unknown>;
    expect(detail.ticket).toBe("AI-2008");
    expect(detail.state).toBe("implementation");
    expect(detail.delegate).toBe("igor");
    expect(detail.gateway).toBe("grover");
  });

  it("classifies dispatch-undeliverable as an error outcome (surfaces as lastError)", () => {
    // No engagement/success events — the snapshot's lastError must still point
    // at the undeliverable event, proving it is treated as a failure, not noise.
    store.append({
      outcome: "dispatch-undeliverable",
      agent: "igor",
      key: "linear-AI-2008",
      sessionKey: "linear-AI-2008",
      attemptCount: 3,
    });
    const snapshot = store.snapshot({ key: "linear-AI-2008" });
    expect(snapshot.lastError).toBeDefined();
    expect(snapshot.lastError!.outcome).toBe("dispatch-undeliverable");
  });
});
