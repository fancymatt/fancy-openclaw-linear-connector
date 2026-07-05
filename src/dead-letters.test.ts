/**
 * AI-1772: Admin console dead-letter view for failed dispatches.
 *
 * Tests for GET /admin/api/dead-letters — auth, filter coverage, response
 * shape, and SPA route. Written to be RED before implementation.
 *
 * AC mapping:
 *   AC1 — auth tests (unauthenticated → 401; header-secret → 200; cookie-session → 200)
 *   AC2 — filter tests (kind/agent/ticket/since/limit; dead-letter source scoping)
 *   AC3 — SPA route test (/admin/dead-letters serves index.html)
 *   AC4 — proved by this suite
 *   AC5 — dist rebuild check (web/dist/index.html references dead-letters)
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { AlertStore } from "./alerts/alert-store.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";

const ADMIN_SECRET = "dead-letters-test-secret";

function adminGet(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).get(route).set("x-admin-secret", ADMIN_SECRET);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dead-letters-test-"));
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "sage",
      linearUserId: "user-sage-12345678",
      openclawAgent: "sage",
      clientId: "cid",
      clientSecret: "csec",
      accessToken: "tok",
      refreshToken: "ref",
      host: "local",
    }],
  }), "utf8");
  return file;
}

describe("dead-letters API — AI-1772", () => {
  let dir: string;
  let webDist: string;
  let appState: ReturnType<typeof createApp>;
  let alertStore: AlertStore;

  beforeEach(() => {
    dir = tempDir();
    webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(
      path.join(webDist, "index.html"),
      "<!doctype html><title>Linear Connector Console</title><div id=\"root\"></div>",
      "utf8",
    );
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    reloadAgents();

    alertStore = new AlertStore(":memory:");
    initAlertBus({ store: alertStore, pushEnabled: false });

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });
  });

  afterEach(() => {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    alertStore.close();
    _resetAlertBusForTests();
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1: Auth ──────────────────────────────────────────────────────────────

  test("AC1: unauthenticated request returns 401", async () => {
    const res = await request(appState.app).get("/admin/api/dead-letters");
    expect(res.status).toBe(401);
  });

  test("AC1: header-secret auth returns 200", async () => {
    const res = await request(appState.app)
      .get("/admin/api/dead-letters")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
  });

  test("AC1: cookie-session auth returns 200", async () => {
    const login = await request(appState.app)
      .post("/admin/api/login")
      .send({ password: ADMIN_SECRET });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers["set-cookie"][0].split(";")[0];

    const res = await request(appState.app)
      .get("/admin/api/dead-letters")
      .set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
  });

  // ── AC2: Source scoping ────────────────────────────────────────────────────

  test("AC2: unfiltered results are scoped to dead-letter sources (dispatch + routing) only", async () => {
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", agent: "sage" }, 0);
    alertStore.record({ severity: "warning", source: "routing", title: "no-route", agent: "igor" }, 0);
    // Non-dead-letter source — must NOT appear in dead-letters endpoint
    alertStore.record({ severity: "warning", source: "config-health", title: "schema-drift" }, 0);

    const res = await adminGet(appState.app, "/admin/api/dead-letters");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);

    const kinds: string[] = res.body.items.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("dispatch");
    expect(kinds).toContain("routing");
    expect(kinds).not.toContain("config-health");
  });

  test("AC2: results are ordered newest-first", async () => {
    const earlier = new Date(Date.now() - 10_000);
    const later = new Date();
    alertStore.record({ severity: "critical", source: "dispatch", title: "first" }, 0, earlier);
    alertStore.record({ severity: "critical", source: "dispatch", title: "second" }, 0, later);

    const res = await adminGet(appState.app, "/admin/api/dead-letters");
    expect(res.status).toBe(200);
    const titles: string[] = res.body.items.map((r: { title: string }) => r.title);
    expect(titles[0]).toBe("second");
    expect(titles[1]).toBe("first");
  });

  // ── AC2: kind filter maps to store source ─────────────────────────────────

  test("AC2: kind=dispatch returns only dispatch rows", async () => {
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted" }, 0);
    alertStore.record({ severity: "warning", source: "routing", title: "no-route" }, 0);

    const res = await adminGet(appState.app, "/admin/api/dead-letters?kind=dispatch");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((r: { kind: string }) => r.kind === "dispatch")).toBe(true);
  });

  test("AC2: kind=routing returns only routing rows", async () => {
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted" }, 0);
    alertStore.record({ severity: "warning", source: "routing", title: "no-route" }, 0);

    const res = await adminGet(appState.app, "/admin/api/dead-letters?kind=routing");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((r: { kind: string }) => r.kind === "routing")).toBe(true);
  });

  // ── AC2: agent filter ──────────────────────────────────────────────────────

  test("AC2: agent filter narrows to matching agent", async () => {
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", agent: "sage", ticket: "AI-101" }, 0);
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", agent: "igor", ticket: "AI-102" }, 0);

    const res = await adminGet(appState.app, "/admin/api/dead-letters?agent=sage");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].agent).toBe("sage");
  });

  // ── AC2: ticket filter ────────────────────────────────────────────────────

  test("AC2: ticket filter narrows to matching ticket", async () => {
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", ticket: "AI-500" }, 0);
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", ticket: "AI-501" }, 0);

    const res = await adminGet(appState.app, "/admin/api/dead-letters?ticket=AI-500");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].ticket).toBe("AI-500");
  });

  // ── AC2: since filter ──────────────────────────────────────────────────────

  test("AC2: since filter excludes events before the cutoff", async () => {
    const longAgo = new Date(Date.now() - 120_000);
    alertStore.record({ severity: "critical", source: "dispatch", title: "old-alert" }, 0, longAgo);

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const res = await adminGet(appState.app, `/admin/api/dead-letters?since=${encodeURIComponent(cutoff)}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  test("AC2: since filter includes events at or after the cutoff", async () => {
    alertStore.record({ severity: "critical", source: "dispatch", title: "recent-alert" }, 0);

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const res = await adminGet(appState.app, `/admin/api/dead-letters?since=${encodeURIComponent(cutoff)}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  // ── AC2: limit capped server-side ─────────────────────────────────────────

  test("AC2: limit parameter is respected and capped server-side", async () => {
    for (let i = 0; i < 6; i++) {
      alertStore.record({ severity: "critical", source: "dispatch", title: `alert-${i}` }, 0);
    }

    const res = await adminGet(appState.app, "/admin/api/dead-letters?limit=3");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(3);
  });

  test("AC2: extremely large limit is capped server-side", async () => {
    for (let i = 0; i < 5; i++) {
      alertStore.record({ severity: "critical", source: "dispatch", title: `alert-${i}` }, 0);
    }

    // Passing an unreasonably large limit must not return more than the server cap
    const res = await adminGet(appState.app, "/admin/api/dead-letters?limit=99999");
    expect(res.status).toBe(200);
    // Server must cap — the cap value is an implementation detail, just confirm it doesn't
    // exceed a reasonable bound and doesn't error
    expect(res.body.items.length).toBeLessThanOrEqual(500);
  });

  // ── AC2: response shape ────────────────────────────────────────────────────

  test("AC2: response items carry required fields (timestamp, kind, ticket, agent, dedupCount)", async () => {
    alertStore.record({
      severity: "critical",
      source: "dispatch",
      title: "dispatch-exhausted",
      agent: "sage",
      ticket: "AI-999",
      detail: { internalKey: "should-be-redacted-or-present-safely" },
    }, 0);

    const res = await adminGet(appState.app, "/admin/api/dead-letters");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);

    const item = res.body.items[0];
    // Must include timestamp (firstAt or lastAt or a unified timestamp field)
    expect(item.firstAt ?? item.lastAt ?? item.timestamp).toBeDefined();
    // kind surfaces the store's source column
    expect(item.kind).toBe("dispatch");
    expect(item.ticket).toBe("AI-999");
    expect(item.agent).toBe("sage");
    // dedupCount surfaces the burst count
    expect(typeof item.dedupCount).toBe("number");
    expect(item.dedupCount).toBeGreaterThanOrEqual(1);
  });

  test("AC2: burst repeat count is surfaced as dedupCount", async () => {
    const suppressWindowMs = 60 * 60_000; // 1h
    // Record same event twice within suppress window → burst count = 2
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", agent: "sage" }, suppressWindowMs);
    alertStore.record({ severity: "critical", source: "dispatch", title: "dispatch-exhausted", agent: "sage" }, suppressWindowMs);

    const res = await adminGet(appState.app, "/admin/api/dead-letters");
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.dedupCount).toBe(2);
  });

  // ── AC3: SPA route ─────────────────────────────────────────────────────────

  test("AC3: /admin/dead-letters route is served by the SPA shell", async () => {
    const res = await request(appState.app).get("/admin/dead-letters");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Linear Connector Console");
  });

  // ── AC5: web/dist rebuilt ─────────────────────────────────────────────────

  test("AC5: web/dist/index.html exists and references dead-letters in the built bundle", () => {
    // This test reads the ACTUAL built dist in the repo (not the test mock),
    // verifying that web/dist was rebuilt after web/src gained the dead-letters page.
    // It will be RED until Igor adds the page and rebuilds.
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const distIndex = path.join(repoRoot, "web", "dist", "index.html");
    expect(fs.existsSync(distIndex)).toBe(true);

    // The built SPA bundle must contain a reference to the dead-letters route/component.
    // Check both index.html and the JS assets directory.
    const assetsDir = path.join(repoRoot, "web", "dist", "assets");
    const assetFiles = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js")).map((f) => path.join(assetsDir, f))
      : [];

    const hasDeadLetterContent = assetFiles.some((f) => {
      try {
        return fs.readFileSync(f, "utf8").toLowerCase().includes("dead-letter");
      } catch {
        return false;
      }
    });
    expect(hasDeadLetterContent).toBe(true);
  });
});
