/**
 * Tests for DispatchLeaseStore — AI-2350 durable dispatch lease.
 *
 * AC coverage:
 *   - Acquire fresh lease succeeds
 *   - Acquire same (agent, ticket) with unexpired lease is refused (AI-2343, AI-2344)
 *   - Acquire after lease expiry succeeds (legitimate re-dispatch)
 *   - Acquire with newer updatedAt supersedes the old lease (AI-1918 AC2 / AI-1969)
 *   - Renew extends lease
 *   - Release removes lease
 *   - ReleaseAll clears all leases for an agent
 *   - Survival across store recreation (restart-safety)
 *   - Purge expired leases
 *   - TTL configuration
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DispatchLeaseStore,
  DEFAULT_LEASE_TTL_MS,
} from "./dispatch-lease-store.js";

const AGENT = "igor";
const TICKET = "linear-AI-2350";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-test-"));
  const dbPath = path.join(dir, "dispatch-lease.db");
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const T0 = Date.parse("2026-07-14T14:40:00.000Z");

describe("DispatchLeaseStore — acquire / refuse", () => {
  it("acquires a fresh lease", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    const result = store.acquire(AGENT, TICKET, { nowMs: T0 });
    expect(result.acquired).toBe(true);
    expect(result.refused).toBe(false);
    expect(result.existingLease).toBeNull();
    expect(store.counters.acquired).toBe(1);

    // Verify it's active
    const active = store.isActive(AGENT, TICKET, { nowMs: T0 + 5_000 });
    expect(active).not.toBeNull();
    expect(active!.agent_id).toBe(AGENT);
    expect(active!.ticket_key).toBe(TICKET);

    store.close();
    cleanup();
  });

  it("refuses dispatch when an unexpired lease exists (AI-2343: >25min session)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    // Acquire first lease (with an older updatedAt)
    store.acquire(AGENT, TICKET, {
      nowMs: T0,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });

    // Simulate re-dispatch 30 minutes later — still within 90min TTL,
    // same updatedAt (no state change) → refuse
    const second = store.acquire(AGENT, TICKET, {
      nowMs: T0 + 30 * MINUTE,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });
    expect(second.acquired).toBe(false);
    expect(second.refused).toBe(true);
    expect(second.existingLease).not.toBeNull();
    expect(store.counters.refused).toBe(1);
    expect(store.counters.superseded).toBe(0);

    store.close();
    cleanup();
  });

  it("refuses dispatch via webhook path (AI-2344)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    // Acquire via sweep dispatch
    store.acquire(AGENT, TICKET, {
      nowMs: T0,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });

    // Webhook re-dispatch — same updatedAt, must also be refused
    const webhookResult = store.acquire(AGENT, TICKET, {
      nowMs: T0 + 5_000,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });
    expect(webhookResult.refused).toBe(true);

    store.close();
    cleanup();
  });

  it("supersedes lease when incoming updatedAt is newer (AI-1969 / AI-1918 AC2)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    // Leg 1: dispatch with older state
    store.acquire(AGENT, TICKET, {
      nowMs: T0,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });

    // Leg 2: re-dispatch hours later with newer updatedAt — legitimate re-entry
    const result = store.acquire(AGENT, TICKET, {
      nowMs: T0 + 5_000,
      updatedAt: "2026-07-08T04:46:06.000Z",
    });
    expect(result.acquired).toBe(true);
    expect(result.refused).toBe(false);

    // Counter: 1 acquired (fresh) + 1 acquired (superseded re-acquire) = 2
    // Wait — the first acquire was counted as "acquired", the second supersede
    // also counts as "acquired" since it succeeded.
    expect(store.counters.acquired).toBe(2);
    expect(store.counters.superseded).toBe(1);
    expect(store.counters.refused).toBe(0);

    // New lease has the newer updatedAt
    const active = store.get(AGENT, TICKET);
    expect(active!.ticket_updated_at).toBe("2026-07-08T04:46:06.000Z");

    store.close();
    cleanup();
  });

  it("refuses when incoming updatedAt is older than stored ticket_updated_at", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    store.acquire(AGENT, TICKET, {
      nowMs: T0,
      updatedAt: "2026-07-08T04:46:06.000Z",
    });

    // Incoming with older updatedAt — refuse
    const result = store.acquire(AGENT, TICKET, {
      nowMs: T0 + 5_000,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });
    expect(result.refused).toBe(true);

    store.close();
    cleanup();
  });

  it("allows re-dispatch after lease expiry", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath, 30 * MINUTE); // 30 min TTL

    // Acquire
    store.acquire(AGENT, TICKET, { nowMs: T0 });

    // After TTL expired (31 min later)
    const afterExpiry = store.acquire(AGENT, TICKET, { nowMs: T0 + 31 * MINUTE });
    expect(afterExpiry.acquired).toBe(true);
    expect(afterExpiry.refused).toBe(false);

    store.close();
    cleanup();
  });
});

describe("DispatchLeaseStore — renew / release", () => {
  it("renews a lease, extending its expiry", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath, HOUR);

    store.acquire(AGENT, TICKET, { nowMs: T0 });
    const before = store.isActive(AGENT, TICKET, { nowMs: T0 + 30 * MINUTE });
    expect(before).not.toBeNull();

    // Renew at 30 min — extends to T0 + 30min + leaseTtl = T0 + 90min
    const renewed = store.renew(AGENT, TICKET, { nowMs: T0 + 30 * MINUTE });
    expect(renewed).toBe(true);
    expect(store.counters.renewed).toBe(1);

    // Still active 80 min after T0 (50 min after renewal)
    const after = store.isActive(AGENT, TICKET, { nowMs: T0 + 80 * MINUTE });
    expect(after).not.toBeNull();

    store.close();
    cleanup();
  });

  it("returns false when renewing a nonexistent or expired lease", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath, 5 * MINUTE);

    // Nonexistent
    expect(store.renew("nonexistent", TICKET, { nowMs: T0 })).toBe(false);

    // Expired lease
    store.acquire(AGENT, TICKET, { nowMs: T0 });
    const result = store.renew(AGENT, TICKET, { nowMs: T0 + 10 * MINUTE }); // past 5min TTL
    expect(result).toBe(false);

    store.close();
    cleanup();
  });

  it("releases a lease", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    store.acquire(AGENT, TICKET, { nowMs: T0 });
    const released = store.release(AGENT, TICKET);
    expect(released).toBe(true);
    expect(store.counters.released).toBe(1);

    // After release, lease is gone
    const active = store.isActive(AGENT, TICKET, { nowMs: T0 + 5_000 });
    expect(active).toBeNull();

    store.close();
    cleanup();
  });

  it("releases all leases for an agent", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    store.acquire(AGENT, "linear-AI-100", { nowMs: T0 });
    store.acquire(AGENT, "linear-AI-200", { nowMs: T0 });
    store.acquire("other-agent", TICKET, { nowMs: T0 });

    const released = store.releaseAll(AGENT);
    expect(released).toBe(2);

    // Other agent's lease still exists
    expect(store.isActive("other-agent", TICKET, { nowMs: T0 + 5_000 })).not.toBeNull();

    store.close();
    cleanup();
  });

  it("releases a lease — session-end / terminal transition", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);

    // Acquire during dispatch
    store.acquire(AGENT, TICKET, { nowMs: T0 });

    // Session ends
    const released = store.release(AGENT, TICKET);
    expect(released).toBe(true);

    // Now a fresh dispatch can proceed
    const redispatch = store.acquire(AGENT, TICKET, { nowMs: T0 + 30_000 });
    expect(redispatch.acquired).toBe(true);

    store.close();
    cleanup();
  });
});

describe("DispatchLeaseStore — restart safety", () => {
  it("survives store recreation (restart-safety)", () => {
    const { dbPath, cleanup } = makeTempDb();

    // First store lifetime
    const store1 = new DispatchLeaseStore(dbPath);
    store1.acquire(AGENT, TICKET, { nowMs: T0, updatedAt: "2026-07-07T06:00:00.000Z" });
    store1.close();

    // Second store lifetime — same dbPath, simulates restart
    const store2 = new DispatchLeaseStore(dbPath);
    const active = store2.isActive(AGENT, TICKET, { nowMs: T0 + 5_000 });
    expect(active).not.toBeNull();
    expect(active!.ticket_key).toBe(TICKET);
    expect(active!.ticket_updated_at).toBe("2026-07-07T06:00:00.000Z");

    // Lease still blocks re-dispatch for same state
    const result = store2.acquire(AGENT, TICKET, {
      nowMs: T0 + 10_000,
      updatedAt: "2026-07-07T06:00:00.000Z",
    });
    expect(result.refused).toBe(true);

    // But allows re-dispatch for newer state
    const result2 = store2.acquire(AGENT, TICKET, {
      nowMs: T0 + 10_000,
      updatedAt: "2026-07-08T04:46:06.000Z",
    });
    expect(result2.acquired).toBe(true);

    store2.close();
    cleanup();
  });
});

describe("DispatchLeaseStore — purge expired", () => {
  it("purges expired leases", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath, 15 * MINUTE); // 15 min TTL

    store.acquire(AGENT, TICKET, { nowMs: T0 });
    store.acquire(AGENT, "linear-AI-200", { nowMs: T0 });
    store.acquire("other-agent", TICKET, { nowMs: T0 + 10 * MINUTE });

    // Purge 20 min later — first two leases expired, third still active
    const purged = store.purgeExpired({ nowMs: T0 + 20 * MINUTE });
    expect(purged).toBe(2);

    // Agent's old leases are gone
    expect(store.isActive(AGENT, TICKET, { nowMs: T0 + 20 * MINUTE })).toBeNull();
    expect(store.isActive(AGENT, "linear-AI-200", { nowMs: T0 + 20 * MINUTE })).toBeNull();

    // Other agent's lease still active (acquired at T0+10min, expires at T0+25min)
    expect(store.isActive("other-agent", TICKET, { nowMs: T0 + 20 * MINUTE })).not.toBeNull();

    expect(store.counters.stalePurged).toBe(2);

    store.close();
    cleanup();
  });
});

describe("DispatchLeaseStore — TTL config", () => {
  it("uses env var DISPATCH_LEASE_TTL_MS when set", () => {
    const prev = process.env.DISPATCH_LEASE_TTL_MS;
    process.env.DISPATCH_LEASE_TTL_MS = "60000"; // 1 min

    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);
    expect((store as any).leaseTtlMs).toBe(60000);

    store.close();
    cleanup();

    if (prev) process.env.DISPATCH_LEASE_TTL_MS = prev;
    else delete process.env.DISPATCH_LEASE_TTL_MS;
  });

  it("clamps TTL to MAX_LEASE_TTL_MS", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath, 48 * 60 * 60 * 1000); // 48h -> clamped to 24h
    expect((store as any).leaseTtlMs).toBe(24 * 60 * 60 * 1000);

    store.close();
    cleanup();
  });

  it("uses default TTL when env var is invalid", () => {
    const prev = process.env.DISPATCH_LEASE_TTL_MS;
    process.env.DISPATCH_LEASE_TTL_MS = "not-a-number";

    const { dbPath, cleanup } = makeTempDb();
    const store = new DispatchLeaseStore(dbPath);
    expect((store as any).leaseTtlMs).toBe(DEFAULT_LEASE_TTL_MS);

    store.close();
    cleanup();

    if (prev) process.env.DISPATCH_LEASE_TTL_MS = prev;
    else delete process.env.DISPATCH_LEASE_TTL_MS;
  });
});
