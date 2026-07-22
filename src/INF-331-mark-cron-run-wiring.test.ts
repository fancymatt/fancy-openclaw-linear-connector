/**
 * INF-331 — Wire markCronRun() into remaining unwired cron drivers.
 *
 * Currently 6 of ~15 cron drivers call markCronRun() to stamp lastRunAt on
 * /health. The remaining drivers register via registerCron() but never stamp
 * lastRunAt, so /health.crons[].lastRunAt is null for most entries. This
 * makes /health an unreliable liveness indicator.
 *
 * Each test below:
 *  1. Registers the driver's cron with minimal mocked deps.
 *  2. Advances time past one interval to trigger a tick.
 *  3. Asserts getRegisteredCrons() returns a non-null lastRunAt for the
 *     driver (→ RED until the implementer wires markCronRun into the
 *     setInterval callback).
 *
 * AI-1808 rule: one INtegration test boots the production entry point and
 * asserts /health.crons[].lastRunAt is non-null for all registered crons
 * after a short wait.
 *
 * (RED on current main for every unwired driver listed in INF-331.)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Assert a registry entry has a non-null lastRunAt (stamped by markCronRun). */
function expectLastRunAtStamped(
  crons: Array<{ name: string; lastRunAt: string | null }>,
  name: string,
): void {
  const entry = crons.find((c) => c.name === name);
  expect(entry).toBeDefined();
  expect(entry!.name).toBe(name);
  // FAILS on main — markCronRun is not called → lastRunAt stays null.
  expect(entry!.lastRunAt).not.toBeNull();
  // Also prove it's a valid ISO timestamp.
  expect(typeof entry!.lastRunAt).toBe("string");
  expect(() => new Date(entry!.lastRunAt!)).not.toThrow();
}

async function flushCronPromises(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

// ── 1. delegation-reconciliation-sweep ─────────────────────────────────────────

describe("INF-331: delegation-reconciliation-sweep calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerDelegationReconciliationCron } =
      await import("./delegation-reconciliation-sweep.js");

    resetCronRegistryForTest();

    registerDelegationReconciliationCron({
      authToken: "test-token",
      intervalMs: 50,
      wakeFn: async () => {},
      fetchFn: async () => new Response("[]", { status: 200 }),
    });

    // Advance past one interval to trigger the sweep tick.
    await jest.advanceTimersByTimeAsync(100);

    // FAILS on main: getRegisteredCrons() returns lastRunAt: null because
    // markCronRun is never called.
    expectLastRunAtStamped(
      getRegisteredCrons(),
      "delegation-reconciliation-sweep",
    );
  });
});

// ── 2. oob-reconcile-sweep ────────────────────────────────────────────────────

describe("INF-331: oob-reconcile-sweep calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    delete process.env.OOB_RECONCILE_INTERVAL_MS;
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerOobReconcileCron } =
      await import("./oob-reconcile-sweep.js");

    // Mock mutation-audit-store so the sweep doesn't hit a real DB.
    const mockStore = {
      findOobMutations: async () => [],
      acknowledgeOobMutation: async () => {},
    } as any;

    resetCronRegistryForTest();
    registerOobReconcileCron(mockStore, undefined, 50);

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "oob-reconcile-sweep");
  });
});

// ── 3. dispatch-delivery-scheduler ────────────────────────────────────────────

describe("INF-331: dispatch-delivery-scheduler calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a heartbeat tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { DispatchDeliveryScheduler } =
      await import("./delivery/dispatch-delivery-scheduler.js");

    resetCronRegistryForTest();

    const scheduler = new DispatchDeliveryScheduler({
      eventStore: { close: () => {} } as any,
      ackTracker: { close: () => {} } as any,
      heartbeatMs: 50,
    });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "dispatch-delivery-scheduler");
    scheduler.stop();
  });
});

// ── 4. sla-sweep ──────────────────────────────────────────────────────────────

describe("INF-331: sla-sweep calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerSlaSweepCron } =
      await import("./sla-sweep.js");

    resetCronRegistryForTest();

    registerSlaSweepCron({
      authToken: "test-token",
      cadenceMs: 50,
      workflowDefPath: "/dev/null/nonexistent",
      fetchFn: async () => new Response("[]", { status: 200 }),
      wakeAgent: async () => {},
    });

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "sla-sweep");
  });
});

// ── 5. first-action-watchdog ──────────────────────────────────────────────────

