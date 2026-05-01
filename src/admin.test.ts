import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-test-"));
}

const ADMIN_SECRET = "admin-test-secret";

function adminGet(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).get(route).set("x-admin-secret", ADMIN_SECRET);
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
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("requires ADMIN_SECRET for admin routes", async () => {
    const unauthorized = await request(appState.app).get("/admin/api/dashboard");
    expect(unauthorized.status).toBe(401);

    delete process.env.ADMIN_SECRET;
    const unconfigured = await request(appState.app).get("/admin/api/dashboard").set("x-admin-secret", ADMIN_SECRET);
    expect(unconfigured.status).toBe(503);
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
  });

});
