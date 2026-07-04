import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-test-"));
}

const ADMIN_SECRET = "admin-test-secret";

function adminGet(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).get(route).set("x-admin-secret", ADMIN_SECRET);
}

function adminBasicGet(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).get(route).auth("admin", ADMIN_SECRET);
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "sage",
      linearUserId: "user-sage-12345678",
      openclawAgent: "sage",
      clientId: "client-id-secret-value",
      clientSecret: "client-secret-value",
      accessToken: "access-token-secret-value",
      refreshToken: "refresh-token-secret-value",
      host: "local",
    }],
  }), "utf8");
  return file;
}

describe("admin console", () => {
  let dir: string;
  let webDist: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = tempDir();
    webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>Linear Connector Console</title><div id=\"root\"></div>", "utf8");
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    reloadAgents();
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
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("requires credentials for admin API routes", async () => {
    const unauthorized = await request(appState.app).get("/admin/api/dashboard");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Basic");

    delete process.env.ADMIN_SECRET;
    const unconfigured = await request(appState.app).get("/admin/api/dashboard").set("x-admin-secret", ADMIN_SECRET);
    expect(unconfigured.status).toBe(503);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
  });

  test("header, Bearer, and Basic auth all work for the API", async () => {
    const viaHeader = await adminGet(appState.app, "/admin/api/dashboard");
    expect(viaHeader.status).toBe(200);
    const viaBearer = await request(appState.app).get("/admin/api/dashboard").set("Authorization", `Bearer ${ADMIN_SECRET}`);
    expect(viaBearer.status).toBe(200);
    const viaBasic = await adminBasicGet(appState.app, "/admin/api/dashboard");
    expect(viaBasic.status).toBe(200);
  });

  test("serves the SPA shell for console routes without auth", async () => {
    for (const route of ["/admin/", "/admin/fleet", "/admin/alerts", "/admin/workflows"]) {
      const res = await request(appState.app).get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain("Linear Connector Console");
    }
  });

  test("shows a build placeholder when the SPA bundle is missing", async () => {
    fs.rmSync(webDist, { recursive: true, force: true });
    const res = await request(appState.app).get("/admin/");
    expect(res.status).toBe(503);
    expect(res.text).toContain("Console UI not built");
  });

  test("login issues a session cookie that grants API access; logout clears it", async () => {
    const wrong = await request(appState.app).post("/admin/api/login").send({ password: "nope" });
    expect(wrong.status).toBe(401);

    const login = await request(appState.app).post("/admin/api/login").send({ password: ADMIN_SECRET });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"]?.[0];
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const sessionCookie = cookie!.split(";")[0];
    const authed = await request(appState.app).get("/admin/api/dashboard").set("Cookie", sessionCookie);
    expect(authed.status).toBe(200);

    const me = await request(appState.app).get("/admin/api/me").set("Cookie", sessionCookie);
    expect(me.body).toEqual({ authenticated: true, secretConfigured: true });
    const anonMe = await request(appState.app).get("/admin/api/me");
    expect(anonMe.body).toEqual({ authenticated: false, secretConfigured: true });

    const logout = await request(appState.app).post("/admin/api/logout").set("Cookie", sessionCookie);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");

    const tampered = await request(appState.app).get("/admin/api/dashboard").set("Cookie", "admin_session=v1.9999999999999.x.forged");
    expect(tampered.status).toBe(401);
  });

  test("login rate-limits repeated failures", async () => {
    for (let i = 0; i < 10; i++) {
      await request(appState.app).post("/admin/api/login").send({ password: "wrong" });
    }
    const blocked = await request(appState.app).post("/admin/api/login").send({ password: ADMIN_SECRET });
    expect(blocked.status).toBe(429);
  });

  test("admin API exposes operational data without raw secrets", async () => {
    appState.bag.add("sage", "AI-615", "Issue");
    appState.operationalEventStore.append({ outcome: "delivered", type: "Issue", agent: "sage", key: "linear-AI-615" });

    const res = await adminGet(appState.app, "/admin/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.attention[0].title).toContain("sage");
    expect(res.body.attention[0].href).toBe("/admin/tasks#task-linear-ai-615");
    expect(res.body.agents[0].credentialState).toBe("configured");
    expect(res.body.tasks[0].sessionKey).toBe("linear-AI-615");
    expect(res.body.agents[0].lastSuccess).toContain("delivered");

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("access-token-secret-value");
    expect(serialized).not.toContain("refresh-token-secret-value");
    expect(serialized).not.toContain("client-secret-value");
    expect(serialized).not.toContain("client-id-secret-value");
  });

  test("fleet endpoint merges agent rows, dispatch acks, and policy status", async () => {
    appState.ackTracker.recordDispatch("sage", "AI-700");
    const res = await adminGet(appState.app, "/admin/api/fleet");
    expect(res.status).toBe(200);
    expect(res.body.agents[0].name).toBe("sage");
    expect(res.body.dispatches.some((d: { ticketId: string }) => d.ticketId.includes("AI-700"))).toBe(true);
    expect(res.body.registryPolicy).toBeDefined();
    expect(res.body.configHealth).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain("access-token-secret-value");
  });

  test("alerts endpoint returns rows from the alert store", async () => {
    const res = await adminGet(appState.app, "/admin/api/alerts?limit=5");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alerts)).toBe(true);
  });

  test("workflows endpoint returns full definitions", async () => {
    const res = await adminGet(appState.app, "/admin/api/workflows");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.workflows)).toBe(true);
  });

  test("nudge endpoint requires auth, active session, then posts to hooks", async () => {
    const deliveries: unknown[] = [];
    const hookServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        deliveries.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ runId: "test-run" }));
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
    const address = hookServer.address();
    if (!address || typeof address === "string") throw new Error("test hook server did not bind");
    process.env.OPENCLAW_HOOKS_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPENCLAW_HOOKS_TOKEN = "hook-token";
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    try {
      const unauthorized = await request(appState.app).post("/nudge").send({ agent: "sage", ticketId: "AI-615" });
      expect(unauthorized.status).toBe(401);

      const inactive = await request(appState.app)
        .post("/nudge")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ agent: "sage", ticketId: "AI-615" });
      expect(inactive.status).toBe(404);
      expect(inactive.body.error).toBe("No active session found");

      appState.sessionTracker.startSession("sage", "linear-AI-615");
      const sent = await request(appState.app)
        .post("/nudge")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ agent: "sage", ticketId: "AI-615" });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ success: true, sessionId: "linear-AI-615", agent: "sage" });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ authorization: "Bearer hook-token" });
      expect((deliveries[0] as { body: Record<string, unknown> }).body).toMatchObject({
        agentId: "sage",
        sessionKey: "linear-AI-615",
        message: "Recheck AI-615 and continue work. Run linear consider-work AI-615.",
      });
    } finally {
      await new Promise<void>((resolve) => hookServer.close(() => resolve()));
    }
  });

});

describe("GET /admin/api/structure", () => {
  it("returns config health, loaded workflows, and registry-policy status", async () => {
    const request = (await import("supertest")).default;
    const express = (await import("express")).default;
    const { createAdminRouter } = await import("./admin.js");
    const app = express();
    process.env.ADMIN_SECRET = "test-secret";
    app.use("/admin", createAdminRouter({} as any));
    const res = await request(app)
      .get("/admin/api/structure")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.configHealth).toBeDefined();
    expect(res.body.configHealth.artifacts).toBeDefined();
    expect(Array.isArray(res.body.workflows)).toBe(true);
    expect(res.body.registryPolicy).toBeDefined();
  });
});
