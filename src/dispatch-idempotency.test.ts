/**
 * AI-1918 — Connector dispatch idempotency + stale-dispatch guard.
 *
 * FAILING (RED) TDD tests, authored before implementation. They cover the
 * verbatim acceptance criteria captured at intake (2026-07-07). Each test /
 * describe block maps back to the AC it proves; the implementer (igor) makes
 * them pass without weakening any assertion.
 *
 * -------------------------------------------------------------------------
 * Verbatim AC of record (AI-1918):
 *   1. Dispatch dedup: connector deduplicates dispatches keyed on
 *      (ticket, workflow state or event id, target agent) within a bounded
 *      window — one event produces at most one wake per target agent. Proven
 *      by a test that replays the same webhook twice and asserts a single
 *      dispatch.
 *   2. Stale-dispatch guard: a dispatch carries the ticket state (or updatedAt)
 *      it was generated from; if the ticket has advanced past it by delivery/
 *      wake time, the dispatch is dropped (or re-generated against current
 *      state) with an operational event.
 *   3. Observability: suppressed duplicates and dropped stale dispatches are
 *      visible as operational events (count on /health or the ops feed).
 *   4. Root cause of the fan-out (one event → two sessions) is identified and
 *      covered by a regression test. Identified causes (per intake / AI-1774):
 *      double webhook delivery and queue/bag replay on service restart
 *      ("restart-echo") re-dispatching undrained work through a path that
 *      bypasses the per-request dedup. The AC4 regression pins the durable,
 *      cross-process guarantee: the idempotency record survives a connector
 *      restart, so a second (restarted / concurrent) process does not re-wake.
 *   5. Bootstrap wiring (AI-1808 standard criterion): the dedup/stale-guard
 *      layer is registered at server bootstrap (reachable from the production
 *      entry point) and sits in the live webhook→dispatch path, proven by an
 *      integration test that boots the entry point (createApp) and asserts
 *      dispatches flow through the layer; liveness is observable at /health
 *      without waiting for a real duplicate event.
 * -------------------------------------------------------------------------
 *
 * TEST-ENV NOTES (verified against the current code):
 *   - Signature/normalize/route run offline. The `routed` operational event is
 *     emitted BEFORE the pre-flight liveness check, so it is deterministic even
 *     though CLI-mode liveness fails without a Linear token (which blocks the
 *     later `bag-added`/delivery). We therefore observe dispatch *admission* via
 *     the `routed` event and observe suppression/drop via the new /health
 *     counters and operational-event vocabulary.
 *   - A `routed` event means "this dispatch passed the dedup + stale guards and
 *     was admitted." Zero `routed` for a target means the dispatch was
 *     suppressed/dropped before admission.
 */

import crypto from "crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { OperationalEventStore } from "./store/operational-event-store.js";

const SECRET = "test-ai1918-idempotency-secret";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Two test agents. Routing matches the payload delegate.id against the agent's
// linearUserId (see router.extractAgentTarget → buildAgentMap).
// accessToken/refreshToken are intentionally empty so getAccessToken() is
// falsy: the routing/role-guard token resolves to nothing and the suite makes
// no api.linear.app calls (hermetic + fast). Routing matches on linearUserId.
const AGENT_X = {
  name: "tddtest-x",
  linearUserId: "user-x-0001",
  openclawAgent: "tddtest-x",
  clientId: "client-x",
  clientSecret: "secret-x",
  accessToken: "",
  refreshToken: "",
  host: "local" as const,
};
const AGENT_Y = {
  name: "tddtest-y",
  linearUserId: "user-y-0002",
  openclawAgent: "tddtest-y",
  clientId: "client-y",
  clientSecret: "secret-y",
  accessToken: "",
  refreshToken: "",
  host: "local" as const,
};

function writeAgentsFile(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents: [AGENT_X, AGENT_Y] }), "utf8");
  return file;
}

interface PayloadOpts {
  identifier: string;
  delegateId: string;
  stateName?: string;
  updatedAt?: string;
}

