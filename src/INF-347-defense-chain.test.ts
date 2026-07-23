/**
 * INF-347 — End-to-end defense-chain tests (AC5).
 *
 * Exercises the full defense chain for crons:
 *  1. Detection of stale crons via /health.
 *  2. External monitor alerting on stale crons.
 *  3. Self-healing (re-init) on staleness.
 *  4. Escalation when self-healing fails.
 *  5. Fail-loud startup when crons fail to fire during warmup.
 */
import request from "supertest";
import { jest } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { registerCron, markCronRun, resetCronRegistryForTest } from "./cron/registry.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "defense-chain-test-"));
}

describe("INF-347: End-to-end defense-chain tests", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let mockPush: jest.Mock;

  beforeEach(() => {
    dir = tempDir();
    // Load at least one agent so /health returns 200 (if crons are also healthy)
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    fs.writeFileSync(process.env.AGENTS_FILE, JSON.stringify({ agents: [{ name: "test-agent", host: "local" }] }), "utf8");

    mockPush = jest.fn(async () => {});
    initAlertBus({
      pushFn: mockPush,
      pushEnabled: true,
      pushMinSeverity: "info",
    });
    // Create app with temp DBs
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });
    // Reload agents to pick up the temp file
    reloadAgents();
    
    jest.useFakeTimers();
  });

  afterEach(() => {
    appState?.bag?.close();
    appState?.sessionTracker?.close();
    appState?.agentQueue?.close();
    appState?.operationalEventStore?.close();
    resetCronRegistryForTest();
    _resetAlertBusForTests();
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1: Full-chain test: register-but-never-fire → staleCrons → alarm", async () => {
    // 1. Register a cron that never fires
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("never-fired-driver", "every 5m");

    // 2. Advance time past the staleness threshold (default N=3 -> 15m)
    jest.setSystemTime(new Date("2026-07-22T12:16:00.000Z"));

    // 3. /health should flag it in staleCrons.
    // It also returns 503 because a never-fired cron makes startup readiness degraded.
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body).toHaveProperty("staleCrons");
    
    const stale = res.body.staleCrons as any[];
    expect(stale).toContainEqual(expect.objectContaining({
      name: "never-fired-driver",
    }));

    // 4. External monitor (simulated here) should fire a CRITICAL alert.
    // We expect the connector's own monitoring loop (the external-monitor counterpart)
    // to result in a push naming the stale cron.
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("[connector:critical]"));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("never-fired-driver"));
  });

  test("AC2: Full-chain test: self-heal success path", async () => {
    // 1. Register a cron and let it become stale
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("self-healing-driver", "every 5m");
    
    jest.setSystemTime(new Date("2026-07-22T12:16:00.000Z"));
    
    // 2. Simulate the monitor detecting staleness and triggering re-init.
    // We expect a /health/re-init endpoint (INF-340/341 logic).
    const res = await request(appState.app)
      .post("/health/re-init")
      .send({ cron: "self-healing-driver" });
    
    expect(res.status).toBe(200);

    // 3. After re-init, the self-heal attempt should be recorded in health
    const healthRes = await request(appState.app).get("/health");
    const stale = healthRes.body.staleCrons.find((c: any) => c.name === "self-healing-driver");
    expect(stale.selfHealAttempted).toBe(true);
  });

  test("AC3: Full-chain test: self-heal failure → escalation", async () => {
    // 1. Register a cron and let it become stale
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("broken-driver", "every 5m");
    
    jest.setSystemTime(new Date("2026-07-22T12:16:00.000Z"));
    
    // 2. Trigger re-init
    await request(appState.app).post("/health/re-init").send({ cron: "broken-driver" });
    
    // 3. Advance time further without the cron running
    jest.setSystemTime(new Date("2026-07-22T12:31:00.000Z"));
    
    // 4. Monitor checks again, sees it's STILL stale after self-heal attempt.
    // It should now be marked as escalated.
    const res = await request(appState.app).get("/health");
    const stale = res.body.staleCrons.find((c: any) => c.name === "broken-driver");
    expect(stale.status).toBe("escalated");

    // 5. Check for escalation alert
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("ESCALATION"));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("broken-driver"));
  });

  test("AC4: Startup failure test: not-all-crons-fire → 503/degraded", async () => {
    // 1. Register crons
    registerCron("cron-1", "every 1m");
    registerCron("cron-2", "every 1m");
    
    // 2. Only cron-1 fires
    markCronRun("cron-1");
    
    // 3. Advance time past warmup timeout
    jest.advanceTimersByTime(120_000);
    
    // 4. /health should return 503 because cron-2 didn't fire during warmup
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    
    // The implementation evaluateCronStartupReadiness returns 'cronReadiness'.
    expect(res.body).toHaveProperty("cronReadiness");
    expect(res.body.cronReadiness.neverVerifiedCrons).toContainEqual(expect.objectContaining({
      name: "cron-2"
    }));
  });
});
