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

describe("GET /admin/api/dispatch-acks (AI-2140)", () => {
  let dir: string;
  let adminRouter: ReturnType<typeof import("express").Router>;
  let app: ReturnType<typeof import("express").default>;
  let ackTracker: import("./bag/dispatch-ack-tracker.js").DispatchAckTracker;

  beforeEach(async () => {
    const request = (await import("supertest")).default;
    const express = (await import("express")).default;
    const path = (await import("path")).default;
    const fs = (await import("fs")).default;
    const os = (await import("os")).default;
    const { createAdminRouter } = await import("./admin.js");
    const { DispatchAckTracker } = await import("./bag/dispatch-ack-tracker.js");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-acks-test-"));
    ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));

    app = express();
    process.env.ADMIN_SECRET = "test-secret";
    app.use("/admin", createAdminRouter({ ackTracker, deploymentName: "test" } as any));
  });

  afterEach(async () => {
    const fs = (await import("fs")).default;
    ackTracker.close();
    delete process.env.ADMIN_SECRET;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty dispatches when no entries exist", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/dispatch-acks")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.dispatches).toEqual([]);
  });

  it("returns all dispatches without filters", async () => {
    ackTracker.recordDispatch("sage", "AI-100");
    ackTracker.recordDispatch("felix", "AI-101");

    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/dispatch-acks")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.dispatches).toHaveLength(2);
  });

  it("filters by agent", async () => {
    ackTracker.recordDispatch("sage", "AI-100");
    ackTracker.recordDispatch("felix", "AI-101");

    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/dispatch-acks?agent=sage")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.dispatches).toHaveLength(1);
    expect(res.body.dispatches[0].agentId).toBe("sage");
  });

  it("filters by outcome (ackStatus)", async () => {
    ackTracker.recordDispatch("sage", "AI-100");
    ackTracker.recordDispatch("felix", "AI-101");

    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/dispatch-acks?outcome=pending")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.dispatches).toHaveLength(2);
    expect(res.body.dispatches.every((d: { ackStatus: string }) => d.ackStatus === "pending")).toBe(true);
  });

  it("returns 401 without auth", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app).get("/admin/api/dispatch-acks");
    expect(res.status).toBe(401);
  });
});

