/**
 * INF-341 AC2 / AC3 / AC4 — startup readiness fails loud when registered
 * crons never produce a first run, while normal fresh crons keep /health green.
 */
import { describe, expect, jest, test, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import {
  getRegisteredCrons,
  markCronRun,
  registerCron,
  resetCronRegistryForTest,
  type CronRegistryEntry,
} from "./cron/registry.js";

async function loadStartupReadinessModule() {
  const modulePath = "./cron/startup-readiness.js";
  return import(modulePath) as Promise<{
    evaluateCronStartupReadiness: (options: {
      crons: CronRegistryEntry[];
      bootedAt: Date;
      now: Date;
      bootGraceMs: number;
      log?: { error: (message: string) => void };
    }) => {
      status: "ok" | "degraded";
      neverVerifiedCrons: Array<{ name: string; lastRunAt: string | null; overdueByMs: number }>;
    };
  }>;
}

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-12345678",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-341-readiness-"));
}

function writeAgentsFile(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");
  return agentsFile;
}

function closeAppState(appState: ReturnType<typeof createApp> | undefined): void {
  if (!appState) return;
  for (const value of Object.values(appState)) {
    if (value && typeof value === "object" && "close" in value) {
      const close = (value as { close?: () => void }).close;
      if (typeof close === "function") close();
    }
  }
}

function ageRegisteredCron(name: string, registeredAt: string): void {
  const entry = getRegisteredCrons().find((cron) => cron.name === name);
  if (!entry) throw new Error(`missing cron registry entry for ${name}`);
  entry.registeredAt = registeredAt;
}

describe("INF-341 startup readiness evaluator", () => {
  test("AC2: never-fired cron after grace returns degraded and logs at ERROR", async () => {
    const { evaluateCronStartupReadiness } = await loadStartupReadinessModule();
    const error = jest.fn();
    const result = evaluateCronStartupReadiness({
      bootedAt: new Date("2026-07-22T21:00:00.000Z"),
      now: new Date("2026-07-22T21:02:01.000Z"),
      bootGraceMs: 30_000,
      log: { error },
      crons: [
        {
          id: "inf-341-never-fired",
          name: "inf-341-never-fired",
          schedule: "every 1m",
          registeredAt: "2026-07-22T21:00:00.000Z",
          lastRunAt: null,
        },
      ],
    });

    expect(result.status).toBe("degraded");
    expect(result.neverVerifiedCrons).toEqual([
      expect.objectContaining({
        name: "inf-341-never-fired",
        lastRunAt: null,
        overdueByMs: 61_000,
      }),
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("inf-341-never-fired"));
  });

  test("AC3: cron with a first run inside grace remains healthy", async () => {
    const { evaluateCronStartupReadiness } = await loadStartupReadinessModule();
    const error = jest.fn();
    const result = evaluateCronStartupReadiness({
      bootedAt: new Date("2026-07-22T21:00:00.000Z"),
      now: new Date("2026-07-22T21:00:45.000Z"),
      bootGraceMs: 30_000,
      log: { error },
      crons: [
        {
          id: "inf-341-fresh",
          name: "inf-341-fresh",
          schedule: "every 1m",
          registeredAt: "2026-07-22T21:00:00.000Z",
          lastRunAt: "2026-07-22T21:00:20.000Z",
        },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.neverVerifiedCrons).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  test("AC3: on-demand registrations without schedule intervals do not degrade startup readiness", async () => {
    const { evaluateCronStartupReadiness } = await loadStartupReadinessModule();
    const error = jest.fn();
    const result = evaluateCronStartupReadiness({
      bootedAt: new Date("2026-07-22T21:00:00.000Z"),
      now: new Date("2026-07-22T22:00:00.000Z"),
      bootGraceMs: 30_000,
      log: { error },
      crons: [
        {
          id: "matrix-approval-gate",
          name: "matrix-approval-gate",
          schedule: "on-demand",
          registeredAt: "2026-07-22T21:00:00.000Z",
          lastRunAt: null,
        },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.neverVerifiedCrons).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("INF-341 /health startup readiness surface", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    process.env.CRON_STARTUP_GRACE_MS = "30000";
    reloadAgents();
    resetCronRegistryForTest();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
      deadLetterQueueDbPath: path.join(dir, "dead-letter.db"),
    });
    resetCronRegistryForTest();
  });

  afterEach(() => {
    closeAppState(appState);
    resetCronRegistryForTest();
    delete process.env.AGENTS_FILE;
    delete process.env.CRON_STARTUP_GRACE_MS;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC2: /health is degraded when a registered cron never fired after startup grace", async () => {
    registerCron("inf-341-never-fired", "every 1m");
    ageRegisteredCron(
      "inf-341-never-fired",
      new Date(Date.now() - 121_000).toISOString(),
    );

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.cronReadiness).toEqual(
      expect.objectContaining({
        status: "degraded",
        neverVerifiedCrons: [
          expect.objectContaining({
            name: "inf-341-never-fired",
            lastRunAt: null,
          }),
        ],
      }),
    );
  });

  test("AC3: /health stays green when registered crons have produced a first run", async () => {
    registerCron("inf-341-fresh", "every 1m");
    markCronRun("inf-341-fresh", new Date());

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.cronReadiness).toEqual(
      expect.objectContaining({
        status: "ok",
        neverVerifiedCrons: [],
      }),
    );
  });

  test("AC3: /health stays green for on-demand registrations with no first-run stamp", async () => {
    registerCron("matrix-approval-gate", "on-demand");
    ageRegisteredCron(
      "matrix-approval-gate",
      new Date(Date.now() - 3_600_000).toISOString(),
    );

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.cronReadiness).toEqual(
      expect.objectContaining({
        status: "ok",
        neverVerifiedCrons: [],
      }),
    );
  });
});
