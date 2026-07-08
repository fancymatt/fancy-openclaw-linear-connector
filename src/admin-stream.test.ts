/**
 * AI-1952: Console SSE live refresh — failing tests (write-tests phase).
 *
 * AC1: /admin/api/stream rejects unauthenticated requests; streams heartbeats +
 *      named events when authenticated (header and cookie auth).
 * AC2: Alert insert, dispatch ack, and webhook event ingest each emit their
 *      topic event (integration test on the booted app).
 * AC5: The stream endpoint is behind the same auth gate as all /api/* routes.
 *
 * All tests are RED until admin-stream.ts is implemented and wired into
 * admin.ts / index.ts.
 */

import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { notify, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { mintSessionToken } from "./admin-session.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-stream-test-"));
}

const ADMIN_SECRET = "stream-test-secret-xyz";

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "sage",
          linearUserId: "user-sage-12345678",
          openclawAgent: "sage",
          clientId: "cid",
          clientSecret: "csecret",
          accessToken: "atoken",
          refreshToken: "rtoken",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function webhookBody(): string {
  return JSON.stringify({
    type: "Issue",
    action: "create",
    createdAt: new Date().toISOString(),
    actor: { id: "a1", name: "Test" },
    data: {
      id: "i-stream-1",
      identifier: "AI-9999",
      title: "SSE stream test event",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "t1", key: "AI" },
      labelIds: [],
      url: "https://linear.app/test/AI-9999",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
}

function signWebhook(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

/** Collect raw SSE bytes from a live HTTP server, then close the connection. */
function collectSseEvents(
  server: http.Server,
  path: string,
  headers: Record<string, string>,
  windowMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as AddressInfo;
    const chunks: string[] = [];
    const req = http.get(
      { hostname: "127.0.0.1", port: addr.port, path, headers },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(chunk));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      resolve(chunks.join(""));
    }, windowMs);
  });
}

// ── Test state ─────────────────────────────────────────────────────────────

let dir: string;
let appState: ReturnType<typeof createApp>;
let server: http.Server;

beforeEach(() => {
  dir = tempDir();
  process.env.AGENTS_FILE = writeAgents(dir);
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  process.env.LINEAR_WEBHOOK_SECRET = "webhook-stream-test-secret";
  _resetAlertBusForTests();
  reloadAgents();
  appState = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "opevents.db"),
  });
  server = http.createServer(appState.app);
  server.listen(0);
});

afterEach((done) => {
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  _resetAlertBusForTests();
  delete process.env.AGENTS_FILE;
  delete process.env.ADMIN_SECRET;
  delete process.env.LINEAR_WEBHOOK_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
  server.close(done);
});

// ── AC1 / AC5: Auth gate ───────────────────────────────────────────────────

describe("AI-1952 AC1/AC5: /admin/api/stream auth gate", () => {
  test("rejects unauthenticated request with 401", async () => {
    const res = await request(appState.app).get("/admin/api/stream");
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong secret with 401", async () => {
    const res = await request(appState.app)
      .get("/admin/api/stream")
      .set("x-admin-secret", "wrong-secret");
    expect(res.status).toBe(401);
  });

  test("returns 503 when ADMIN_SECRET is not configured", async () => {
    delete process.env.ADMIN_SECRET;
    const res = await request(appState.app)
      .get("/admin/api/stream")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(503);
  });

  test("accepts x-admin-secret header and returns SSE content-type", async () => {
    const raw = await collectSseEvents(
      server,
      "/admin/api/stream",
      { "x-admin-secret": ADMIN_SECRET },
      300,
    );
    // If the endpoint doesn't exist we'd get an empty or HTML response.
    // A valid SSE connection must use text/event-stream.
    expect(raw).toContain("text/event-stream");
  });

  test("accepts valid session cookie and returns SSE content-type", async () => {
    const token = mintSessionToken(ADMIN_SECRET);
    const raw = await collectSseEvents(
      server,
      "/admin/api/stream",
      { "cookie": `admin_session=${token}` },
      300,
    );
    expect(raw).toContain("text/event-stream");
  });

  test("accepts Bearer token and returns SSE content-type", async () => {
    const raw = await collectSseEvents(
      server,
      "/admin/api/stream",
      { "authorization": `Bearer ${ADMIN_SECRET}` },
      300,
    );
    expect(raw).toContain("text/event-stream");
  });
});