function makeIssuePayload(opts: PayloadOpts): string {
  const { identifier, delegateId, stateName = "write-tests", updatedAt = "2026-07-07T07:00:00.000Z" } = opts;
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-07-07T06:00:00.000Z",
    actor: { id: "human-actor-1", name: "Matt" },
    data: {
      id: `issue-${identifier}`,
      identifier,
      title: "Idempotency test issue",
      state: { id: "state-1", name: stateName, type: "started" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "t1", key: "AI" },
      labelIds: [],
      url: `https://linear.app/test/issue/${identifier}`,
      assignee: { id: "assignee-1", name: "Assignee" },
      delegate: { id: delegateId, name: "Delegate Agent" },
      createdAt: "2026-07-07T06:00:00.000Z",
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
    bagDbPath: path.join(dir, "pending-bag.db"),
    agentQueueDbPath: path.join(dir, "agent-queue.db"),
    operationalEventsDbPath: path.join(dir, "operational-events.db"),
    // Persistent idempotency store — shared across a simulated restart in AC4.
    // Unknown to the current implementation (ignored at runtime); the
    // implementer wires this option into the dedup/stale-guard layer.
    idempotencyDbPath: path.join(dir, "dispatch-idempotency.db"),
  } as Parameters<typeof createApp>[0]);
}

function closeApp(state: ReturnType<typeof createApp> | undefined): void {
  state?.bag?.close();
  state?.sessionTracker?.close();
  state?.agentQueue?.close();
  state?.operationalEventStore?.close();
}

/** Count admitted dispatches (passed dedup + stale guard) for an agent. */
function routedCount(store: OperationalEventStore, agent: string, key?: string): number {
  return store.query({ agent, outcome: "routed" as never, key, limit: 500 }).length;
}

/**
 * The webhook handler acks 200 and then routes/dispatches asynchronously.
 * Wait until the operational events for a ticket key have settled (count stable
 * and non-zero) so assertions observe the completed dispatch outcome.
 */