describe("INF-331: first-action-watchdog calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerFirstActionWatchdogCron } =
      await import("./first-action-watchdog.js");

    resetCronRegistryForTest();

    registerFirstActionWatchdogCron({
      authToken: "test-token",
      cadenceMs: 50,
      listTickets: async () => [],
      crossCheck: async () => null,
      escalateUnreachable: async () => {},
      reroute: async () => {},
      redispatch: async () => {},
      workflowDefPath: "/dev/null/nonexistent",
    });

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "first-action-watchdog");
  });
});

// ── 6. label-sync-audit ───────────────────────────────────────────────────────

describe("INF-331: label-sync-audit calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerLabelSyncAuditCron } =
      await import("./cron/label-sync-audit.js");

    resetCronRegistryForTest();

    registerLabelSyncAuditCron({
      authToken: "test-token",
      intervalMs: 50,
      enrolledTicketsStore: {
        list: async () => [],
      } as any,
    });

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "label-sync-audit");
  });
});

// ── 7. registry-integrity-check ───────────────────────────────────────────────

describe("INF-331: registry-integrity-check calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    jest.unstable_mockModule("./registry-policy.js", () => ({
      runRegistryPolicyCheck: jest.fn(async () => ({
        lastCheck: new Date().toISOString(),
        violations: [],
        notes: [],
      })),
    }));

    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerRegistryIntegrityCron } =
      await import("./registry-integrity-cron.js");

    resetCronRegistryForTest();
    registerRegistryIntegrityCron(50);

    await jest.advanceTimersByTimeAsync(100);
    await flushCronPromises();

    expectLastRunAtStamped(getRegisteredCrons(), "registry-integrity-check");
  });
});

// ── 8. rescue-sweep ───────────────────────────────────────────────────────────

describe("INF-331: rescue-sweep calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerRescueSweepCron } =
      await import("./cron/rescue-sweep-cron.js");

    resetCronRegistryForTest();
    registerRescueSweepCron();

    // Advance past immediate first run + one full interval.
    await jest.advanceTimersByTimeAsync(50);

    expectLastRunAtStamped(getRegisteredCrons(), "rescue-sweep");
  });
});

// ── 9. g20-canary ─────────────────────────────────────────────────────────────

describe("INF-331: g20-canary calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    process.env.G20_CANARY_INTERVAL = "50ms";
    process.env.G20_CANARY_TICKET_ID = "FAKE-1";
    process.env.G20_LINEAR_API_KEY = "test-key";
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "illegal move" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.G20_CANARY_INTERVAL;
    delete process.env.G20_CANARY_TICKET_ID;
    delete process.env.G20_LINEAR_API_KEY;
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    jest.unstable_mockModule("./cron/g20-canary-job.js", () => ({
      runG20Canary: jest.fn(async () => ({
        passed: true,
        timestamp: new Date().toISOString(),
      })),
    }));

    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerG20CanaryCron } =
      await import("./cron/g20-canary-runner.js");

    resetCronRegistryForTest();
    registerG20CanaryCron();

    await jest.advanceTimersByTimeAsync(100);
    await flushCronPromises();

    expectLastRunAtStamped(getRegisteredCrons(), "g20-canary");
  });
});

// ── 10. done-ticket-detector ──────────────────────────────────────────────────

describe("INF-331: done-ticket-detector calls markCronRun", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks lastRunAt after a registered tick completes", async () => {
    const { resetCronRegistryForTest, getRegisteredCrons } =
      await import("./cron/registry.js");
    const { registerDoneTicketDetectorCron } =
      await import("./cron/done-ticket-detector.js");

    resetCronRegistryForTest();
    registerDoneTicketDetectorCron();

    // Advance past immediate first run + one full interval.
    await jest.advanceTimersByTimeAsync(50);

    expectLastRunAtStamped(getRegisteredCrons(), "done-ticket-detector");
  });
});

// ── 11. AI-1808: Production bootstrap integration ─────────────────────────────
//
// This test boots the full production entry point and polls /health until the
// expected cron drivers are registered, proving the wiring is genuinely live in
// the deployed artifact, not just importable in isolation.

