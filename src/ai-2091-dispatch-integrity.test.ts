/**
 * AI-2091 — Connector dispatch integrity: regression fixtures for all four
 * defect vectors.
 *
 * FAILING (RED) TDD tests, authored before implementation. Each describe block
 * maps back to the AC it covers; the implementer (igor) makes them pass without
 * weakening any assertion.
 *
 * Four vectors:
 *   1. Wrong-agent C4 re-poke (AI-2042 canonical fixture + AC1–AC8) —
 *      processStaleSession fires to stale.agentId without re-resolving the
 *      current delegate at delivery. staleRePokeRecipientValid is the guard
 *      the implementation must export from index.ts and wire into the C4 path.
 *   2. Phantom dispatch / unfetchable ticket (AI-2015 AC1–AC7) — no hard pre-
 *      dispatch existence/fetchability gate; C4 re-poke fires for nonexistent
 *      tickets too. New operational event vocabulary required.
 *   3. Duplicate session dispatch (AI-1774) — concurrent intake race produces
 *      two sessions from one Linear wake. DispatchIdempotencyStore (AI-1918) is
 *      the fix vehicle; this fixture pins the concurrent AI-1772-style race.
 *   4. Stale-snapshot overwrite (AI-2058, P0) — agent commits a terminal
 *      mutation using a delegate/state snapshot taken before a mid-run change;
 *      no compare-and-swap re-read guards against it.
 *
 * AI-1808 wiring requirement (Astrid, 2026-07-11 15:21 UTC): each new gate must
 * be reachable from the production dispatch path at server bootstrap. Module-
 * level unit tests of the gate in isolation do NOT satisfy this. Integration
 * tests here boot createApp and drive a wake/dispatch through the production path
 * to assert that each gate fires and is observable (operational event, /health
 * field, or startup/registry line) without waiting for a live misroute.
 *
 * ---------------------------------------------------------------------------
 * Verbatim AC of record (AI-2091, captured 2026-07-11T15:20:02.333Z by igor):
 *   Each child's specific repro (esp. AI-2042's canonical fixture and
 *   AI-2015's AC1–AC6) passes as a regression test. No wake is delivered to
 *   an agent with no relationship to the ticket; no wake fires on an
 *   unfetchable ticket; no single wake produces two sessions.
 * Astrid addendum (2026-07-11T15:21:51Z, post-capture — must be honored):
 *   Each new dispatch-integrity gate is reachable from the production dispatch
 *   path at server bootstrap, proven by an integration test that boots the entry
 *   point and drives a wake/dispatch through the production path. A module-level
 *   unit test of the gate in isolation does NOT satisfy this. Enforcement of
 *   each gate is observable without waiting for a live misroute.
 * ---------------------------------------------------------------------------
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
// staleRePokeRecipientValid is not yet exported from index.ts on main.
// Using a namespace import so the suite loads; individual tests fail at
// runtime with TypeError when they call (indexModule as any).staleRePokeRecipientValid.
import * as indexModule from "./index.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const staleRePokeRecipientValid: (sessionKey: string, agentId: string, routingCheck?: (sessionKey: string, agentId: string, reason: "delegate") => Promise<boolean>) => Promise<boolean> = (indexModule as any).staleRePokeRecipientValid;
import { reloadAgents } from "./agents.js";
import { OperationalEventStore } from "./store/operational-event-store.js";

// ── Shared test helpers ─────────────────────────────────────────────────────

const SECRET = "test-ai2091-integrity-secret";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Empty access tokens so getAccessToken() is falsy → no real Linear API calls.
// Routing still matches on linearUserId. This mirrors the pattern in AI-1918
// dispatch-idempotency.test.ts which confirmed the "routed" event fires offline.
const AGENT_A = {
  name: "ai2091-agent-a",
  linearUserId: "uid-agent-a-2091",
  openclawAgent: "ai2091-agent-a",
  clientId: "client-a-2091",
  clientSecret: "secret-a-2091",
  accessToken: "",
  refreshToken: "",
  host: "local" as const,
};
const AGENT_B = {
  name: "ai2091-agent-b",
  linearUserId: "uid-agent-b-2091",
  openclawAgent: "ai2091-agent-b",
  clientId: "client-b-2091",
  clientSecret: "secret-b-2091",
  accessToken: "",
  refreshToken: "",
  host: "local" as const,
};

function writeAgentsFile(dir: string, agents = [AGENT_A, AGENT_B]): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
  return file;
}

function makeIssuePayload(opts: {
  identifier: string;
  delegateId: string | null;
  stateName?: string;
  updatedAt?: string;
}): string {
  const { identifier, delegateId, stateName = "write-tests", updatedAt = "2026-07-11T09:00:00.000Z" } = opts;
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-07-11T08:00:00.000Z",
    actor: { id: "human-2091", name: "Matt" },
    data: {
      id: `issue-${identifier}`,
      identifier,
      title: "AI-2091 dispatch-integrity test",
      state: { id: "state-1", name: stateName, type: "started" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "t1", key: "AI" },
      labelIds: [],
      url: `https://linear.app/test/issue/${identifier}`,
      assignee: delegateId ? { id: delegateId, name: "Delegate" } : null,
      delegate: delegateId ? { id: delegateId, name: "Delegate" } : null,
      createdAt: "2026-07-11T08:00:00.000Z",
      updatedAt,
    },
  });
}

async function post(app: import("express").Express, body: string, deliveryId: string) {
  return request(app)
    .post("/")
    .set("Content-Type", "application/json")
    .set("x-linear-signature", sign(body))
    .set("x-linear-delivery", deliveryId)
    .send(body);
}

function bootApp(dir: string): ReturnType<typeof createApp> {
  process.env.AGENTS_FILE = writeAgentsFile(dir);
  reloadAgents();
  return createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "ops.db"),
    idempotencyDbPath: path.join(dir, "idempotency.db"),
  } as Parameters<typeof createApp>[0]);
}

function closeApp(state: ReturnType<typeof createApp> | undefined): void {
  state?.bag?.close();
  state?.sessionTracker?.close();
  state?.agentQueue?.close();
  state?.operationalEventStore?.close();
}

async function waitForSettled(store: OperationalEventStore, key: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  let last = -1;
  let stableSince = start;
  while (Date.now() - start < timeoutMs) {
    const n = store.query({ key, limit: 500 }).length;
    if (n === last) {
      if (n > 0 && Date.now() - stableSince >= 250) return;
    } else { last = n; stableSince = Date.now(); }
    await new Promise((r) => setTimeout(r, 40));
  }
}

function mockIssue(issue: unknown): () => void {
  const originalFetch = global.fetch;
  global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { issue } }),
  }) as unknown as typeof fetch;
  return () => { global.fetch = originalFetch; };
}

// ── VECTOR 1: Wrong-agent C4 re-poke (AI-2042 canonical fixture) ────────────
//
// AC: AI-2042 AC1–AC3 + AI-2091 verbatim AC: "No wake is delivered to an agent
// with no relationship to the ticket."
//
// Root cause: processStaleSession fires deliverMessageToAgent(stale.agentId, …)
// for the C4 re-poke using the arm-time agentId, without re-resolving the current
// delegate at delivery. staleRePokeRecipientValid is the guard the implementer
// must export from index.ts and wire into processStaleSession before deliverMessage.
//
// Self-referential canonical fixture (2026-07-11 15:12 UTC): a child of this
// umbrella (AI-1774, delegate=Astrid) was misrouted to Igor (no relationship to
// the ticket) via a stale arm-time agentId. The binding survived a restart.

describe("AI-2091 Vector 1 — stale C4 re-poke resolves recipient at delivery, not arm time", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let agentsDir: string;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-v1-agents-"));
    const agentsFile = path.join(agentsDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: AGENT_A.name, linearUserId: AGENT_A.linearUserId, openclawAgent: AGENT_A.openclawAgent, accessToken: "tok-a", host: "local" },
          { name: AGENT_B.name, linearUserId: AGENT_B.linearUserId, openclawAgent: AGENT_B.openclawAgent, accessToken: "tok-b", host: "local" },
        ],
      }),
      "utf8",
    );
    process.env = { ...originalEnv, AGENTS_FILE: agentsFile };
    reloadAgents();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    process.env = originalEnv;
    global.fetch = originalFetch;
    reloadAgents();
    fs.rmSync(agentsDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("staleRePokeRecipientValid is exported from index.ts (will be undefined/missing on main → TypeError)", async () => {
    // On main, staleRePokeRecipientValid is not exported; the value is undefined.
    // The implementer must export it. Until then, this test fails with:
    //   TypeError: staleRePokeRecipientValid is not a function
    expect(typeof staleRePokeRecipientValid).toBe("function");
  });

  it("drops the C4 re-poke when the ticket delegate changed to another agent (AI-1774 self-referential fixture)", async () => {
    // Ticket AI-1774: delegate=Astrid, but stale arm-time agentId=Igor (agent A).
    // The re-poke MUST be dropped: agent A is no longer the delegate.
    restoreFetch = mockIssue({
      id: "issue-ai1774",
      identifier: "AI-1774",
      delegate: { id: AGENT_B.linearUserId, name: AGENT_B.name }, // delegate changed to B
      assignee: null,
      state: { name: "Backlog", type: "backlog" },
      relations: { nodes: [] },
    });

    // staleRePokeRecipientValid(sessionKey, armedAgentId) → false when delegate ≠ armed agent
    await expect(staleRePokeRecipientValid("linear-AI-1774", AGENT_A.name)).resolves.toBe(false);
  });

  it("allows the C4 re-poke when the armed agent is still the current delegate", async () => {
    restoreFetch = mockIssue({
      id: "issue-ai9000",
      identifier: "AI-9000",
      delegate: { id: AGENT_A.linearUserId, name: AGENT_A.name },
      assignee: null,
      state: { name: "Doing", type: "started" },
      relations: { nodes: [] },
    });

    await expect(staleRePokeRecipientValid("linear-AI-9000", AGENT_A.name)).resolves.toBe(true);
  });

  it("drops the C4 re-poke when the delegate was cleared (null delegate — AI-2042 AC5)", async () => {
    // AC5: null delegate → abort, never fall back to the armed session.
    // A delegate ?? armedSession resolver is an explicit non-fix.
    restoreFetch = mockIssue({
      id: "issue-ai9001",
      identifier: "AI-9001",
      delegate: null,
      assignee: null,
      state: { name: "Todo", type: "unstarted" },
      relations: { nodes: [] },
    });

    await expect(staleRePokeRecipientValid("linear-AI-9001", AGENT_A.name)).resolves.toBe(false);
  });

  it("drops the C4 re-poke when the ticket no longer exists (phantom — AI-2015 class)", async () => {
    // Ticket deleted after the session was armed. Existence check at delivery.
    restoreFetch = mockIssue(null);

    await expect(staleRePokeRecipientValid("linear-AI-9999", AGENT_A.name)).resolves.toBe(false);
  });

  it("fails OPEN on a transient Linear error — never silently loses a legitimate resume", async () => {
    // A 503 is transient. Dropping the re-poke on a transient error would
    // strand a legitimate stalled session. Fail open = allow the re-poke.
    global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(staleRePokeRecipientValid("linear-AI-9002", AGENT_A.name)).resolves.toBe(true);
  });

  it("invokes the delivery-time routing check with the 'delegate' reason and returns its verdict", async () => {
    const check = jest
      .fn<(sessionKey: string, agentId: string, reason: "delegate") => Promise<boolean>>()
      .mockResolvedValue(false);

    const result = await staleRePokeRecipientValid("linear-AI-1774", AGENT_A.name, check);
    expect(result).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("linear-AI-1774", AGENT_A.name, "delegate");
  });
});

// ── VECTOR 1 integration (AI-1808): boot path wiring for C4 re-poke gate ───

describe("AI-2091 Vector 1 integration — C4 re-poke gate wired into production path", () => {
  const originalEnv = process.env;
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv, LINEAR_WEBHOOK_SECRET: SECRET };
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_DEVELOPER_TOKEN;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    dir = tempDir("ai2091-v1-int-");
  });

  afterEach(() => {
    closeApp(appState);
    appState = undefined;
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("/health exposes a deliveryTimeRecipientResolution gate field proving the guard is active on the dispatch path", async () => {
    // AI-1808: the gate must be observable without waiting for a live misroute.
    // The implementer adds a /health field (e.g. dispatchIntegrity.deliveryTimeRecipientResolution.active)
    // to prove the guard is wired into the production C4 re-poke path at bootstrap.
    // FAILS on main: field does not exist.
    appState = bootApp(dir);
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body?.dispatchIntegrity?.deliveryTimeRecipientResolution?.active).toBe(true);
  });
});

// ── VECTOR 2: Phantom dispatch / unfetchable ticket (AI-2015 AC1–AC7) ────────
//
// AC: "No wake fires on an unfetchable ticket."
//
// Two sub-cases:
//   a) phantom-dispatch-abort — new operational event vocabulary for first-class
//      abort recording when a ticket is not-found at delivery time.
//   b) C4 re-poke fires for deleted tickets — processStaleSession delivers
//      a re-poke without checking ticket existence. The phantom event type must
//      be emitted and no delivery made.
//
// AI-2015 AC1: Dispatcher verifies ticket fetchable before waking agent;
//   abort + first-class error event on not-found (not a buried warning).
// AI-2015 AC3: Phantom dispatch surfaces as an error event, not a warning.

describe("AI-2091 Vector 2 — phantom-dispatch-abort operational event vocabulary", () => {
  it("OperationalEventStore.append() accepts 'phantom-dispatch-abort' without throwing (AC1/AC3 vocabulary)", () => {
    // FAILS on main: 'phantom-dispatch-abort' is not in OPERATIONAL_EVENT_OUTCOMES.
    const dir = tempDir("ai2091-v2-vocab-");
    const store = new OperationalEventStore(path.join(dir, "vocab.db"));
    expect(() =>
      store.append({
        outcome: "phantom-dispatch-abort" as never,
        type: "Issue",
        agent: AGENT_A.name,
        key: "linear-AI-2014",
        deliveryMode: "watchdog",
        attemptCount: 1,
        errorSummary: "Ticket AI-2014 not found at delivery time — dispatch aborted",
        plane: "connector",
      }),
    ).not.toThrow();
    const events = store.query({ agent: AGENT_A.name, outcome: "phantom-dispatch-abort" as never });
    expect(events).toHaveLength(1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("OperationalEventStore.append() accepts 'stale-c4-repoke-failed' without throwing (vector 1 / AC3 vocabulary)", () => {
    // This outcome is emitted when the C4 re-poke guard drops a misrouted delivery.
    // FAILS on main: 'stale-c4-repoke-failed' is not in OPERATIONAL_EVENT_OUTCOMES.
    const dir = tempDir("ai2091-v2-vocab2-");
    const store = new OperationalEventStore(path.join(dir, "vocab2.db"));
    expect(() =>
      store.append({
        outcome: "stale-c4-repoke-failed" as never,
        agent: AGENT_A.name,
        key: "linear-AI-1774",
        sessionKey: "linear-AI-1774",
        deliveryMode: "stale-c4-repoke",
        attemptCount: 1,
        errorSummary: "C4 re-poke dropped: agent ai2091-agent-a is not the current delegate",
      }),
    ).not.toThrow();
    const events = store.query({ agent: AGENT_A.name, outcome: "stale-c4-repoke-failed" as never });
    expect(events).toHaveLength(1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("AI-2091 Vector 2 integration — phantom dispatch gate wired into production path", () => {
  const originalEnv = process.env;
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv, LINEAR_WEBHOOK_SECRET: SECRET };
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_DEVELOPER_TOKEN;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    dir = tempDir("ai2091-v2-int-");
  });

  afterEach(() => {
    closeApp(appState);
    appState = undefined;
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("/health exposes a preDispatchFetchability gate field proving the guard is active (AI-1808 requirement)", async () => {
    // The implementer adds dispatchIntegrity.preDispatchFetchability.active to /health.
    // FAILS on main: field does not exist.
    appState = bootApp(dir);
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body?.dispatchIntegrity?.preDispatchFetchability?.active).toBe(true);
  });

  it("a webhook for a ticket that cannot be fetched (null issue) emits phantom-dispatch-abort and delivers no session", async () => {
    // Simulates AI-2014: ticket created, deleted, watchdog tries to re-dispatch.
    // The connector dispatches a webhook for this agent then the routing check
    // gets null. The abort must surface as a phantom-dispatch-abort event.
    //
    // Current behavior on main: no hard gate, no phantom-dispatch-abort event.
    // FAILS on main: store never records phantom-dispatch-abort.
    appState = bootApp(dir);
    const store = appState.operationalEventStore as OperationalEventStore;

    // Mock Linear to return null (ticket not found) for any routing check.
    global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: null } }),
    }) as unknown as typeof fetch;

    const body = makeIssuePayload({ identifier: "AI-2014", delegateId: AGENT_A.linearUserId });
    const res = await post(appState.app, body, "delivery-ai2091-phantom-001");
    expect(res.status).toBe(200);
    await waitForSettled(store, "linear-AI-2014");

    // No session should be spawned (no delivery/dispatch-accepted event).
    const delivered = store.query({ key: "linear-AI-2014", outcome: "delivered" as never });
    const dispatched = store.query({ key: "linear-AI-2014", outcome: "dispatch-accepted" as never });
    expect(delivered).toHaveLength(0);
    expect(dispatched).toHaveLength(0);

    // A first-class error event must be recorded — not a buried warning.
    const aborts = store.query({ key: "linear-AI-2014", outcome: "phantom-dispatch-abort" as never });
    expect(aborts.length).toBeGreaterThan(0);
  });
});

// ── VECTOR 3: Duplicate session dispatch (AI-1774) ──────────────────────────
//
// AC: "No single wake produces two sessions."
//
// Root cause (AI-1772 intake race): two concurrent hook jobs for the same
// Linear wake both pass the admission check before either commits the
// idempotency record → two concurrent sessions for one ticket.
// Fix vehicle: DispatchIdempotencyStore (AI-1918), already wired at L798.
// This test pins the concurrent race specifically — sequential replay is
// already covered by AI-1918 AC1 in dispatch-idempotency.test.ts.

describe("AI-2091 Vector 3 — duplicate session dispatch (AI-1774 concurrent intake race)", () => {
  const originalEnv = process.env;
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv, LINEAR_WEBHOOK_SECRET: SECRET };
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_DEVELOPER_TOKEN;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    dir = tempDir("ai2091-v3-");
  });

  afterEach(() => {
    closeApp(appState);
    appState = undefined;
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("two concurrent hook jobs for the same (ticket, state, agent) produce exactly one routed event", async () => {
    // AI-1772 intake race: two webhook deliveries arrive simultaneously for the
    // same ticket (same delivery semantics, different delivery IDs). Only one
    // should be admitted; the second must be suppressed as a duplicate.
    //
    // This differs from the sequential test in AI-1918 AC1: both requests fire
    // before either commits the idempotency record. If the dedup gate has a race
    // window, both may be admitted → FAILS with routedCount > 1.
    appState = bootApp(dir);
    const store = appState.operationalEventStore as OperationalEventStore;

    const body = makeIssuePayload({ identifier: "AI-1772", delegateId: AGENT_A.linearUserId });

    // Fire both requests simultaneously — no await between them.
    const [r1, r2] = await Promise.all([
      post(appState.app, body, "delivery-ai1772-concurrent-A"),
      post(appState.app, body, "delivery-ai1772-concurrent-B"),
    ]);

    await waitForSettled(store, "linear-AI-1772", 6000);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Exactly one dispatch admitted — not two sessions.
    const routedEvents = store.query({ key: "linear-AI-1772", outcome: "routed" as never, limit: 500 });
    expect(routedEvents.filter((e) => e.agent === AGENT_A.name)).toHaveLength(1);
  });

  it("/health dispatchIdempotency.active is true, confirming the dedup gate is wired at bootstrap (AI-1808)", async () => {
    // Already implemented and passing — this is the regression pin so the gate
    // cannot be removed without breaking this test.
    appState = bootApp(dir);
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body?.dispatchIdempotency?.active).toBe(true);
  });
});

// ── VECTOR 4: Stale-snapshot overwrite (AI-2058, P0) ────────────────────────
//
// AC: "No single wake produces two sessions" [implicitly: and no mid-run state
// change gets silently overwritten by an agent acting on a stale snapshot].
//
// Root cause: commandAuthSnapshots (src/index.ts:187) captures the delegate +
// state at first proxy call and passes snapshotDelegateId/snapshotState to
// checkWorkflowRules. But there is no compare-and-swap re-read of CURRENT Linear
// state before a terminal mutation commits. If the ticket delegate or state
// changes between the snapshot and the terminal command, the mutation applies
// against stale context — potentially overwriting the mid-run decision.
//
// AI-2035 added a terminal re-entry guard for the Done→Doing bounce; AI-2058
// extends this to a CAS re-read before ANY mutation commits.

describe("AI-2091 Vector 4 — pre-mutation compare-and-swap re-read (AI-2058, P0)", () => {
  it("OperationalEventStore.append() accepts 'stale-snapshot-mutation-rejected' without throwing", () => {
    // New vocabulary for when a terminal mutation is rejected due to a
    // mid-run delegate or state change.
    // FAILS on main: outcome not in OPERATIONAL_EVENT_OUTCOMES.
    const dir = tempDir("ai2091-v4-vocab-");
    const store = new OperationalEventStore(path.join(dir, "vocab.db"));
    expect(() =>
      store.append({
        outcome: "stale-snapshot-mutation-rejected" as never,
        agent: AGENT_A.name,
        key: "linear-AI-9005",
        deliveryMode: "proxy",
        attemptCount: 1,
        errorSummary: "Mutation rejected: delegate changed mid-run (snapshot had agent-a, current is agent-b)",
      }),
    ).not.toThrow();
    const events = store.query({ agent: AGENT_A.name, outcome: "stale-snapshot-mutation-rejected" as never });
    expect(events).toHaveLength(1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("/health exposes a preMutationCas gate field proving the guard is wired at bootstrap (AI-1808)", async () => {
    // The implementer adds dispatchIntegrity.preMutationCas.active to /health.
    // FAILS on main: field does not exist.
    const dir = tempDir("ai2091-v4-int-");
    const state = bootApp(dir);
    try {
      const res = await request(state.app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body?.dispatchIntegrity?.preMutationCas?.active).toBe(true);
    } finally {
      closeApp(state);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a terminal mutation submitted with a stale snapshot is rejected when the delegate changed mid-run", async () => {
    // Setup:
    //   1. Agent A acts on ticket AI-9005 (snapshot captured: delegate=A, state=implementation).
    //   2. Mid-run, delegate changes to Agent B (webhook arrives; linear state updated).
    //   3. Agent A submits a terminal mutation (continue-workflow / transition command).
    // Expected: mutation rejected with a stale-snapshot error; ticket state unchanged.
    //
    // Current behavior on main: mutation is allowed (no CAS re-read). FAILS.
    //
    // This test goes through the proxy (/proxy/graphql) to exercise the
    // production command path that uses commandAuthSnapshots.

    const dir = tempDir("ai2091-v4-cas-");
    const state = bootApp(dir);
    const store = state.operationalEventStore as OperationalEventStore;

    // Simulate the proxy call with a stale snapshot where delegate changed.
    // The proxy request format: Linear CLI calls /proxy/graphql with the agent's token.
    // The commandAuthSnapshots map is keyed on (ticketId + agentId).
    // We inject a pre-built snapshot for agent A on ticket AI-9005 (state=implementation)
    // then make a terminal call after the Linear state changes to delegate=B.
    //
    // Since we can't easily inject into commandAuthSnapshots from outside createApp,
    // we simulate two sequential proxy calls:
    //   - First call: captures the snapshot (delegate=A, state=implementation).
    //   - Linear webhook arrives changing delegate to B (handled in-process).
    //   - Second call: terminal mutation → must be rejected because snapshot is stale.

    const originalFetch = global.fetch;
    try {
      // Phase 1: ticket is live with delegate=A.
      global.fetch = jest.fn<(...args: Parameters<typeof fetch>) => Promise<any>>()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              issue: {
                id: "issue-ai9005",
                identifier: "AI-9005",
                delegate: { id: AGENT_A.linearUserId, name: AGENT_A.name },
                state: { name: "implementation", type: "started" },
              },
              issueUpdate: { success: true },
            },
          }),
        }) as unknown as typeof fetch;

      // Phase 2: after the mid-run delegate change, Linear now returns delegate=B.
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            issue: {
              id: "issue-ai9005",
              identifier: "AI-9005",
              delegate: { id: AGENT_B.linearUserId, name: AGENT_B.name }, // changed!
              state: { name: "implementation", type: "started" },
            },
          },
        }),
      });

      // Attempt a terminal proxy mutation as Agent A on AI-9005.
      // This goes through /proxy/graphql with Agent A's token.
      const mutationBody = JSON.stringify({
        query: `mutation { issueUpdate(id: "issue-ai9005", input: { stateId: "state-done" }) { success issue { id } } }`,
        variables: {},
      });

      const proxyRes = await request(state.app)
        .post("/proxy/graphql")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${AGENT_A.accessToken}`)
        .set("X-Ticket-Id", "AI-9005")
        .send(mutationBody);

      // The CAS re-read should detect the delegate change and reject the mutation.
      // Before fix: the mutation is allowed (proxy returns 200, Linear mutation applied).
      // After fix: rejected with a stale-snapshot error (4xx or error body).
      //
      // FAILS on main: proxy returns 200 (mutation allowed with stale snapshot).
      expect([400, 409, 422, 403]).toContain(proxyRes.status);

      // Stale-snapshot rejection must also surface as an operational event.
      const rejections = store.query({
        key: "linear-AI-9005",
        outcome: "stale-snapshot-mutation-rejected" as never,
        limit: 50,
      });
      expect(rejections.length).toBeGreaterThan(0);
    } finally {
      global.fetch = originalFetch;
      closeApp(state);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AI-1808: comprehensive boot-path wiring integration ─────────────────────
//
// Per Astrid's addendum: each of the four gates must be reachable from the
// production dispatch path at server bootstrap and provable by booting
// createApp (the real entry point, not mocked modules). The /health endpoint
// must surface all four gate liveness fields so ac-validate can confirm
// enforcement without waiting for a live misroute.

describe("AI-2091 AI-1808 — all four dispatch-integrity gates are observable at /health after bootstrap", () => {
  const originalEnv = process.env;
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv, LINEAR_WEBHOOK_SECRET: SECRET };
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_DEVELOPER_TOKEN;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    dir = tempDir("ai2091-1808-");
    appState = bootApp(dir);
  });

  afterEach(() => {
    closeApp(appState);
    appState = undefined;
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dispatches a webhook event through the production path and observes all four gate liveness fields on /health", async () => {
    // One webhook call exercises the production dispatch path. After it processes,
    // all four gate liveness fields must be present on /health.
    //
    // FAILS on main: dispatchIntegrity block does not exist; three of the four
    // gates are not implemented yet.
    const body = makeIssuePayload({ identifier: "AI-2091", delegateId: AGENT_A.linearUserId });
    const res = await post(appState!.app, body, "delivery-ai2091-1808-smoke");
    expect(res.status).toBe(200);

    const health = await request(appState!.app).get("/health");
    expect(health.status).toBe(200);

    const di = health.body?.dispatchIntegrity;
    expect(di).toBeDefined();

    // Gate 1: delivery-time recipient resolution (vector 1)
    expect(di?.deliveryTimeRecipientResolution?.active).toBe(true);

    // Gate 2: pre-dispatch fetchability (vector 2)
    expect(di?.preDispatchFetchability?.active).toBe(true);

    // Gate 3: wake→session dedup (vector 3 — already partially visible via
    // dispatchIdempotency, but a named gate in dispatchIntegrity is required
    // to align with gates 1, 2, 4 under the same observable surface)
    expect(di?.wakeDedupGate?.active).toBe(true);

    // Gate 4: pre-mutation CAS re-read (vector 4)
    expect(di?.preMutationCas?.active).toBe(true);
  });
});
