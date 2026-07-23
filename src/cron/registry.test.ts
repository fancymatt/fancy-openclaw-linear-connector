/**
 * AI-1810 — Cron/background-driver registry unit tests.
 *
 * Covers the registry module contract and the registration behavior of each
 * driver's registrar. The end-to-end guarantee (booting the production entry
 * point yields these entries in /health) lives in
 * health-crons-integration.test.ts — these tests intentionally do NOT prove
 * bootstrap wiring, only per-module behavior.
 */
import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cronRegistry from "./registry.js";
import {
  registerCron,
  getRegisteredCrons,
  markCronRun,
  resetCronRegistryForTest,
  formatIntervalMs,
  getCronStalenessMultiplierFromEnv,
} from "./registry.js";
import { registerRescueSweepCron } from "./rescue-sweep-cron.js";
import { registerG20CanaryCron } from "./g20-canary-runner.js";
import { registerSlaSweepCron } from "../sla-sweep.js";
import { registerConfigSanityAlertCron, _resetConfigSanityAlertForTests } from "../config-sanity-alert.js";

describe("cron registry (AI-1810)", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("registerCron records name, schedule, and an ISO registeredAt", () => {
    registerCron("sample-driver", "every 5m");
    const entries = getRegisteredCrons();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("sample-driver");
    expect(entries[0].schedule).toBe("every 5m");
    expect(Number.isNaN(Date.parse(entries[0].registeredAt))).toBe(false);
  });

  test("re-registering the same name overwrites instead of duplicating", () => {
    registerCron("sample-driver", "every 5m");
    registerCron("sample-driver", "every 10m");
    const entries = getRegisteredCrons();
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("every 10m");
  });

  test("getRegisteredCrons returns entries sorted by name", () => {
    registerCron("zeta", "every 1h");
    registerCron("alpha", "every 1h");
    expect(getRegisteredCrons().map((e) => e.name)).toEqual(["alpha", "zeta"]);
  });

  test("formatIntervalMs renders compact human-readable durations", () => {
    expect(formatIntervalMs(5 * 60 * 1000)).toBe("5m");
    expect(formatIntervalMs(60 * 60 * 1000)).toBe("1h");
    expect(formatIntervalMs(90 * 1000)).toBe("90s");
    expect(formatIntervalMs(1500)).toBe("1500ms");
  });
});

type StaleCronEntry = {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueBy: string;
  overdueByMs: number;
};

function getStaleCronsForTest(opts: { now: Date; stalenessMultiplier?: number }): StaleCronEntry[] {
  const fn = (cronRegistry as unknown as {
    getStaleCrons?: (opts: { now: Date; stalenessMultiplier?: number }) => StaleCronEntry[];
  }).getStaleCrons;
  expect(fn).toEqual(expect.any(Function));
  return fn!(opts);
}