describe("PUT /admin/api/agents/:name (AI-2140)", () => {
  let dir: string;
  let app: ReturnType<typeof import("express").default>;

  beforeEach(async () => {
    const express = (await import("express")).default;
    const path = (await import("path")).default;
    const fs = (await import("fs")).default;
    const os = (await import("os")).default;
    const { createAdminRouter } = await import("./admin.js");
    const { reloadAgents } = await import("./agents.js");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-put-test-"));
    const agentsPath = path.join(dir, "agents.json");
    fs.writeFileSync(agentsPath, JSON.stringify({
      agents: [{
        name: "sage",
        linearUserId: "user-sage-12345678",
        openclawAgent: "sage",
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        host: "local",
        displayName: "Sage",
      }],
    }), "utf8");
    process.env.AGENTS_FILE = agentsPath;
    process.env.ADMIN_SECRET = "test-secret";
    reloadAgents();

    app = express();
    app.use(express.json());
    app.use("/admin", createAdminRouter({ deploymentName: "test" } as any));
  });

  afterEach(async () => {
    const fs = (await import("fs")).default;
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("updates editable metadata fields", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .put("/admin/api/agents/sage")
      .set("x-admin-secret", "test-secret")
      .send({ displayName: "Sage (Updated)", openclawAgent: "sage-fe", host: "ishikawa" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent.displayName).toBe("Sage (Updated)");
    expect(res.body.agent.openclawAgent).toBe("sage-fe");
    expect(res.body.agent.host).toBe("ishikawa");
    expect(res.body.registryPolicy).toBeDefined();
  });

  it("rejects forbidden secret fields", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .put("/admin/api/agents/sage")
      .set("x-admin-secret", "test-secret")
      .send({ accessToken: "new-token" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("accessToken");
  });

  it("returns 404 for unknown agent", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .put("/admin/api/agents/nonexistent")
      .set("x-admin-secret", "test-secret")
      .send({ displayName: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .put("/admin/api/agents/sage")
      .send({ displayName: "Hacker" });
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/api/onboard/start (AI-2140)", () => {
  let dir: string;
  let app: ReturnType<typeof import("express").default>;

  beforeEach(async () => {
    const express = (await import("express")).default;
    const path = (await import("path")).default;
    const fs = (await import("fs")).default;
    const os = (await import("os")).default;
    const { createAdminRouter } = await import("./admin.js");
    const { reloadAgents } = await import("./agents.js");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-start-test-"));
    const agentsPath = path.join(dir, "agents.json");
    fs.writeFileSync(agentsPath, JSON.stringify({ agents: [] }), "utf8");
    process.env.AGENTS_FILE = agentsPath;
    process.env.ADMIN_SECRET = "test-secret";
    reloadAgents();

    app = express();
    app.use(express.json());
    app.use("/admin", createAdminRouter({ deploymentName: "test" } as any));
  });

  afterEach(async () => {
    const fs = (await import("fs")).default;
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a partial entry and returns an authorize URL", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .post("/admin/api/onboard/start")
      .set("x-admin-secret", "test-secret")
      .send({
        agentName: "new-agent",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        displayName: "New Agent",
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agentName).toBe("new-agent");
    expect(res.body.authorizeUrl).toContain("https://linear.app/oauth/authorize");
    expect(res.body.authorizeUrl).toContain("test-client-id");
  });

  it("returns 400 when required fields are missing", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .post("/admin/api/onboard/start")
      .set("x-admin-secret", "test-secret")
      .send({ agentName: "missing-creds" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("clientId");
  });

  it("returns 409 when agent is already fully onboarded", async () => {
    // First create a partial agent
    await (await import("./agents.js")).upsertAgent({
      name: "done-agent",
      displayName: "Done",
      linearUserId: "user-1",
      clientId: "c1",
      clientSecret: "c2",
      accessToken: "at-1",
      refreshToken: "rt-1",
    });

    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .post("/admin/api/onboard/start")
      .set("x-admin-secret", "test-secret")
      .send({
        agentName: "done-agent",
        clientId: "c1",
        clientSecret: "c2",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already fully onboarded");
  });
});

describe("GET /admin/api/onboard/:name/status (AI-2140)", () => {
  let dir: string;
  let app: ReturnType<typeof import("express").default>;

  beforeEach(async () => {
    const express = (await import("express")).default;
    const path = (await import("path")).default;
    const fs = (await import("fs")).default;
    const os = (await import("os")).default;
    const { createAdminRouter } = await import("./admin.js");
    const { reloadAgents } = await import("./agents.js");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-status-test-"));
    const agentsPath = path.join(dir, "agents.json");
    fs.writeFileSync(agentsPath, JSON.stringify({
      agents: [{
        name: "incomplete",
        linearUserId: "",
        clientId: "c1",
        clientSecret: "c2",
        accessToken: "",
        refreshToken: "",
      }, {
        name: "complete",
        linearUserId: "user-abc-12345678",
        clientId: "c1",
        clientSecret: "c2",
        accessToken: "at-1",
        refreshToken: "rt-1",
      }],
    }), "utf8");
    process.env.AGENTS_FILE = agentsPath;
    process.env.ADMIN_SECRET = "test-secret";
    reloadAgents();

    app = express();
    app.use("/admin", createAdminRouter({ deploymentName: "test" } as any));
  });

  afterEach(async () => {
    const fs = (await import("fs")).default;
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports incomplete agent status", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/onboard/incomplete/status")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(false);
    expect(res.body.hasToken).toBe(false);
  });

  it("reports complete agent status", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/onboard/complete/status")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.hasToken).toBe(true);
  });

  it("returns 404 for unknown agent", async () => {
    const supertest = (await import("supertest")).default;
    const res = await supertest(app)
      .get("/admin/api/onboard/ghost/status")
      .set("x-admin-secret", "test-secret");
    expect(res.status).toBe(404);
  });
});
