/**
 * Failing tests for INF-217: Dead-letter queue for silent-fallback dispatch.
 *
 * AC1: A dispatch whose target agent is not in the roster is written to a
 *      persisted dead-letter queue, NOT silently dropped or falling back.
 * AC2: On dead-letter, a structured log entry is emitted carrying
 *      { ticketId, intendedAgent, reason }.
 * AC3: On dead-letter, an observable signal/event is emitted.
 * AC4: Integration test: a non-roster dispatch lands in the DLQ AND emits the
 *      log AND emits the signal; a valid roster dispatch does none of these.
 * AC5: Background-wiring: if a DLQ consumer/sweep is introduced, it is
 *      registered at the production entry point and proven live by an
 *      integration test.
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeadLetterQueueStore } from "./dead-letter-queue.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlq-test-"));
  return path.join(dir, "dead-letter.db");
}

// ── Unit tests: DeadLetterQueueStore ──────────────────────────────────────

describe("DeadLetterQueueStore", () => {
  let dbPath: string;
  let store: DeadLetterQueueStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new DeadLetterQueueStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  // ── AC1: Persistence ──────────────────────────────────────────────────────

  it("AC1: persists a dead-letter entry with ticketId, intendedAgent, and reason", () => {
    store.append({
      ticketId: "AI-9999",
      intendedAgent: "unknown-agent",
      reason: "not in roster",
    });

    const entries = store.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].ticketId).toBe("AI-9999");
    expect(entries[0].intendedAgent).toBe("unknown-agent");
    expect(entries[0].reason).toBe("not in roster");
  });

  it("AC1: persists entries across store restarts (SQLite durability)", () => {
    store.append({
      ticketId: "AI-1000",
      intendedAgent: "ghost-agent",
      reason: "not in roster",
    });
    store.close();

    // Re-open the same DB file
    const store2 = new DeadLetterQueueStore(dbPath);
    const entries = store2.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].ticketId).toBe("AI-1000");
    store2.close();
  });

  it("AC1: each entry gets a unique sequential id", () => {
    const id1 = store.append({ ticketId: "T1", intendedAgent: "a1", reason: "r1" });
    const id2 = store.append({ ticketId: "T2", intendedAgent: "a2", reason: "r2" });
    const id3 = store.append({ ticketId: "T3", intendedAgent: "a3", reason: "r3" });

    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);
  });

  // ── Query / filter ────────────────────────────────────────────────────────

  it("query returns entries in insertion order (FIFO)", () => {
    store.append({ ticketId: "T1", intendedAgent: "a1", reason: "first" });
    store.append({ ticketId: "T2", intendedAgent: "a2", reason: "second" });
    store.append({ ticketId: "T3", intendedAgent: "a3", reason: "third" });

    const entries = store.query();
    expect(entries.map((e) => e.reason)).toEqual(["first", "second", "third"]);
  });

  it("query filters by agent", () => {
    store.append({ ticketId: "T1", intendedAgent: "alice", reason: "r1" });
    store.append({ ticketId: "T2", intendedAgent: "bob", reason: "r2" });
    store.append({ ticketId: "T3", intendedAgent: "alice", reason: "r3" });

    const aliceEntries = store.query({ agent: "alice" });
    expect(aliceEntries).toHaveLength(2);
    expect(aliceEntries.every((e) => e.intendedAgent === "alice")).toBe(true);
  });

  it("query filters by ticketId", () => {
    store.append({ ticketId: "AI-123", intendedAgent: "a1", reason: "r1" });
    store.append({ ticketId: "AI-456", intendedAgent: "a2", reason: "r2" });

    const entries = store.query({ ticketId: "AI-123" });
    expect(entries).toHaveLength(1);
    expect(entries[0].ticketId).toBe("AI-123");
  });

  it("getByAgent returns entries for a specific agent", () => {
    store.append({ ticketId: "T1", intendedAgent: "alice", reason: "r1" });
    store.append({ ticketId: "T2", intendedAgent: "bob", reason: "r2" });
    store.append({ ticketId: "T3", intendedAgent: "alice", reason: "r3" });

    const aliceEntries = store.getByAgent("alice");
    expect(aliceEntries).toHaveLength(2);
  });

  it("getByTicket returns entries for a specific ticket", () => {
    for (let i = 0; i < 3; i++) {
      store.append({ ticketId: "AI-777", intendedAgent: `agent-${i}`, reason: "r" });
    }
    const entries = store.getByTicket("AI-777");
    expect(entries).toHaveLength(3);
  });

  // ── AC2: The entry carries ticketId, intendedAgent, reason ─────────────────
  // Verified above per-entry; this test ensures the fields are all present
  // and non-empty in every returned entry.

  it("AC2: every entry has ticketId, intendedAgent, and reason fields", () => {
    store.append({ ticketId: "AI-555", intendedAgent: "phantom", reason: "not in roster" });
    const [entry] = store.query();

    expect(entry.ticketId).toBeTruthy();
    expect(entry.intendedAgent).toBeTruthy();
    expect(entry.reason).toBeTruthy();
    expect(entry.occurredAt).toBeTruthy();
    expect(typeof entry.id).toBe("number");
  });

  // ── Count ──────────────────────────────────────────────────────────────────

  it("count returns the number of entries", () => {
    expect(store.count()).toBe(0);
    store.append({ ticketId: "T1", intendedAgent: "a1", reason: "r1" });
    expect(store.count()).toBe(1);
    store.append({ ticketId: "T2", intendedAgent: "a2", reason: "r2" });
    expect(store.count()).toBe(2);
  });

  // ── Pruning ────────────────────────────────────────────────────────────────

  it("prune removes entries older than maxAgeDays", () => {
    // Insert an entry with an explicit old timestamp
    const oldId = store.append({
      ticketId: "AI-OLD",
      intendedAgent: "old-agent",
      reason: "old",
    });
    // Manually backdate it
    store["db"].prepare(
      "UPDATE dead_letter_entries SET occurred_at = datetime('now', '-60 days') WHERE id = ?"
    ).run(oldId);

    // Insert a recent entry
    store.append({ ticketId: "AI-NEW", intendedAgent: "new-agent", reason: "recent" });

    const removed = store.prune(30);
    expect(removed).toBe(1);
    expect(store.count()).toBe(1);
    expect(store.query()[0].ticketId).toBe("AI-NEW");
  });
});
