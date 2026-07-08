/**
 * Tests for DispatchIdempotencyStore — AI-1918 replay dedup + stale guard,
 * and the AI-1973 suppression boundaries (delegate-change invalidation, dedup
 * TTL) that fix the permanent re-wake suppression behind the AI-1965
 * merge-gate stall.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DispatchIdempotencyStore, DEFAULT_DEDUP_TTL_MS } from "./dispatch-idempotency-store.js";

const TICKET = "linear-AI-1855";
const AGENT = "hanzo";
const HOUR = 60 * 60 * 1000;

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idempotency-test-"));
  const dbPath = path.join(dir, "dispatch-idempotency.db");
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const T0 = Date.parse("2026-07-07T15:43:00.000Z");

describe("DispatchIdempotencyStore — AI-1918 baseline", () => {
  it("admits a fresh dispatch and suppresses an exact replay (same updatedAt)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    const first = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    expect(first).toMatchObject({ suppressed: false, stale: false });
    const replay = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 + 5_000 });
    expect(replay).toMatchObject({ suppressed: true, stale: false });
    expect(store.counters.suppressedDuplicates).toBe(1);
    store.close();
    cleanup();
  });

  it("drops an older snapshot as stale", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    const older = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 - 60_000), { nowMs: T0 + 5_000 });
    expect(older).toMatchObject({ suppressed: false, stale: true });
    expect(store.counters.droppedStale).toBe(1);
    store.close();
    cleanup();
  });

  it("drops a stale snapshot for a different agent via the ticket-level check", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    const other = store.checkAndRecord(TICKET, "In Progress", "sage", iso(T0 - 60_000), { nowMs: T0 + 5_000 });
    expect(other).toMatchObject({ suppressed: false, stale: true });
    store.close();
    cleanup();
  });
});

describe("AI-1973 — delegate-change invalidation (AI-1855/AI-1926 round-trip shape)", () => {
  it("re-wakes an agent re-delegated to a ticket it previously held in the same native status", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);

    // First gate visit (2026-07-07 15:43Z): rows created for the agent, as in
    // the AI-1855 evidence — both the status-named row and a reason-named row.
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0, delegateChanged: true });
    store.checkAndRecord(TICKET, "delegate", AGENT, iso(T0), { nowMs: T0 });

    // Agent bounces the ticket, dev fixes, re-delegation arrives 11 minutes
    // later with the SAME native status. Pre-fix this matched the stale row
    // and was suppressed forever.
    const T1 = T0 + 11 * 60_000;
    const rewake = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T1), { nowMs: T1, delegateChanged: true });
    expect(rewake).toMatchObject({ suppressed: false, stale: false });
    expect(rewake.clearedRows).toBe(2); // both prior rows for (ticket, agent) gone
    expect(store.counters.delegateChangeCleared).toBe(2);

    // Subsequent nudges with newer payloads keyed differently are not blocked
    // by leftover rows from the first visit (they were cleared).
    const nudge = store.checkAndRecord(TICKET, "delegate", AGENT, iso(T1 + 60_000), { nowMs: T1 + 60_000 });
    expect(nudge).toMatchObject({ suppressed: false, stale: false });
    store.close();
    cleanup();
  });

  it("still dedups a replayed re-delegation webhook (equal updatedAt)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0, delegateChanged: true });

    const T1 = T0 + 11 * 60_000;
    const first = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T1), { nowMs: T1, delegateChanged: true });
    expect(first.suppressed).toBe(false);

    // Same webhook delivered twice within the replay window: identical
    // updatedAt is NOT strictly newer, so nothing is cleared and the fresh
    // row suppresses the duplicate. One wake total.
    const replay = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T1), { nowMs: T1 + 3_000, delegateChanged: true });
    expect(replay).toMatchObject({ suppressed: true, stale: false });
    expect(replay.clearedRows ?? 0).toBe(0);
    store.close();
    cleanup();
  });

  it("does not clear rows for other agents on a delegate change", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "In Progress", "sage", iso(T0), { nowMs: T0 });
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 + 1_000), { nowMs: T0 + 1_000 });

    const T1 = T0 + 10 * 60_000;
    const rewake = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T1), { nowMs: T1, delegateChanged: true });
    expect(rewake.clearedRows).toBe(1);

    // Sage's row survives: an equal-updatedAt replay for sage still dedups.
    const sageReplay = store.checkAndRecord(TICKET, "In Progress", "sage", iso(T0), { nowMs: T1 });
    expect(sageReplay.suppressed || sageReplay.stale).toBe(true);
    store.close();
    cleanup();
  });

  it("drops a delegate-change snapshot that is older than what was already seen", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    const late = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 - 60_000), { nowMs: T0 + 5_000, delegateChanged: true });
    expect(late).toMatchObject({ suppressed: false, stale: true });
    store.close();
    cleanup();
  });
});

describe("AI-1973 — dedup TTL", () => {
  it("stops suppressing once the row passes the TTL", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath, 2 * HOUR);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });

    // Within TTL: a newer payload on the same key is still a suppressed
    // duplicate (replay-window semantics).
    const withinTtl = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 + 60_000), { nowMs: T0 + HOUR });
    expect(withinTtl).toMatchObject({ suppressed: true });

    // Past TTL: the same shape is admitted — a 19-hour stall like AI-1965
    // can no longer be held by one dedup row.
    const pastTtl = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 + 60_000), { nowMs: T0 + 3 * HOUR });
    expect(pastTtl).toMatchObject({ suppressed: false, stale: false, ttlExpired: true });
    expect(store.counters.ttlExpiredAdmits).toBe(1);

    // The admit refreshed the row: an immediate replay is suppressed again.
    const replay = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 + 60_000), { nowMs: T0 + 3 * HOUR + 5_000 });
    expect(replay).toMatchObject({ suppressed: true });
    store.close();
    cleanup();
  });

  it("stale-snapshot ordering ignores the TTL", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath, 1 * HOUR);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    const older = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 - 60_000), { nowMs: T0 + 5 * HOUR });
    expect(older).toMatchObject({ suppressed: false, stale: true });
    store.close();
    cleanup();
  });

  it("honors pre-AI-1973 rows written with zoneless SQLite datetime('now')", () => {
    const { dbPath, cleanup } = makeTempDb();
    // Seed a legacy-format row directly, as the AI-1918 code wrote them.
    const store = new DispatchIdempotencyStore(dbPath, 2 * HOUR);
    const legacyCreated = iso(T0).replace("T", " ").replace(/\.\d{3}Z$/, "");
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO dispatch_idempotency (ticket_key, workflow_state, agent, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(TICKET, "To Do", AGENT, iso(T0), legacyCreated);
    db.close();

    // Within TTL of the legacy row's true (UTC) age: suppressed.
    const within = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 + HOUR });
    expect(within).toMatchObject({ suppressed: true });
    // Past TTL: admitted.
    const past = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 + 1), { nowMs: T0 + 3 * HOUR });
    expect(past).toMatchObject({ suppressed: false, stale: false, ttlExpired: true });
    store.close();
    cleanup();
  });

  it("reads TTL from DISPATCH_IDEMPOTENCY_TTL_MS when not passed explicitly", () => {
    const { dbPath, cleanup } = makeTempDb();
    const prev = process.env.DISPATCH_IDEMPOTENCY_TTL_MS;
    process.env.DISPATCH_IDEMPOTENCY_TTL_MS = String(HOUR);
    try {
      const store = new DispatchIdempotencyStore(dbPath);
      store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
      const past = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 + 2 * HOUR });
      expect(past).toMatchObject({ suppressed: false, ttlExpired: true });
      store.close();
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_IDEMPOTENCY_TTL_MS;
      else process.env.DISPATCH_IDEMPOTENCY_TTL_MS = prev;
    }
    cleanup();
  });

  it("defaults to DEFAULT_DEDUP_TTL_MS (replay windows are hours, not days)", () => {
    expect(DEFAULT_DEDUP_TTL_MS).toBe(6 * HOUR);
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    // 19 hours later — the AI-1855 stall duration — the row no longer holds.
    const nextDay = store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0 + 19 * HOUR), { nowMs: T0 + 19 * HOUR });
    expect(nextDay).toMatchObject({ suppressed: false, stale: false });
    store.close();
    cleanup();
  });
});

describe("AI-1973 — clearAgentRows escape hatch", () => {
  it("deletes all rows for (ticket, agent) and reports the count", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchIdempotencyStore(dbPath);
    store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 });
    store.checkAndRecord(TICKET, "delegate", AGENT, iso(T0), { nowMs: T0 });
    store.checkAndRecord(TICKET, "In Progress", "sage", iso(T0), { nowMs: T0 });
    expect(store.clearAgentRows(TICKET, AGENT)).toBe(2);
    // Cleared agent re-admits; untouched agent still dedups.
    expect(store.checkAndRecord(TICKET, "To Do", AGENT, iso(T0), { nowMs: T0 + 1_000 }).suppressed).toBe(false);
    expect(store.checkAndRecord(TICKET, "In Progress", "sage", iso(T0), { nowMs: T0 + 1_000 }).suppressed).toBe(true);
    store.close();
    cleanup();
  });
});
