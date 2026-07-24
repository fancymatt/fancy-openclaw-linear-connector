/**
 * INF-413 — Ticket-level in-flight dispatch guard.
 *
 * Reproduces and closes the INF-400 double-spawn: one ticket dispatched to two
 * concurrent workers on different sessions/agents. The agent-scoped
 * DispatchLeaseStore (key = (agentId, ticketKey)) cannot catch this — two
 * different sessions for one ticket are two distinct keys. DispatchInFlightStore
 * keys on the ticket identifier alone, so the second concurrent dispatch is
 * refused regardless of agent/session.
 *
 * Two layers under test:
 *   1. DispatchInFlightStore — atomic check-and-acquire, release, TTL,
 *      supersede-on-newer-updatedAt, agent-scoped release.
 *   2. deliverToAgent integration — two concurrent dispatches for the same
 *      ticket (different agents) → second returns { dispatched: false }.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatchInFlightStore } from "./store/dispatch-inflight-store.js";
import { DispatchLeaseStore } from "./store/dispatch-lease-store.js";
import { deliverToAgent, type DeliveryConfig } from "./delivery/deliver.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, "db.sqlite");
}

function cleanupDbDir(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const TICKET = "linear-INF-400";
const OTHER_TICKET = "linear-INF-401";
const HOLDER_A = "astrid:linear-INF-400";
const HOLDER_B = "astrid:linear-INF-400"; // same session key, e.g. a heartbeat re-fire
const UPDATED_OLD = "2026-07-23T06:00:00.000Z";
const UPDATED_NEW = "2026-07-23T12:00:00.000Z";
const NOW = Date.parse("2026-07-23T08:00:00.000Z");

// ── Store: DispatchInFlightStore ─────────────────────────────────────────────

describe("DispatchInFlightStore (INF-413)", () => {
  let store: DispatchInFlightStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDbPath("inflight-store");
    store = new DispatchInFlightStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDbDir(dbPath);
  });

  it("refuses a second concurrent acquire for the same ticket (double-spawn)", () => {
    const first = store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    const second = store.tryAcquire(TICKET, HOLDER_B, { nowMs: NOW });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.refused).toBe(true);
    expect(second.existing?.holder).toBe(HOLDER_A);
    expect(store.counters.acquired).toBe(1);
    expect(store.counters.refused).toBe(1);
  });

  it("dedupes across DIFFERENT agents/sessions on the same ticket", () => {
    // The INF-400 class: two different subagent workers, one ticket.
    const worker1 = store.tryAcquire(TICKET, "sessionA:worker", { nowMs: NOW });
    const worker2 = store.tryAcquire(TICKET, "sessionB:worker", { nowMs: NOW });

    expect(worker1.acquired).toBe(true);
    expect(worker2.acquired).toBe(false);
    expect(worker2.refused).toBe(true);
  });

  it("allows a different ticket to acquire independently", () => {
    store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    const other = store.tryAcquire(OTHER_TICKET, "someone:x", { nowMs: NOW });
    expect(other.acquired).toBe(true);
    expect(store.counters.refused).toBe(0);
  });

  it("allows re-acquire after explicit release", () => {
    store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    expect(store.release(TICKET, { holder: HOLDER_A })).toBe(true);
    const reacquired = store.tryAcquire(TICKET, "next:holder", { nowMs: NOW });
    expect(reacquired.acquired).toBe(true);
  });

  it("does NOT release when the holder does not match (guards the real holder)", () => {
    store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    // A refused duplicate must not be able to release the real holder's record.
    expect(store.release(TICKET, { holder: "impostor:holder" })).toBe(false);
    expect(store.isInFlight(TICKET, { nowMs: NOW })).not.toBeNull();
  });

  it("force-releases when no holder is supplied", () => {
    store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    expect(store.release(TICKET)).toBe(true);
    expect(store.isInFlight(TICKET, { nowMs: NOW })).toBeNull();
  });

  it("expires a stale record after TTL and allows fresh acquire", () => {
    const shortStore = new DispatchInFlightStore(makeTempDbPath("inflight-ttl"), 1000);
    shortStore.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    // Same ticket, 2s later — the first record has expired.
    const later = shortStore.tryAcquire(TICKET, "fresh:holder", { nowMs: NOW + 2000 });
    expect(later.acquired).toBe(true);
    shortStore.close();
  });

  it("supersedes a stale in-flight record when updatedAt is strictly newer", () => {
    store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW, updatedAt: UPDATED_OLD });
    const newer = store.tryAcquire(TICKET, "newowner:x", {
      nowMs: NOW,
      updatedAt: UPDATED_NEW,
    });
    expect(newer.acquired).toBe(true);
    expect(newer.superseded).toBe(true);
    expect(store.get(TICKET)?.holder).toBe("newowner:x");
    expect(store.counters.superseded).toBe(1);
  });

  it("does NOT supersede for the same or older updatedAt", () => {
    store.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW, updatedAt: UPDATED_NEW });
    const older = store.tryAcquire(TICKET, "loser:x", {
      nowMs: NOW,
      updatedAt: UPDATED_OLD,
    });
    expect(older.acquired).toBe(false);
    expect(older.refused).toBe(true);
  });

  it("releaseForAgent frees only that agent's tickets (session-end)", () => {
    store.tryAcquire("linear-A", "astrid:linear-A", { nowMs: NOW });
    store.tryAcquire("linear-B", "astrid:linear-B", { nowMs: NOW });
    store.tryAcquire("linear-C", "grover:linear-C", { nowMs: NOW });

    const freed = store.releaseForAgent("astrid");
    expect(freed).toBe(2);
    expect(store.isInFlight("linear-A", { nowMs: NOW })).toBeNull();
    expect(store.isInFlight("linear-B", { nowMs: NOW })).toBeNull();
    expect(store.isInFlight("linear-C", { nowMs: NOW })).not.toBeNull();
  });

  it("releaseForAgent treats %/_ in agentId literally (no LIKE injection)", () => {
    store.tryAcquire("linear-X", "a%b:linear-X", { nowMs: NOW });
    store.tryAcquire("linear-Y", "axb:linear-Y", { nowMs: NOW });
    // Releasing "a%b" must not also match "axb" via the LIKE wildcard.
    const freed = store.releaseForAgent("a%b");
    expect(freed).toBe(1);
    expect(store.isInFlight("linear-Y", { nowMs: NOW })).not.toBeNull();
  });

  it("renew extends expiry so a long worker is not superseded by TTL", () => {
    const shortStore = new DispatchInFlightStore(makeTempDbPath("inflight-renew"), 1000);
    shortStore.tryAcquire(TICKET, HOLDER_A, { nowMs: NOW });
    expect(shortStore.renew(TICKET, { nowMs: NOW + 500 })).toBe(true);
    // At NOW+1500 the original TTL would have expired; renewed TTL keeps it live.
    expect(shortStore.isInFlight(TICKET, { nowMs: NOW + 1400 })).not.toBeNull();
    shortStore.close();
  });

  it("pruneExpired removes only expired records", () => {
    const shortStore = new DispatchInFlightStore(makeTempDbPath("inflight-prune"), 1000);
    shortStore.tryAcquire("linear-old", "x:linear-old", { nowMs: NOW });
    shortStore.tryAcquire("linear-new", "x:linear-new", { nowMs: NOW + 5000 });
    const purged = shortStore.pruneExpired({ nowMs: NOW + 2000 });
    expect(purged).toBe(1);
    shortStore.close();
  });
});

// ── Integration: deliverToAgent double-spawn prevention ──────────────────────

describe("deliverToAgent in-flight guard integration (INF-413)", () => {
  function makeRoute(overrides?: Partial<RouteResult>): RouteResult {
    return {
      agentId: "astrid",
      sessionKey: TICKET,
      priority: 0,
      event: { data: { updatedAt: UPDATED_OLD } } as unknown as LinearEvent,
      ...overrides,
    };
  }

  function makeConfig(): DeliveryConfig {
    // timeoutMs:1 makes the underlying spawn/fetch fail fast; the guard's
    // refusal is what we assert, independent of transport.
    return { nodeBin: process.execPath, timeoutMs: 1, retryDelayMs: 0, maxRetries: 0 };
  }

  let inFlightPath: string;
  let inFlight: DispatchInFlightStore;

  beforeEach(() => {
    inFlightPath = makeTempDbPath("inflight-deliver");
    inFlight = new DispatchInFlightStore(inFlightPath);
  });

  afterEach(() => {
    inFlight.close();
    cleanupDbDir(inFlightPath);
  });

  it("refuses a second dispatch for the same ticket on a DIFFERENT agent", async () => {
    const logSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    // First worker acquires the ticket at spawn time.
    inFlight.tryAcquire(TICKET, "astrid:linear-INF-400", { updatedAt: UPDATED_OLD });

    // A second agent is routed the SAME ticket (e.g. reassignment race).
    const result = await deliverToAgent(
      makeRoute({ agentId: "grover" }),
      makeConfig(),
      undefined,
      inFlight,
    );

    expect(result.dispatched).toBe(false);
    const guardLog = logSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("dispatch in-flight guard"),
    );
    expect(guardLog).toBe(true);
    logSpy.mockRestore();
  });

  it("allows the dispatch when no active run holds the ticket", async () => {
    // No pre-acquire; deliverToAgent should acquire and proceed past the guard.
    const result = await deliverToAgent(makeRoute(), makeConfig(), undefined, inFlight);
    // Transport fails (timeoutMs:1) so dispatched is false, but the guard must
    // have acquired the in-flight record rather than refusing.
    expect(inFlight.isInFlight(TICKET)).not.toBeNull();
    expect(result).toBeDefined();
  });

  it("does not crash when the in-flight store is undefined", async () => {
    const result = await deliverToAgent(makeRoute(), makeConfig(), undefined, undefined);
    expect(result).toBeDefined();
    expect(typeof result.dispatched).toBe("boolean");
  });

  it("releases the in-flight record it acquired when the agent-scoped lease refuses", async () => {
    const leasePath = makeTempDbPath("inflight-lease");
    const lease = new DispatchLeaseStore(leasePath);
    // Pre-existing lease for this agent+ticket → lease will refuse.
    lease.acquire("astrid", TICKET, { nowMs: Date.now(), updatedAt: UPDATED_OLD });

    const result = await deliverToAgent(makeRoute(), makeConfig(), lease, inFlight);

    expect(result.dispatched).toBe(false);
    // The in-flight record must NOT be left dangling for the refused dispatch.
    expect(inFlight.isInFlight(TICKET)).toBeNull();

    lease.close();
    cleanupDbDir(leasePath);
  });
});
