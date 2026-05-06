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

describe("admin dashboard", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
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
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("requires ADMIN_SECRET for admin API routes", async () => {
    const unauthorized = await request(appState.app).get("/admin/api/dashboard");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Basic");

    delete process.env.ADMIN_SECRET;
    const unconfigured = await request(appState.app).get("/admin/api/dashboard").set("x-admin-secret", ADMIN_SECRET);
    expect(unconfigured.status).toBe(503);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
  });

  test("supports browser-compatible Basic auth and safe HTML auth failures", async () => {
    const unauthorized = await request(appState.app).get("/admin/").set("Accept", "text/html");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Basic");
    expect(unauthorized.text).toContain("Enter the admin password");
    expect(unauthorized.text).toContain("HTTP Basic auth");

    const authed = await adminBasicGet(appState.app, "/admin/tasks");
    expect(authed.status).toBe(200);
    expect(authed.text).toContain("Linear Connector Admin");
    expect(authed.text).toContain("Tasks");

    delete process.env.ADMIN_SECRET;
    const unconfigured = await request(appState.app).get("/admin/").set("Accept", "text/html");
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.text).toContain("ADMIN_SECRET is not configured");
    expect(unconfigured.text).not.toContain(ADMIN_SECRET);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
  });

  test("renders nav and all v1 admin pages", async () => {
    for (const route of ["/admin/", "/admin/agents", "/admin/tasks", "/admin/settings"]) {
      const res = await adminGet(appState.app, route);
      expect(res.status).toBe(200);
      expect(res.text).toContain("Linear Connector Admin");
      expect(res.text).toContain("Overview");
      expect(res.text).toContain("Agents");
      expect(res.text).toContain("Tasks");
      expect(res.text).toContain("Settings");
      expect(res.text).toContain("Attention Needed");
    }
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

  test("healthy empty state is visible above tables", async () => {
    const res = await adminGet(appState.app, "/admin/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("No attention needed. Connector is running and no tasks are blocked.");
    expect(res.text).toContain("attention-ok");
    expect(res.text.indexOf("Attention Needed")).toBeLessThan(res.text.indexOf("System Status"));
  });

  test("warning destinations point to specific anchored rows and task detail panels", async () => {
    appState.bag.add("sage", "AI-615", "Issue");

    const tasks = await adminGet(appState.app, "/admin/tasks");
    expect(tasks.status).toBe(200);
    expect(tasks.text).toContain('id="task-linear-ai-615"');
    expect(tasks.text).toContain("Detail panel");
    expect(tasks.text).toContain("Open task detail");
    expect(tasks.text).toContain("Event / session");

    const overview = await adminGet(appState.app, "/admin/");
    expect(overview.text).toContain('/admin/tasks#task-linear-ai-615');
    expect(tasks.text).toContain('class="nudge-button"');
    expect(tasks.text).toContain('data-agent="sage"');
    expect(tasks.text).toContain('data-ticket="AI-615"');
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