// ── AC1: Heartbeat ─────────────────────────────────────────────────────────

describe("AI-1952 AC1: SSE heartbeat", () => {
  test("stream emits SSE comment heartbeat within response", async () => {
    // Heartbeat cadence is ~25s in production, but the endpoint should emit
    // one immediately (or a keepalive) so the client knows it's connected.
    const raw = await collectSseEvents(
      server,
      "/admin/api/stream",
      { "x-admin-secret": ADMIN_SECRET },
      500,
    );
    // SSE comment lines start with ':'
    expect(raw).toMatch(/^:/m);
  });

  test("stream keeps Content-Type text/event-stream and no-cache headers", async () => {
    const addr = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/admin/api/stream",
          headers: { "x-admin-secret": ADMIN_SECRET },
        },
        (res) => {
          try {
            expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
            expect(res.headers["cache-control"]).toMatch(/no-cache/);
            resolve();
          } catch (err) {
            reject(err);
          } finally {
            req.destroy();
          }
        },
      );
      req.on("error", reject);
    });
  });
});

// ── AC2: Integration — events emitted by internal signals ─────────────────

describe("AI-1952 AC2: SSE topics emitted on internal signals (booted app)", () => {
  test("alert insert emits 'alerts' topic event to connected SSE clients", async () => {
    const collectPromise = collectSseEvents(
      server,
      "/admin/api/stream",
      { "x-admin-secret": ADMIN_SECRET },
      600,
    );

    // Allow the SSE connection to establish before triggering the signal.
    await new Promise((r) => setTimeout(r, 80));

    notify({
      severity: "warning",
      source: "test",
      title: "AI-1952 stream integration test alert",
      dedupKey: `test|stream-ac2|${Date.now()}`,
    });

    const raw = await collectPromise;
    // Expect an SSE event with the "alerts" topic name.
    expect(raw).toMatch(/^event:\s*alerts/m);
  });

  test("dispatch ack record emits 'fleet' topic event to connected SSE clients", async () => {
    const collectPromise = collectSseEvents(
      server,
      "/admin/api/stream",
      { "x-admin-secret": ADMIN_SECRET },
      600,
    );

    await new Promise((r) => setTimeout(r, 80));

    // recordDispatch() is the internal signal for a new dispatch ack write.
    appState.ackTracker.recordDispatch("sage", "AI-9998");

    const raw = await collectPromise;
    // Dispatch acks affect fleet status (active dispatches / agent load).
    expect(raw).toMatch(/^event:\s*fleet/m);
  });

  test("webhook event ingest emits 'events' topic event to connected SSE clients", async () => {
    const collectPromise = collectSseEvents(
      server,
      "/admin/api/stream",
      { "x-admin-secret": ADMIN_SECRET },
      800,
    );

    await new Promise((r) => setTimeout(r, 80));

    const body = webhookBody();
    const sig = signWebhook(body, process.env.LINEAR_WEBHOOK_SECRET!);
    await request(appState.app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sig)
      .send(body);

    const raw = await collectPromise;
    expect(raw).toMatch(/^event:\s*events/m);
  });
});

// ── AC2 + background-component rule: booted app registers the stream ───────

describe("AI-1952 AC2/bootstrap: admin-stream module is wired at boot", () => {
  test("createApp registers /admin/api/stream (not 404)", async () => {
    // 401 means the route exists but rejected auth — correct.
    // 404 means the route was never registered (admin-stream.ts not wired).
    const res = await request(appState.app).get("/admin/api/stream");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});
