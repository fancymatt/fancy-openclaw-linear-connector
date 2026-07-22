/**
 * INF-322 — Bootstrap-wiring proof for the health snapshot endpoint.
 *
 * AC3: "The endpoint is connected at server bootstrap (proven by integration
 * test)."
 * AI-1808 background-component rule: an integration test MUST boot the
 * production entry point (the createApp() factory) and assert the component
 * is registered. A unit test that calls the register function directly does
 * NOT cover this AC.
 *
 * This test creates the app via createApp() (the same factory used by
 * index.ts) and verifies:
 *   - GET /health/snapshot returns 200 (not 404), proving the route is wired.
 *   - GET /health includes a healthSnapshot.active === true field, proving
 *     liveness is observable without waiting for a trigger condition.
 *
 * AC mapping:
 *   AC3 — route handler is registered on the Express app at bootstrap.
 *   AC4 — liveness observable at /health or startup log.
 *   AC5 — empty state returns a valid response body, not an error.
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf322-bootstrap-"));
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "igor",
      linearUserId: "user-igor-test",
      openclawAgent: "igor",
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      host: "local" as const,
    }],
  }), "utf8");
  return file;
}

describe("INF-322 AC3/AC4: health snapshot bootstrap wiring", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeAll(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.OPENCLAW_HOOKS_URL = "";
    process.env.OPENCLAW_HOOKS_TOKEN = "";
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });
  });

  afterAll(() => {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    delete process.env.AGENTS_FILE;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC3: endpoint is connected at bootstrap ────────────────────────────

  it("AC3: GET /health/snapshot returns 200 (route is wired at bootstrap)", async () => {
    const res = await request(appState.app).get("/health/snapshot");

    // The route must be registered. A 404 means it was never wired.
    expect(res.status).toBe(200);
  });

  // ── AC4: liveness observable at /health ────────────────────────────────

  it("AC4: /health reports healthSnapshot as active", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    // The existence of this field at /health proves the snapshot endpoint
    // is wired and alive — no need to wait for a health event to fire.
    expect(res.body.healthSnapshot).toBeDefined();
    expect(res.body.healthSnapshot.active).toBe(true);
  });

  // ── AC5: healthy/empty state returns valid response ────────────────────

  it("AC5: empty snapshot returns valid JSON with empty tasks array (not an error)", async () => {
    const res = await request(appState.app).get("/health/snapshot");

    expect(res.status).toBe(200);
    // Must be valid JSON with expected shape, never a 5xx or error body.
    expect(res.body).toBeDefined();
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.tasks).toHaveLength(0);
  });
});
