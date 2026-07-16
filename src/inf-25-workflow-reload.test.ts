import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf25-test-"));
}

const ADMIN_SECRET = "inf25-test-secret";

function adminPost(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).post(route).set("x-admin-secret", ADMIN_SECRET);
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "test-agent",
      linearUserId: "user-test-12345678",
      openclawAgent: "test-agent",
      clientId: "client-id-secret-value",
      clientSecret: "client-secret-value",
      accessToken: "access-token-secret-value",
      refreshToken: "refresh-token-secret-value",
      host: "local",
    }],
  }), "utf8");
  return file;
}

function writeWorkflowDef(dir: string, id: string, version: number): string {
  const file = path.join(dir, `${id}.yaml`);
  fs.writeFileSync(file, `# ${id} workflow def
id: ${id}
version: ${version}
break_glass:
  command: escape
states:
  - id: todo
    label: To Do
    native_state: backlog
    transitions:
      - target: done
  - id: done
    label: Done
    native_state: done
    is_terminal: true
`, "utf8");
  return file;
}

function writeInvalidWorkflowDef(dir: string, id: string): string {
  const file = path.join(dir, `${id}.yaml`);
  // A def with a native_state that doesn't exist in the connector's valid set —
  // the validateNativeStateMappings check will flag this.
  fs.writeFileSync(file, `# ${id} workflow def
id: ${id}
version: 1
break_glass:
  command: escape
states:
  - id: stage
    label: Stage
    native_state: nonexistent_state_xyz
    transitions:
      - target: done
  - id: done
    label: Done
    native_state: done
    is_terminal: true
`, "utf8");
  return file;
}

function writeDefWithNoId(dir: string): string {
  const file = path.join(dir, "no-id.yaml");
  fs.writeFileSync(file, `version: 1
states: []
`, "utf8");
  return file;
}

describe("INF-25: POST /api/workflows/reload", () => {
  let dir: string;
  let webDist: string;
  let appState: ReturnType<typeof createApp>;
  let defsDir: string;

  beforeEach(() => {
    dir = tempDir();
    webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(path.join(webDist, "index.html"),
      "<!doctype html><title>Test Console</title><div id=\"root\"></div>", "utf8");

    defsDir = path.join(dir, "workflow-defs");
    fs.mkdirSync(defsDir, { recursive: true });

    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    reloadAgents();
    resetWorkflowCache();

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
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("requires admin credentials", async () => {
    const noAuth = await request(appState.app).post("/admin/api/workflows/reload");
    expect(noAuth.status).toBe(401);
  });

  test("reloads valid defs and returns registry with ids + versions", async () => {
    writeWorkflowDef(defsDir, "ui-audit", 3);
    writeWorkflowDef(defsDir, "dev-impl", 5);

    const res = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registry).toBeDefined();

    // Reference case from AC: ui-audit appearing in the response
    expect(res.body.registry["ui-audit"]).toBeDefined();
    expect(res.body.registry["ui-audit"].version).toBe(3);

    expect(res.body.registry["dev-impl"]).toBeDefined();
    expect(res.body.registry["dev-impl"].version).toBe(5);
  });

  test("returns diagnostics and leaves prior registry intact on invalid def", async () => {
    // Write a valid def first, bootstrap the registry
    writeWorkflowDef(defsDir, "ui-audit", 3);
    const validFirst = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(validFirst.status).toBe(200);
    expect(validFirst.body.registry["ui-audit"].version).toBe(3);

    // Now add an invalid def
    writeInvalidWorkflowDef(defsDir, "bad-def");

    // Reload should fail and return diagnostics
    const res = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.diagnostics).toBeDefined();
    expect(res.body.diagnostics.length).toBeGreaterThan(0);

    // Prior registry should still serve ui-audit untouched (check via /structure, not reload)
    const check = await request(appState.app).get("/admin/api/structure").set("x-admin-secret", ADMIN_SECRET);
    expect(check.status).toBe(200);
    // /structure uses loadWorkflowRegistry which returns the CACHED registry.
    // The failed reload should have restored the prior cache.
    const uiAudit = check.body.workflows.find((w: { id: string }) => w.id === "ui-audit");
    expect(uiAudit).toBeDefined();
    expect(uiAudit.version).toBe(3);
    const badDef = check.body.workflows.find((w: { id: string }) => w.id === "bad-def");
    expect(badDef).toBeUndefined();
  });

  test("reloads after fixing an invalid def", async () => {
    writeWorkflowDef(defsDir, "ui-audit", 3);
    writeInvalidWorkflowDef(defsDir, "bad-def");

    // First reload fails — bad def present
    const failRes = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(failRes.status).toBe(422);

    // Remove the bad def and add a good one
    fs.unlinkSync(path.join(defsDir, "bad-def.yaml"));
    writeWorkflowDef(defsDir, "dev-impl", 5);

    const okRes = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(okRes.status).toBe(200);
    expect(okRes.body.registry["ui-audit"].version).toBe(3);
    expect(okRes.body.registry["dev-impl"].version).toBe(5);
  });

  test("reports diagnostic for def file with no id field", async () => {
    writeWorkflowDef(defsDir, "ui-audit", 1);
    writeDefWithNoId(defsDir);

    const res = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.diagnostics.length).toBeGreaterThan(0);
    expect(res.body.diagnostics[0].toLowerCase()).toContain("no-id");

    // ui-audit should survive untouched (check via structure endpoint, not reload)
    const check = await request(appState.app).get("/admin/api/structure").set("x-admin-secret", ADMIN_SECRET);
    expect(check.status).toBe(200);
    const uiAudit = check.body.workflows.find((w: { id: string }) => w.id === "ui-audit");
    expect(uiAudit).toBeDefined();
    expect(uiAudit.version).toBe(1);
  });

  test("responds with healthy states in registry output", async () => {
    writeWorkflowDef(defsDir, "ui-audit", 2);

    const res = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(res.status).toBe(200);
    expect(res.body.registry["ui-audit"]).toBeDefined();
    // Verify states array is present
    expect(Array.isArray(res.body.registry["ui-audit"].states)).toBe(true);
    expect(res.body.registry["ui-audit"].states).toContain("todo");
    expect(res.body.registry["ui-audit"].states).toContain("done");
  });

  test("works with a single def file (no WORKFLOW_DEFS_DIR)", async () => {
    // Unset dir mode and set a single def path
    delete process.env.WORKFLOW_DEFS_DIR;
    const singleDef = path.join(dir, "single-workflow.yaml");
    process.env.WORKFLOW_DEF_PATH = singleDef;
    // Write the def directly to the single-def path (not in defsDir)
    fs.writeFileSync(singleDef, `# single workflow def
id: ui-audit
version: 4
break_glass:
  command: escape
states:
  - id: todo
    label: To Do
    native_state: backlog
    transitions:
      - target: done
  - id: done
    label: Done
    native_state: done
    is_terminal: true
`, "utf8");

    resetWorkflowCache();

    const res = await adminPost(appState.app, "/admin/api/workflows/reload");
    expect(res.status).toBe(200);
    expect(res.body.registry["ui-audit"].version).toBe(4);
  });
});
