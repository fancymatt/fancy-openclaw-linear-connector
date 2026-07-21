/**
 * AI-1799 AC1 + AC3 — Enrolled-tickets mirror store.
 *
 * Tests the durable sqlite mirror of "which tickets are enrolled in which
 * workflow, in which state, since when" and the reconcile entry point.
 *
 * AC1: A ticket enrolling via bootstrap appears in the mirror with workflow,
 *      entry state, delegate, and enrolled_at; every proxy-applied transition
 *      updates state/delegate/entered_state_at; terminal disposition marks
 *      the row terminal without deleting it.
 * AC3: A reconcile entry point exists that, given the authoritative Linear
 *      label state for a ticket, corrects a missing or stale mirror row.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnrolledTicketsStore } from "./enrolled-tickets-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrolled-tickets-test-"));
  return path.join(dir, "enrolled.db");
}

describe("AI-1799 AC1: EnrolledTicketsStore — mirror lifecycle", () => {
  let dbPath: string;
  let store: EnrolledTicketsStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new EnrolledTicketsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("enroll() creates a mirror row with workflow, entry state, delegate, and enrolled_at", () => {
    const before = Date.now();
    store.enroll({
      ticketId: "AI-1001",
      workflow: "dev-impl",
      state: "intake",
      delegate: "ai",
    });
    const after = Date.now();

    const row = store.getByTicketId("AI-1001");
    expect(row).not.toBeNull();
    expect(row!.ticket_id).toBe("AI-1001");
    expect(row!.workflow).toBe("dev-impl");
    expect(row!.state).toBe("intake");
    expect(row!.delegate).toBe("ai");
    expect(row!.terminal).toBe(0);
    const enrolledMs = new Date(row!.enrolled_at).getTime();
    expect(enrolledMs).toBeGreaterThanOrEqual(before);
    expect(enrolledMs).toBeLessThanOrEqual(after);
  });

  it("enroll() is idempotent — re-enrolling an enrolled ticket does not duplicate the row", () => {
    store.enroll({ ticketId: "AI-1002", workflow: "dev-impl", state: "intake", delegate: "ai" });
    store.enroll({ ticketId: "AI-1002", workflow: "dev-impl", state: "intake", delegate: "ai" });

    const all = store.getAll();
    expect(all.filter((r) => r.ticket_id === "AI-1002")).toHaveLength(1);
  });

  it("recordTransition() updates state, delegate, and entered_state_at on a proxy-applied transition", () => {
    store.enroll({ ticketId: "AI-1003", workflow: "dev-impl", state: "intake", delegate: "ai" });
    const beforeTransition = Date.now();

    store.recordTransition({
      ticketId: "AI-1003",
      toState: "write-tests",
      delegate: "tdd",
      eventKind: "tests-ready",
    });

    const afterTransition = Date.now();
    const row = store.getByTicketId("AI-1003");
    expect(row!.state).toBe("write-tests");
    expect(row!.delegate).toBe("tdd");
    const enteredMs = new Date(row!.entered_state_at).getTime();
    expect(enteredMs).toBeGreaterThanOrEqual(beforeTransition);
    expect(enteredMs).toBeLessThanOrEqual(afterTransition);
    expect(row!.last_event_kind).toBe("tests-ready");
    expect(row!.terminal).toBe(0);
  });

  it("recordTransition() updates entered_state_at even when transitioning to the same state (re-stamp)", () => {
    store.enroll({ ticketId: "AI-1004", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });
    const original = store.getByTicketId("AI-1004")!;

    // Small delay to ensure timestamp difference
    store.recordTransition({ ticketId: "AI-1004", toState: "write-tests", delegate: "tdd", eventKind: "self-loop" });
    const updated = store.getByTicketId("AI-1004")!;

    expect(updated.entered_state_at).not.toBe(original.entered_state_at);
  });

  it("markTerminal() marks the row terminal=1 without deleting it", () => {
    store.enroll({ ticketId: "AI-1005", workflow: "dev-impl", state: "done", delegate: "ai" });

    store.markTerminal("AI-1005", "complete");

    const row = store.getByTicketId("AI-1005");
    expect(row).not.toBeNull();
    expect(row!.terminal).toBe(1);
    expect(row!.last_event_kind).toBe("complete");
  });

  it("a terminal ticket remains in getAll() results with the terminal flag set", () => {
    store.enroll({ ticketId: "AI-1006", workflow: "dev-impl", state: "done", delegate: "ai" });
    store.markTerminal("AI-1006", "complete");

    const all = store.getAll();
    const terminal = all.find((r) => r.ticket_id === "AI-1006");
    expect(terminal).toBeDefined();
    expect(terminal!.terminal).toBe(1);
  });

  it("demoteEnrolled() marks a ticket as leaving the workflow (terminal, not deleted)", () => {
    store.enroll({ ticketId: "AI-1007", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    store.demoteEnrolled("AI-1007");

    const row = store.getByTicketId("AI-1007");
    expect(row).not.toBeNull();
    expect(row!.terminal).toBe(1);
  });

  it("demoteEnrolled() creates a tombstone for a ticket with no prior mirror row", () => {
    store.demoteEnrolled("AI-1009");

    const row = store.getByTicketId("AI-1009");
    expect(row).not.toBeNull();
    expect(row!.workflow).toBe("unknown");
    expect(row!.state).toBe("__ad_hoc__");
    expect(row!.terminal).toBe(1);
    expect(row!.last_event_kind).toBe("demoted");
    expect(store.wasDemoted("AI-1009")).toBe(true);
  });

  // ── INF-271: retire() ───────────────────────────────────────────────

  it("retire() marks an active ticket as retired (terminal=1, delegate cleared)", () => {
    store.enroll({ ticketId: "INF-271-1", workflow: "sprint-spawner", state: "scanning", delegate: "astrid" });

    let row = store.getByTicketId("INF-271-1");
    expect(row).not.toBeNull();
    expect(row!.terminal).toBe(0);
    expect(row!.delegate).toBe("astrid");

    store.retire("INF-271-1");

    row = store.getByTicketId("INF-271-1");
    expect(row).not.toBeNull();
    expect(row!.terminal).toBe(1);
    expect(row!.last_event_kind).toBe("retired");
    expect(row!.delegate).toBeNull();
  });

  it("retire() is idempotent — calling it twice does not error", () => {
    store.enroll({ ticketId: "INF-271-2", workflow: "dev-impl", state: "intake", delegate: "ai" });
    store.retire("INF-271-2");

    // Second call should not throw
    expect(() => store.retire("INF-271-2")).not.toThrow();

    const row = store.getByTicketId("INF-271-2");
    expect(row!.terminal).toBe(1);
    expect(row!.last_event_kind).toBe("retired");
  });

  it("retire() creates a tombstone for a ticket with no prior mirror row", () => {
    store.retire("INF-271-3");

    const row = store.getByTicketId("INF-271-3");
    expect(row).not.toBeNull();
    expect(row!.terminal).toBe(1);
    expect(row!.last_event_kind).toBe("retired");
    expect(row!.workflow).toBe("unknown");
    expect(row!.state).toBe("__retired__");
  });

  it("retire() is a no-op on an already-terminal ticket (idempotent)", () => {
    store.enroll({ ticketId: "INF-271-4", workflow: "dev-impl", state: "done", delegate: "ai" });
    store.markTerminal("INF-271-4", "complete");

    // Should not throw
    expect(() => store.retire("INF-271-4")).not.toThrow();

    const row = store.getByTicketId("INF-271-4");
    expect(row!.terminal).toBe(1);
    // last_event_kind should remain "complete", not overwritten by retire
    expect(row!.last_event_kind).toBe("complete");
  });

  it("persisted rows survive store reopen (durable sqlite, not in-memory)", () => {
    store.enroll({ ticketId: "AI-1008", workflow: "dev-impl", state: "intake", delegate: "ai" });
    store.recordTransition({ ticketId: "AI-1008", toState: "write-tests", delegate: "tdd", eventKind: "accept" });
    store.close();

    const reopened = new EnrolledTicketsStore(dbPath);
    const row = reopened.getByTicketId("AI-1008");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("write-tests");
    expect(row!.delegate).toBe("tdd");
    reopened.close();
  });
});

describe("AI-1799 AC3: EnrolledTicketsStore — reconcile entry point", () => {
  let dbPath: string;
  let store: EnrolledTicketsStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new EnrolledTicketsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("reconcile() creates a missing row when a ticket has wf:* + state:* labels but no mirror entry", () => {
    const result = store.reconcile("AI-2001", {
      labels: [
        { name: "wf:dev-impl" },
        { name: "state:write-tests" },
      ],
      delegate: "tdd",
      identifier: "AI-2001",
    });

    expect(result.action).toBe("created");
    const row = store.getByTicketId("AI-2001");
    expect(row).not.toBeNull();
    expect(row!.workflow).toBe("dev-impl");
    expect(row!.state).toBe("write-tests");
    expect(row!.delegate).toBe("tdd");
  });

  it("reconcile() corrects a stale state when the mirror row's state differs from the label", () => {
    store.enroll({ ticketId: "AI-2002", workflow: "dev-impl", state: "intake", delegate: "ai" });

    const result = store.reconcile("AI-2002", {
      labels: [
        { name: "wf:dev-impl" },
        { name: "state:implementation" },
      ],
      delegate: "igor",
      identifier: "AI-2002",
    });

    expect(result.action).toBe("corrected");
    const row = store.getByTicketId("AI-2002");
    expect(row!.state).toBe("implementation");
    expect(row!.delegate).toBe("igor");
  });

  it("reconcile() is a no-op when the mirror row already matches the authoritative state", () => {
    store.enroll({ ticketId: "AI-2003", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    const result = store.reconcile("AI-2003", {
      labels: [
        { name: "wf:dev-impl" },
        { name: "state:write-tests" },
      ],
      delegate: "tdd",
      identifier: "AI-2003",
    });

    expect(result.action).toBe("noop");
  });

  it("reconcile() marks terminal when the authoritative labels have no wf:* (ticket left workflow)", () => {
    store.enroll({ ticketId: "AI-2004", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    const result = store.reconcile("AI-2004", {
      labels: [],
      delegate: null,
      identifier: "AI-2004",
    });

    expect(result.action).toBe("demoted");
    const row = store.getByTicketId("AI-2004");
    expect(row).not.toBeNull();
    expect(row!.terminal).toBe(1);
  });

  it("reconcile() does not revive a terminal ticket that left the workflow", () => {
    store.enroll({ ticketId: "AI-2005", workflow: "dev-impl", state: "done", delegate: "ai" });
    store.markTerminal("AI-2005", "complete");

    const result = store.reconcile("AI-2005", {
      labels: [],
      delegate: null,
      identifier: "AI-2005",
    });

    expect(result.action).toBe("noop");
    const row = store.getByTicketId("AI-2005");
    expect(row!.terminal).toBe(1);
  });

  it("reconcile() does not create a row for a ticket with no wf:* label (never enrolled, not our defect)", () => {
    const result = store.reconcile("AI-2006", {
      labels: [],
      delegate: null,
      identifier: "AI-2006",
    });

    expect(result.action).toBe("noop");
    expect(store.getByTicketId("AI-2006")).toBeNull();
  });

  it("reconcile() does not create a row for a ticket with wf:* but no state:* (that is AI-1775's job)", () => {
    const result = store.reconcile("AI-2007", {
      labels: [{ name: "wf:dev-impl" }],
      delegate: null,
      identifier: "AI-2007",
    });

    expect(result.action).toBe("noop");
    expect(store.getByTicketId("AI-2007")).toBeNull();
  });
});