describe("INF-339 stale cron detection", () => {
  beforeEach(() => {
    resetCronRegistryForTest();
    jest.useFakeTimers();
  });

  afterEach(() => {
    resetCronRegistryForTest();
    jest.useRealTimers();
  });

  test("AC2: register-but-never-fire cron is stale after its first expected fire", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("never-fired", "every 5m");

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:06:00.000Z"),
    });

    expect(stale).toEqual([
      {
        name: "never-fired",
        schedule: "every 5m",
        lastRunAt: null,
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });

  test("AC3: lagging cron appears when lastRunAt is older than schedule times default N=3", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("lagging-driver", "every 10m");
    markCronRun("lagging-driver", new Date("2026-07-22T12:00:00.000Z"));

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:31:00.000Z"),
    });

    expect(stale).toEqual([
      {
        name: "lagging-driver",
        schedule: "every 10m",
        lastRunAt: "2026-07-22T12:00:00.000Z",
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });

  test("AC4: stale threshold N is configurable", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("configurable-driver", "every 10m");
    markCronRun("configurable-driver", new Date("2026-07-22T12:00:00.000Z"));

    expect(getStaleCronsForTest({
      now: new Date("2026-07-22T12:31:00.000Z"),
      stalenessMultiplier: 4,
    })).toEqual([]);

    expect(getStaleCronsForTest({
      now: new Date("2026-07-22T12:41:00.000Z"),
      stalenessMultiplier: 4,
    })).toEqual([
      {
        name: "configurable-driver",
        schedule: "every 10m",
        lastRunAt: "2026-07-22T12:00:00.000Z",
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });

  test("AC4: stale threshold multiplier is read from CRON_STALENESS_MULTIPLIER", () => {
    expect(getCronStalenessMultiplierFromEnv({
      CRON_STALENESS_MULTIPLIER: "4",
    } as NodeJS.ProcessEnv)).toBe(4);
    expect(getCronStalenessMultiplierFromEnv({
      CRON_STALENESS_MULTIPLIER: "0",
    } as NodeJS.ProcessEnv)).toBe(3);
  });

  test("AC5: fresh crons and exact-threshold crons are not flagged", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("fresh-driver", "every 10m");
    markCronRun("fresh-driver", new Date("2026-07-22T12:20:00.000Z"));
    registerCron("exact-threshold", "every 10m");
    markCronRun("exact-threshold", new Date("2026-07-22T12:00:00.000Z"));
    jest.setSystemTime(new Date("2026-07-22T12:26:00.000Z"));
    registerCron("not-yet-due", "every 5m");

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:30:00.000Z"),
    });

    expect(stale).toEqual([]);
  });

  test("AC5: parenthetical interval suffixes are still covered by stale detection", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("delegation-reconciliation-sweep", "every 5m (300000ms)");
    registerCron("stale-plain-delegate-sweep", "every 5m (stale=15m)");

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:06:00.000Z"),
    });

    expect(stale).toEqual([
      {
        name: "delegation-reconciliation-sweep",
        schedule: "every 5m (300000ms)",
        lastRunAt: null,
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
      {
        name: "stale-plain-delegate-sweep",
        schedule: "every 5m (stale=15m)",
        lastRunAt: null,
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });
});

describe("driver registrars self-register (AI-1810)", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => {
    resetCronRegistryForTest();
    delete process.env.G20_CANARY_TICKET_ID;
  });

  test("registerRescueSweepCron registers 'rescue-sweep'", () => {
    registerRescueSweepCron();
    expect(getRegisteredCrons().map((e) => e.name)).toContain("rescue-sweep");
  });

  test("registerG20CanaryCron does NOT register when the canary is skipped (no ticket id)", () => {
    delete process.env.G20_CANARY_TICKET_ID;
    registerG20CanaryCron();
    expect(getRegisteredCrons().map((e) => e.name)).not.toContain("g20-canary");
  });

  test("registerG20CanaryCron registers 'g20-canary' on the scheduling path", () => {
    process.env.G20_CANARY_TICKET_ID = "AI-0000";
    registerG20CanaryCron();
    expect(getRegisteredCrons().map((e) => e.name)).toContain("g20-canary");
  });

  test("registerSlaSweepCron registers 'sla-sweep' with its cadence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sla-registry-test-"));
    const defPath = path.join(dir, "defs.yaml");
    fs.writeFileSync(defPath, "id: noop\nstates: []\n", "utf8");
    const timer = registerSlaSweepCron({
      authToken: "test-token",
      workflowDefPath: defPath,
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
      cadenceMs: 60_000,
    });
    clearInterval(timer);
    fs.rmSync(dir, { recursive: true, force: true });
    const entry = getRegisteredCrons().find((e) => e.name === "sla-sweep");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe("every 1m");
  });

  test("registerConfigSanityAlertCron registers 'config-sanity-alert'", () => {
    _resetConfigSanityAlertForTests();
    registerConfigSanityAlertCron();
    const names = getRegisteredCrons().map((e) => e.name);
    expect(names).toContain("config-sanity-alert");
    _resetConfigSanityAlertForTests();
  });
});