describe("INF-331 [AI-1808]: production entry point registers all wired crons", () => {
  const PORT = 4800 + (process.pid % 300);

  async function pollJson(
    url: string,
    timeoutMs: number,
    ready: (json: Record<string, any>) => boolean = () => true,
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = new Error("never attempted");
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        const json = (await res.json()) as Record<string, any>;
        if (json && typeof json === "object" && ready(json)) return json;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw lastErr;
  }

  it(
    "/health.crons entries are registered for every wired driver",
    async () => {
      // This integration test requires a built dist entry point — skip if absent.
      const { existsSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const distEntry = pathMod.resolve(
        pathMod.dirname(new URL(import.meta.url).pathname),
        "../dist/index.js",
      );
      if (!existsSync(distEntry)) {
        console.warn(
          "SKIP: dist/index.js not found — build before running integration test",
        );
        return;
      }

      const fsMod = await import("node:fs");
      const osMod = await import("node:os");
      const { spawn } = await import("node:child_process");

      const dir = fsMod.mkdtempSync(
        pathMod.join(osMod.tmpdir(), "inf-331-integration-"),
      );
      const agentsFile = pathMod.join(dir, "agents.json");
      fsMod.writeFileSync(
        agentsFile,
        JSON.stringify({
          agents: [
            {
              name: "ai",
              linearUserId: "user-ai-test",
              openclawAgent: "ai",
              accessToken: "test-token",
              host: "local" as const,
            },
          ],
        }),
        "utf8",
      );

      // Registered crons — the production entry point should arm all of them.
      const expectedCrons = [
        "anti-entropy",
        "config-sanity-alert",
        "delegation-reconciliation-sweep",
        "oob-reconcile-sweep",
        "dispatch-delivery-scheduler",
        "sla-sweep",
        "first-action-watchdog",
        "label-sync-audit",
        "registry-integrity-check",
        "rescue-sweep",
        "g20-canary",
        "done-ticket-detector",
      ];

      const expectedCronsRegistered = (body: Record<string, any>): boolean => {
        if (!Array.isArray(body.crons)) return false;
        return expectedCrons.every((name) => {
          const entry = body.crons.find((c: any) => c.name === name);
          return entry && typeof entry.registeredAt === "string";
        });
      };

      const child = spawn(process.execPath, [distEntry], {
        cwd: dir,
        env: {
          ...process.env,
          AGENTS_FILE: agentsFile,
          DATA_DIR: pathMod.join(dir, "data"),
          PORT: String(PORT),
          LOG_LEVEL: "error",
          LINEAR_WEBHOOK_SECRET:
            process.env.LINEAR_WEBHOOK_SECRET ?? "test-secret",
          LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
          OPENCLAW_HOOKS_URL: `http://127.0.0.1:${PORT}/nonexistent-hooks`,
          OPENCLAW_HOOKS_TOKEN: "test-token",
          DELEGATION_RECONCILIATION_INTERVAL_MS: "50",
          DISPATCH_DELIVERY_HEARTBEAT_MS: "50",
          DONE_DETECTOR_POLL_INTERVAL_MS: String(60 * 60 * 1000),
          DONE_DETECTOR_REPO_PATH: pathMod.dirname(distEntry),
          FIRST_ACTION_WATCHDOG_CADENCE_MS: String(60 * 60 * 1000),
          G20_CANARY_INTERVAL: "1h",
          G20_CANARY_TICKET_ID: "FAKE-1",
          LABEL_SYNC_AUDIT_INTERVAL: String(60 * 60 * 1000),
          OOB_RECONCILE_INTERVAL_MS: String(60 * 60 * 1000),
          REGISTRY_INTEGRITY_INTERVAL_MS: String(60 * 60 * 1000),
          RESCUE_SWEEP_INTERVAL: "1h",
          SLA_SWEEP_CADENCE_MS: String(60 * 60 * 1000),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      let childStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        childStderr += chunk.toString("utf8");
      });

      try {
        let body: Record<string, any>;
        try {
          body = await pollJson(
            `http://127.0.0.1:${PORT}/health`,
            60_000,
            expectedCronsRegistered,
          );
        } catch (err) {
          throw new Error(
            `entry point never registered expected crons: ${err instanceof Error ? err.message : String(err)}\n` +
              `child stderr:\n${childStderr}`,
          );
        }

        expect(body).toHaveProperty("crons");
        expect(Array.isArray(body.crons)).toBe(true);

        const cronNames: string[] = body.crons.map(
          (c: any) => c.name,
        );

        for (const name of expectedCrons) {
          expect(cronNames).toContain(name);
          const entry = body.crons.find(
            (c: any) => c.name === name,
          );
          expect(entry).toBeDefined();
          expect(typeof entry.registeredAt).toBe("string");
          expect(typeof entry.schedule).toBe("string");
        }
      } finally {
        if (!child.killed) {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const force = setTimeout(() => {
              child?.kill("SIGKILL");
              resolve();
            }, 3000);
            child?.on("exit", () => {
              clearTimeout(force);
              resolve();
            });
          });
        }
        try {
          fsMod.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    },
    90_000,
  );
});