async function waitForSettled(store: OperationalEventStore, key: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  let last = -1;
  let stableSince = start;
  while (Date.now() - start < timeoutMs) {
    const n = store.query({ key, limit: 500 }).length;
    if (n === last) {
      if (n > 0 && Date.now() - stableSince >= 250) return;
    } else {
      last = n;
      stableSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("AI-1918 — dispatch idempotency + stale guard", () => {
  const originalEnv = process.env;
  let dir: string;
  let app: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    // Ensure no Linear token / hooks so the path stays offline & deterministic.
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_DEVELOPER_TOKEN;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    dir = tempDir("ai1918-");
  });

  afterEach(() => {
    closeApp(app);
    app = undefined;
    delete process.env.AGENTS_FILE;
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC3: observability vocabulary ────────────────────────────────────────
  // Suppressed duplicates and dropped stale dispatches must be recordable as
  // first-class operational events. The store's append() throws on unknown
  // outcomes, so this is RED until the vocabulary is added.
  describe("AC3 — operational-event vocabulary for suppression / drop", () => {
    it("append() accepts a 'suppressed-duplicate' operational event", () => {
      const store = new OperationalEventStore(path.join(dir, "vocab-dup.db"));
      expect(() =>
        store.append({
          outcome: "suppressed-duplicate" as never,
          type: "Issue",
          agent: AGENT_X.name,
          key: "linear-AI-9001",
          workflowState: "write-tests",
          plane: "connector",
        }),
      ).not.toThrow();
      const events = store.query({ agent: AGENT_X.name, outcome: "suppressed-duplicate" as never });
      expect(events).toHaveLength(1);
      store.close();
    });

    it("append() accepts a 'dropped-stale' operational event", () => {
      const store = new OperationalEventStore(path.join(dir, "vocab-stale.db"));
      expect(() =>
        store.append({
          outcome: "dropped-stale" as never,
          type: "Issue",
          agent: AGENT_X.name,
          key: "linear-AI-9002",
          workflowState: "write-tests",
          plane: "connector",
        }),
      ).not.toThrow();
      const events = store.query({ agent: AGENT_X.name, outcome: "dropped-stale" as never });
      expect(events).toHaveLength(1);
      store.close();
    });
  });

  // ── AC1: dedup on (ticket, state, agent), replay twice → one dispatch ─────
  describe("AC1 — replaying the same webhook twice produces a single dispatch", () => {
    it("admits exactly one dispatch and records the duplicate on /health", async () => {
      dir = tempDir("ai1918-ac1-");
      app = bootApp(dir);
      const store = app.operationalEventStore as OperationalEventStore;

      const before = await request(app.app).get("/health");
      const suppressedBefore = before.body?.dispatchIdempotency?.suppressedDuplicates ?? 0;

      const body = makeIssuePayload({ identifier: "AI-1811", delegateId: AGENT_X.linearUserId });
      // Same logical event, two distinct delivery ids (real double-delivery).
      const r1 = await post(app.app, body, "delivery-ac1-a");
      await waitForSettled(store, "linear-AI-1811");
      const r2 = await post(app.app, body, "delivery-ac1-b");
      await waitForSettled(store, "linear-AI-1811");
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Exactly one dispatch admitted for the target agent (one wake).
      expect(routedCount(store, AGENT_X.name)).toBe(1);

      // The suppressed duplicate is visible as a counted operational event.
      const after = await request(app.app).get("/health");
      const suppressedAfter = after.body?.dispatchIdempotency?.suppressedDuplicates ?? 0;
      expect(suppressedAfter).toBeGreaterThan(suppressedBefore);
    });
  });

  // ── AC2: stale-dispatch guard ────────────────────────────────────────────
  // A dispatch generated from an older ticket snapshot must be dropped once the
  // ticket has advanced. Scenario mirrors AI-1857: ticket AI-1857 advances (a
  // newer update lands, updatedAt=T2), then a delayed/older snapshot (T1 < T2)
  // for the same ticket arrives — it must NOT wake an agent on the obsolete
  // snapshot; it is dropped with a `dropped-stale` operational event.
  describe("AC2 — a dispatch built from a superseded snapshot is dropped", () => {
    it("drops the stale (older-updatedAt) dispatch and counts it on /health", async () => {
      dir = tempDir("ai1918-ac2-");
      app = bootApp(dir);
      const store = app.operationalEventStore as OperationalEventStore;

      const before = await request(app.app).get("/health");
      const droppedBefore = before.body?.dispatchIdempotency?.droppedStale ?? 0;

      // Newer snapshot first (ticket advances) → establishes latest-seen state.
      const newer = makeIssuePayload({
        identifier: "AI-1857",
        delegateId: AGENT_Y.linearUserId,
        stateName: "ac-validate",
        updatedAt: "2026-07-07T06:44:00.000Z",
      });
      const rNew = await post(app.app, newer, "delivery-ac2-newer");
      await waitForSettled(store, "linear-AI-1857");
      expect(rNew.status).toBe(200);

      // Older snapshot of the SAME ticket, delivered late (updatedAt < newer),
      // routed to a different agent — the obsolete session-B wake.
      const older = makeIssuePayload({
        identifier: "AI-1857",
        delegateId: AGENT_X.linearUserId,
        stateName: "write-tests",
        updatedAt: "2026-07-07T06:37:00.000Z",
      });
      const rOld = await post(app.app, older, "delivery-ac2-older");
      // Wait until AGENT_X's dispatch has settled to a terminal outcome
      // (admitted → routed, or dropped → dropped-stale).
      await waitForSettled(store, "linear-AI-1857");
      await new Promise((r) => setTimeout(r, 200));
      expect(rOld.status).toBe(200);

      // The stale dispatch to AGENT_X must never be admitted.
      expect(routedCount(store, AGENT_X.name)).toBe(0);

      // ...and its drop is observable as a counted operational event.
      const after = await request(app.app).get("/health");
      const droppedAfter = after.body?.dispatchIdempotency?.droppedStale ?? 0;
      expect(droppedAfter).toBeGreaterThan(droppedBefore);
    });
  });

  // ── AC4: root-cause regression — durable, cross-restart idempotency ───────
  // The observed fan-out (one event → two concurrent sessions) is driven in
  // part by queue/bag replay on service restart re-dispatching undrained work,
  // bypassing the per-process/per-request dedup. The idempotency record must be
  // DURABLE: a connector that restarts (fresh process → fresh in-memory + fresh
  // default-path stores) must still recognize an already-dispatched
  // (ticket, state, agent) and suppress the re-wake. Modeled here as two
  // createApp instances with distinct DATA_DIRs (distinct event/nudge stores,
  // i.e. a fresh process) that SHARE the persistent idempotency store path.
  describe("AC4 — idempotency survives a connector restart (no restart-echo re-wake)", () => {
    it("a restarted instance does not re-admit an already-dispatched event", async () => {
      const shared = tempDir("ai1918-ac4-shared-");
      const dirA = tempDir("ai1918-ac4-a-");
      const dirB = tempDir("ai1918-ac4-b-");
      const idempotencyDbPath = path.join(shared, "dispatch-idempotency.db");

      process.env.AGENTS_FILE = writeAgentsFile(shared);
      reloadAgents();

      const body = makeIssuePayload({ identifier: "AI-1903", delegateId: AGENT_X.linearUserId });

      // ── Instance A (first boot) ──
      process.env.DATA_DIR = dirA;
      const appA = createApp({
        bagDbPath: path.join(dirA, "pending-bag.db"),
        agentQueueDbPath: path.join(dirA, "agent-queue.db"),
        operationalEventsDbPath: path.join(dirA, "operational-events.db"),
        idempotencyDbPath,
      } as Parameters<typeof createApp>[0]);
      const storeA = appA.operationalEventStore as OperationalEventStore;
      const rA = await post(appA.app, body, "delivery-ac4-boot-a");
      await waitForSettled(storeA, "linear-AI-1903");
      expect(rA.status).toBe(200);
      expect(routedCount(storeA, AGENT_X.name)).toBe(1); // admitted once
      closeApp(appA);

      // ── Instance B (restart: fresh process, fresh DATA_DIR, SAME idempotency store) ──
      process.env.DATA_DIR = dirB;
      const appB = createApp({
        bagDbPath: path.join(dirB, "pending-bag.db"),
        agentQueueDbPath: path.join(dirB, "agent-queue.db"),
        operationalEventsDbPath: path.join(dirB, "operational-events.db"),
        idempotencyDbPath,
      } as Parameters<typeof createApp>[0]);
      const storeB = appB.operationalEventStore as OperationalEventStore;
      const rB = await post(appB.app, body, "delivery-ac4-boot-b");
      await waitForSettled(storeB, "linear-AI-1903");
      await new Promise((r) => setTimeout(r, 200));
      expect(rB.status).toBe(200);

      // The restarted instance must NOT admit a second dispatch for the same
      // (ticket, state, agent) — this is the restart-echo fan-out being fixed.
      expect(routedCount(storeB, AGENT_X.name)).toBe(0);

      closeApp(appB);
      for (const d of [shared, dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
    });
  });

  // ── AC5: bootstrap wiring + /health liveness ─────────────────────────────
  // Boots the production entry-point app factory and asserts the dedup/stale
  // layer is (a) registered with an observable liveness field, and (b) actually
  // in the live webhook→dispatch path (a real duplicate through POST / moves the
  // counter). A module-level unit test does not satisfy this.
  describe("AC5 — layer registered at bootstrap and live in the dispatch path", () => {
    it("/health exposes an active dispatchIdempotency liveness field", async () => {
      dir = tempDir("ai1918-ac5-live-");
      app = bootApp(dir);

      const res = await request(app.app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.dispatchIdempotency).toBeDefined();
      expect(res.body.dispatchIdempotency.active).toBe(true);
      expect(typeof res.body.dispatchIdempotency.suppressedDuplicates).toBe("number");
      expect(typeof res.body.dispatchIdempotency.droppedStale).toBe("number");
    });

    it("a duplicate through the live POST / path increments the /health counter", async () => {
      dir = tempDir("ai1918-ac5-path-");
      app = bootApp(dir);

      const before = await request(app.app).get("/health");
      const suppressedBefore = before.body.dispatchIdempotency.suppressedDuplicates;

      const store = app.operationalEventStore as OperationalEventStore;
      const body = makeIssuePayload({ identifier: "AI-1918", delegateId: AGENT_X.linearUserId });
      await post(app.app, body, "delivery-ac5-a");
      await waitForSettled(store, "linear-AI-1918");
      await post(app.app, body, "delivery-ac5-b");
      await waitForSettled(store, "linear-AI-1918");

      const after = await request(app.app).get("/health");
      expect(after.body.dispatchIdempotency.suppressedDuplicates).toBeGreaterThan(suppressedBefore);
    });
  });
});

// ── AI-1969: workflow re-entry must re-dispatch ─────────────────────────────
// Root cause of the AI-1965 incident (Hanzo merge-gate "unresponsive"): the
// AI-1918 store suppressed same-OR-NEWER updatedAt for a previously seen
// (ticket, state, agent) key, so a second legitimate handoff to the same agent
// in the same state (merge-conflict bounce → rebase → re-approve) was swallowed
// forever. Only an IDENTICAL updatedAt (true webhook replay / restart echo) may
// be suppressed; a strictly newer snapshot is a new event and must wake.
describe("AI-1969 — re-entry dispatch with a newer updatedAt is admitted", () => {
  let dir: string | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  afterEach(() => {
    closeApp(app);
    app = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("admits leg 2 (newer updatedAt, same ticket/state/agent), still suppresses its replay", async () => {
    dir = tempDir("ai1969-reentry-");
    app = bootApp(dir);
    const store = app.operationalEventStore as OperationalEventStore;

    // Leg 1: first handoff — admitted.
    const leg1 = makeIssuePayload({
      identifier: "AI-1969",
      delegateId: AGENT_X.linearUserId,
      updatedAt: "2026-07-07T15:54:10.000Z",
    });
    await post(app.app, leg1, "delivery-ai1969-leg1");
    await waitForSettled(store, "linear-AI-1969");
    expect(routedCount(store, AGENT_X.name)).toBe(1);

    // Leg 2: bounce cycle re-enters the same state with the same delegate,
    // hours later (strictly newer updatedAt) — MUST be admitted (the bug
    // suppressed this forever).
    const leg2 = makeIssuePayload({
      identifier: "AI-1969",
      delegateId: AGENT_X.linearUserId,
      updatedAt: "2026-07-08T04:46:06.000Z",
    });
    await post(app.app, leg2, "delivery-ai1969-leg2");
    await waitForSettled(store, "linear-AI-1969");
    expect(routedCount(store, AGENT_X.name)).toBe(2);

    // Replay of leg 2 (identical updatedAt, new delivery id) — suppressed.
    const before = await request(app.app).get("/health");
    await post(app.app, leg2, "delivery-ai1969-leg2-replay");
    await waitForSettled(store, "linear-AI-1969");
    expect(routedCount(store, AGENT_X.name)).toBe(2);
    const after = await request(app.app).get("/health");
    expect(after.body.dispatchIdempotency.suppressedDuplicates).toBeGreaterThan(
      before.body?.dispatchIdempotency?.suppressedDuplicates ?? 0,
    );

    // A delayed OLDER snapshot (leg 1 again) — dropped stale, not re-dispatched.
    await post(app.app, leg1, "delivery-ai1969-leg1-late");
    await waitForSettled(store, "linear-AI-1969");
    expect(routedCount(store, AGENT_X.name)).toBe(2);
  });
});
