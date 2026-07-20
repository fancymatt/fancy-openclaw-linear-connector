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
import {
  registerCron,
  getRegisteredCrons,
  resetCronRegistryForTest,
  formatIntervalMs,
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
