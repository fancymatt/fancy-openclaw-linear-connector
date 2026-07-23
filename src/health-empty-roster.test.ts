/**
 * AI-1767 — Empty-roster safety guard.
 *
 * The v1.5.0 Docker deploy booted with 0 of 28 agents (misconfigured
 * AGENTS_FILE mount) and silently served 401s + dropped webhooks fleet-wide.
 * Two guards prevent this class of failure from recurring:
 *
 * 1. /health returns 503 when the roster is empty so Docker healthchecks /
 *    load balancers pull the container out of rotation.
 * 2. The entrypoint process.exit(1)s on boot when the roster is empty (tested
 *    indirectly via the health endpoint, since the exit guard is in the
 *    isEntryPoint block which tests don't exercise).
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { markCronRun, registerCron, resetCronRegistryForTest } from "./cron/registry.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "health-guard-test-"));
}

function writeAgentsFile(dir: string, agents: unknown[]): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
  return file;
}

const sampleAgent = {
  name: "sage",
  linearUserId: "user-sage-12345678",
  openclawAgent: "sage",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

describe("health endpoint — empty-roster guard (AI-1767)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  afterEach(() => {
    appState?.dispatchDeliveryScheduler?.stop();
    appState?.watchdog?.stop();
    appState?.noActivityDetector?.stop();
    appState?.stuckDelegateDetector?.stop();
    appState?.managingPoller?.stop();
    appState?.bag?.close();
    appState?.sessionTracker?.close();
    appState?.agentQueue?.close();
    appState?.operationalEventStore?.close();
    resetCronRegistryForTest();
    delete process.env.AGENTS_FILE;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns 200 when agents are loaded", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.agents).toBe(1);
    expect(res.body.agentNames).toContain("sage");
  });

  test("returns 503 when the roster is empty", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, []);
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.agents).toBe(0);
  });

  test("health payload includes deployment name and service for diagnostics", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.body.service).toBe("fancy-openclaw-linear-connector");
    expect(res.body.deployment).toBeDefined();
  });

  test("INF-339 AC1: /health includes staleCrons empty when registered crons are fresh", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });
    registerCron("fresh-driver", "every 5m");
    markCronRun("fresh-driver");

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("staleCrons");
    expect(res.body.staleCrons).toEqual([]);
  });
});
