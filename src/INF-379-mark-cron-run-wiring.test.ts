/**
 * INF-379 — Wire markCronRun() into first-action-watchdog, sla-sweep, and
 * validation-watchdog (INF-329 class, surfaced by the INF-341 readiness gate).
 *
 * These three drivers call registerCron() but never call markCronRun() from
 * their setInterval callback, so /health.crons[].lastRunAt stays null forever
 * — cronReadiness.neverVerifiedCrons flags them as never having proven a tick,
 * even though the underlying sweep runs fine.
 *
 * Each test below registers the driver with minimal mocked deps, advances
 * fake timers past one interval, and asserts getRegisteredCrons() returns a
 * non-null lastRunAt for the driver — proving markCronRun was called.
 *
 * (RED before the fix: registerCron() runs but markCronRun() is never
 * invoked, so lastRunAt stays null for all three.)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

/** Assert a registry entry has a non-null lastRunAt (stamped by markCronRun). */
function expectLastRunAtStamped(
  crons: Array<{ name: string; lastRunAt: string | null }>,
  name: string,
): void {
  const entry = crons.find((c) => c.name === name);
  expect(entry).toBeDefined();
  expect(entry!.name).toBe(name);
  expect(entry!.lastRunAt).not.toBeNull();
  expect(typeof entry!.lastRunAt).toBe("string");
  expect(() => new Date(entry!.lastRunAt!)).not.toThrow();
}

describe("INF-379: sla-sweep calls markCronRun", () => {
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
    const { registerSlaSweepCron } = await import("./sla-sweep.js");

    resetCronRegistryForTest();

    registerSlaSweepCron({
      authToken: "test-token",
      cadenceMs: 50,
      workflowDefPath: "/dev/null/nonexistent",
      fetchFn: async () => new Response("[]", { status: 200 }),
      notify: () => {},
      wakeAgent: async () => {},
    });

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "sla-sweep");
  });
});

describe("INF-379: first-action-watchdog calls markCronRun", () => {
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
      workflowDefPath: "/dev/null/nonexistent",
    });

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "first-action-watchdog");
  });
});

describe("INF-379: validation-watchdog calls markCronRun", () => {
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
    const { registerValidationWatchdogCron } =
      await import("./validation-sla-watchdog.js");

    resetCronRegistryForTest();

    registerValidationWatchdogCron({
      authToken: "test-token",
      validatorLinearUserId: "user-validator-12345678",
      cadenceMs: 50,
      fetchFn: async () => new Response(JSON.stringify({ data: { workflowState: { issues: { nodes: [] } } } }), { status: 200 }),
      wakeValidator: async () => {},
    });

    await jest.advanceTimersByTimeAsync(100);

    expectLastRunAtStamped(getRegisteredCrons(), "validation-watchdog");
  });
});
