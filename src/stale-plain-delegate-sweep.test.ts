/**
 * INF-168 — Tests for the stale-plain-delegate sweep.
 *
 * AC1: Sweep queries Linear for plain tickets with delegate set in a
 *      non-terminal state, older than stale timeout → identifies stale.
 * AC2: First stale detection → re-dispatches via wakeFn.
 * AC3: Repeated no-ack (≥2 attempts) → escalates: stale-delegate label,
 *      alert-bus notification.
 * AC4: Skips wf:* labeled tickets.
 * AC5: Idempotent — recently re-dispatched tickets skipped via ack-tracker.
 * AC6: Cron registration observable via /health crons field.
 * AC7: Errors alert rather than crashing.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";

import {
  runStalePlainDelegateSweep,
  registerStalePlainDelegateCron,
} from "./stale-plain-delegate-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { resetCronRegistryForTest, getRegisteredCrons } from "./cron/registry.js";

const STALE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const STALE_TIME = new Date(Date.now() - STALE_TIMEOUT_MS - 60_000).toISOString();
const FRESH_TIME = new Date(Date.now() - 60_000).toISOString();

function makeTicket(
  identifier: string,
  stateName: string,
  delegateName: string,
  delegateId: string,
  overrides?: { updatedAt?: string; labels?: Array<{ name: string }> },
) {
  return {
    id: `issue-${identifier.toLowerCase()}`,
    identifier,
    updatedAt: overrides?.updatedAt ?? STALE_TIME,
    state: { name: stateName },
    labels: { nodes: overrides?.labels ?? [] },
    delegate: { id: delegateId, name: delegateName },
  };
}

function mockFetch(responses: Array<{ query?: string; response: unknown }>): typeof fetch {
  let idx = 0;
  return async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const match = responses.find((r) => !r.query || body.includes(r.query));
    const data = match?.response ?? { data: { issues: { nodes: [] } } };
    idx++;
    return { ok: true, status: 200, json: async () => data } as Response;
  };
}

describe("StalePlainDelegateSweep", () => {
  let eventStore: OperationalEventStore;
  let ackTracker: DispatchAckTracker;
  let alertStore: AlertStore;
  let alertBus: AlertBus;
  let wakeCalls: Array<{ agent: string; ticket: string }>;
  let commentCalls: Array<{ agent: string; ticket: string; body: string }>;

  beforeAll(() => {
    alertStore = new AlertStore(":memory:");
    alertBus = new AlertBus(alertStore);
  });

  afterAll(() => {
    alertStore.close();
  });

  beforeEach(() => {
    eventStore = new OperationalEventStore(":memory:");
    ackTracker = new DispatchAckTracker(":memory:");
    wakeCalls = [];
    commentCalls = [];
  });

  afterEach(() => {
    ackTracker.close();
    resetCronRegistryForTest();
  });

  it("AC1: detects stale plain tickets with delegate in Thinking/Doing/To Do", async () => {
    const tickets = [
      makeTicket("AI-9999", "Thinking", "Igor", "igor-uuid"),
      makeTicket("AI-8888", "Doing", "Igor", "igor-uuid"),
      makeTicket("AI-7777", "To Do", "Ai", "ai-uuid"),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: (a, t) => { wakeCalls.push({ agent: a, ticket: t }); return Promise.resolve(); },
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.scanned).toBe(3);
    expect(result.staleDetected).toBe(3);
    expect(result.redispatched).toBe(3);
    expect(wakeCalls).toHaveLength(3);
    expect(wakeCalls.map((c) => c.ticket)).toEqual(["AI-9999", "AI-8888", "AI-7777"]);
  });

  it("AC2: first stale detection re-dispatches the delegate", async () => {
    const tickets = [
      makeTicket("AI-6666", "Thinking", "Ai", "ai-uuid"),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: (a, t) => { wakeCalls.push({ agent: a, ticket: t }); return Promise.resolve(); },
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.staleDetected).toBe(1);
    expect(result.redispatched).toBe(1);
    expect(result.escalated).toBe(0);
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]).toEqual({ agent: "Ai", ticket: "AI-6666" });
  });

  it("AC3: escalates after max re-dispatches (>=2 attempts)", async () => {
    // Seed 2 dispatch attempts with OLD timestamps (outside the 15min
    // recent-dispatch window) so hasRecentPending doesn't block detection.
    // Access the underlying DB to set old timestamps.
    const oldTs = new Date(Date.now() - 20 * 60 * 1000) // 20 min ago
      .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    
    // Use raw SQL to insert a record with old timestamps
    const db = (ackTracker as any).db;
    db.prepare(`
      INSERT INTO dispatch_acks
        (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
      VALUES (?, ?, ?, ?, 'pending', 1)
    `).run("Ai", "linear-AI-5555", oldTs, oldTs);
    db.prepare(`
      UPDATE dispatch_acks SET
        ack_status = 'unconfirmed', dispatched_at = ?, last_signal_at = ?,
        attempt_count = 2, redispatch_failure_count = 0
      WHERE agent_id = ? AND ticket_id = ?
    `).run(oldTs, oldTs, "Ai", "linear-AI-5555");

    // Verify seed
    const seeded = ackTracker.listFiltered({ agentId: "Ai" });
    // ticketId in ack tracker is normalized with linear- prefix
    const match = seeded.find((e) => {
      const raw = e.ticketId.replace(/^linear-/i, "").toLowerCase();
      return raw === "ai-5555";
    });
    expect(match).toBeDefined();
    expect(match!.attemptCount).toBe(2);

    const tickets = [
      makeTicket("AI-5555", "Thinking", "Ai", "ai-uuid"),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
      { query: "StaleDelegateLabel", response: { data: { organization: { labels: { nodes: [{ id: "sid", name: "stale-delegate" }] } } } } },
      { query: "AddStaleDelegateLabel", response: { data: { issueUpdate: { success: true } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      postLinearComment: (a, t, b) => { commentCalls.push({ agent: a, ticket: t, body: b }); return Promise.resolve(true); },
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.staleDetected).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.redispatched).toBe(0);
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
    expect(commentCalls.some((c) => c.ticket === "AI-5555")).toBe(true);
  });

  it("AC4: skips tickets with wf:* labels", async () => {
    const tickets = [
      makeTicket("AI-4444", "Thinking", "Ai", "ai-uuid", { labels: [{ name: "wf:dev-impl" }] }),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.scanned).toBe(0);
    expect(result.staleDetected).toBe(0);
  });

  it("AC5: skips tickets with recent ack-tracker entries", async () => {
    ackTracker.recordDispatch("Ai", "AI-2222");

    const tickets = [
      makeTicket("AI-2222", "Thinking", "Ai", "ai-uuid"),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.skippedRecent).toBe(1);
    expect(result.staleDetected).toBe(0);
  });

  it("AC6: registers cron and appears in registry", () => {
    const timer = registerStalePlainDelegateCron({
      authToken: "tok",
      intervalMs: 15 * 60 * 1000,
      staleTimeoutMs: 4 * 60 * 60 * 1000,
    });

    const crons = getRegisteredCrons();
    const entry = crons.find((c) => c.name === "stale-plain-delegate-sweep");
    expect(entry).toBeDefined();
    expect(entry!.schedule).toContain("15m");

    clearInterval(timer);
  });

  it("AC7: query failures produce errors and alert", async () => {
    const failingFetch: typeof fetch = async () => { throw new Error("Linear unreachable"); };

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      fetchFn: failingFetch,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Linear unreachable");
    expect(result.scanned).toBe(0);
  });

  it("emits operational events on redispatch", async () => {
    const tickets = [
      makeTicket("AI-0001", "Thinking", "Igor", "igor-uuid"),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: (a, t) => { wakeCalls.push({ agent: a, ticket: t }); return Promise.resolve(); },
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.redispatched).toBe(1);

    const events = eventStore.query({ key: "linear-AI-0001" });
    const ev = events.find((e) => e.outcome === "stale-plain-delegate-redispatch");
    expect(ev).toBeDefined();
    expect(ev!.agent).toBe("Igor");
  });

  it("escalates gracefully when stale-delegate label does not exist in org", async () => {
    // Seed with old timestamp to avoid recent-dispatch window
    const oldTs = new Date(Date.now() - 20 * 60 * 1000)
      .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const db = (ackTracker as any).db;
    db.prepare(`
      INSERT INTO dispatch_acks
        (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
      VALUES (?, ?, ?, ?, 'pending', 1)
    `).run("Ai", "linear-AI-0002", oldTs, oldTs);
    db.prepare(`
      UPDATE dispatch_acks SET
        ack_status = 'unconfirmed', dispatched_at = ?, last_signal_at = ?,
        attempt_count = 2, redispatch_failure_count = 0
      WHERE agent_id = ? AND ticket_id = ?
    `).run(oldTs, oldTs, "Ai", "linear-AI-0002");

    const tickets = [
      makeTicket("AI-0002", "Doing", "Ai", "ai-uuid"),
    ];

    const fetcher = mockFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
      { query: "StaleDelegateLabel", response: { data: { organization: { labels: { nodes: [] } } } } },
    ]);

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      postLinearComment: () => Promise.resolve(true),
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    expect(result.escalated).toBe(1);
    expect(result.redispatched).toBe(0);
  });
});
