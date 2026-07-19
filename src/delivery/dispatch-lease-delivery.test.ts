/**
 * AI-2564 — Dispatch dedupe: refuse second dispatch when live session exists.
 *
 * Tests that delivery/deliver.ts checks the DispatchLeaseStore before
 * spawning a delivery, and refuses the dispatch when an unexpired lease
 * is already held for the same (agentId, ticketKey) pair.
 *
 * AC coverage:
 *   - Same agent + ticket → second dispatch refused, logged as
 *     "dispatch deduped: live session exists"
 *   - Same ticket with newer updatedAt → old lease superseded, dispatch proceeds
 *   - Different ticket → not affected
 *   - Lease store unavailable (undefined) → graceful fallback, no crash
 */

import { jest, describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deliverToAgent,
  type DeliveryConfig,
} from "./deliver.js";
import { DispatchLeaseStore } from "../store/dispatch-lease-store.js";
import type { RouteResult } from "../types.js";
import type { LinearEvent } from "../webhook/schema.js";

// ── Test Constants ──────────────────────────────────────────────────────────

const AGENT_ID = "test-agent";
const TICKET_KEY = "linear-AI-2564";
const DIFFERENT_TICKET = "linear-AI-9999";
const UPDATED_AT_OLD = "2026-07-07T06:00:00.000Z";
const UPDATED_AT_NEW = "2026-07-17T12:00:00.000Z";

const T0 = Date.parse("2026-07-17T17:00:00.000Z");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-delivery-test-"));
  return path.join(dir, "dispatch-lease.db");
}

function makeRoute(overrides?: Partial<RouteResult>): RouteResult {
  return {
    agentId: AGENT_ID,
    sessionKey: TICKET_KEY,
    priority: 0,
    event: { data: { updatedAt: UPDATED_AT_OLD } } as unknown as LinearEvent,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<DeliveryConfig>): DeliveryConfig {
  return {
    nodeBin: process.execPath,
    timeoutMs: 1,
    retryDelayMs: 0,
    maxRetries: 0,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dispatch-lease-delivery (AI-2564)", () => {
  /**
   * AC1: Two simultaneous dispatches for the same agent + ticket →
   *      second is refused, logged as "dispatch deduped: live session exists".
   *
   * We assert by capturing console output and verifying the log line.
   * Before implementation (TDD red phase), deliverToAgent ignores the
   * lease store arg entirely, so the log never appears — test fails.
   * After implementation, a refused lease writes the log line — test passes.
   */
  it("refuses second dispatch for same agent + ticket when lease exists", async () => {
    const dbPath = makeTempDbPath();
    const leaseStore = new DispatchLeaseStore(dbPath);

    // Pre-establish a lease (simulating an active session).
    // Use Date.now() — not the static T0 — so the lease is still
    // active when deliverToAgent calls acquire() at real time.
    // (AI-2564 post-impl: T0 drifted far enough in CI to expire the lease.)
    leaseStore.acquire(AGENT_ID, TICKET_KEY, {
      nowMs: Date.now(),
      updatedAt: UPDATED_AT_OLD,
    });

    // Capture console output — the implementation must log
    // "dispatch deduped: live session exists" when a lease refuses.
    // Note: connector's createLogger routes ALL levels through console.error.
    const logSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await deliverToAgent(
      makeRoute(),
      makeConfig(),
      leaseStore,
    );

    // Assert the refusal was due to the lease check, not a delivery error
    expect(result.dispatched).toBe(false);

    // The log message is the key signal that the lease check ran and refused.
    // BEFORE implementation: this assertion fails because deliverToAgent
    // does not check the lease store.
    const leaseLog = logSpy.mock.calls.some(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("dispatch deduped: live session exists"),
    );
    expect(leaseLog).toBe(true);

    logSpy.mockRestore();
    leaseStore.close();
    cleanupDbDir(dbPath);
  });

  /**
   * AC2: A dispatch for the same ticket with a newer updatedAt →
   *      old lease superseded, new session spawned.
   *
   * Before implementation, the lease store argument is ignored, so
   * the lease's ticket_updated_at stays at the old value — test fails.
   * After implementation, deliverToAgent calls leaseStore.acquire with
   * the newer updatedAt, which supersedes the old lease — test passes.
   */
  it("supersedes old lease and dispatches when updatedAt is newer", async () => {
    const dbPath = makeTempDbPath();
    const leaseStore = new DispatchLeaseStore(dbPath);

    // Old lease exists with stale state.
    // Use Date.now() for consistency — see AC1 note above.
    leaseStore.acquire(AGENT_ID, TICKET_KEY, {
      nowMs: Date.now(),
      updatedAt: UPDATED_AT_OLD,
    });

    // New dispatch with newer updatedAt — should supersede
    const route = makeRoute();
    (route.event.data as Record<string, unknown>).updatedAt = UPDATED_AT_NEW;

    await deliverToAgent(route, makeConfig(), leaseStore);

    // The lease should have been superseded with the newer updatedAt.
    // BEFORE implementation: lease store arg is ignored → lease still has
    // old updatedAt → assertion fails.
    const lease = leaseStore.get(AGENT_ID, TICKET_KEY);
    expect(lease?.ticket_updated_at).toBe(UPDATED_AT_NEW);

    leaseStore.close();
    cleanupDbDir(dbPath);
  });

  /**
   * AC3: A dispatch for a different ticket → not affected.
   *
   * Ensures the lease check is scoped to the specific (agentId, ticketKey).
   * Before implementation, any behavior here is accidental — the test
   * is a regression guard.
   */
  it("allows dispatch for a different ticket when lease exists for another", async () => {
    const dbPath = makeTempDbPath();
    const leaseStore = new DispatchLeaseStore(dbPath);

    // Lease exists for AI-2564
    leaseStore.acquire(AGENT_ID, TICKET_KEY, {
      nowMs: T0,
      updatedAt: UPDATED_AT_OLD,
    });

    // Dispatch for a different ticket — should not be blocked
    const route = makeRoute({ sessionKey: DIFFERENT_TICKET });

    await deliverToAgent(route, makeConfig(), leaseStore);

    // The lease store should show no refusal counters from this call
    expect(leaseStore.counters.refused).toBe(0);
    // Original lease untouched
    const originalLease = leaseStore.isActive(AGENT_ID, TICKET_KEY, { nowMs: T0 + 1000 });
    expect(originalLease).not.toBeNull();

    leaseStore.close();
    cleanupDbDir(dbPath);
  });

  /**
   * AC4: Falls back gracefully if lease store is unavailable (undefined).
   */
  it("does not crash when lease store is undefined", async () => {
    const result = await deliverToAgent(
      makeRoute(),
      makeConfig(),
      undefined,
    );

    expect(result).toBeDefined();
    expect(typeof result.dispatched).toBe("boolean");
  });

  /**
   * AC4 (variant): Lease store argument omitted entirely.
   */
  it("does not crash when lease store argument is missing", async () => {
    const result = await deliverToAgent(
      makeRoute(),
      makeConfig(),
    );

    expect(result).toBeDefined();
    expect(typeof result.dispatched).toBe("boolean");
  });
});

function cleanupDbDir(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
