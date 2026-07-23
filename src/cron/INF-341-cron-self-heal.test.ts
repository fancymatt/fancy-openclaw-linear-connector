/**
 * INF-341 AC1 / AC4 — stale cron self-heal is retry-capped.
 *
 * INF-339 owns computing /health.staleCrons. This ticket owns what the
 * connector does after a cron is reported stale: try one scheduler
 * re-registration, then leave the cron flagged for the external alarm instead
 * of retrying forever.
 */
import { describe, expect, jest, test } from "@jest/globals";

interface StaleCronForTest {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueByMs: number;
}

async function loadSelfHealModule() {
  const modulePath = "./stale-cron-self-heal.js";
  return import(modulePath) as Promise<{
    handleStaleCronsOnce: (options: {
      staleCrons: StaleCronForTest[];
      detectionWindowId: string;
      now: Date;
      reinitializeCron: (cron: StaleCronForTest) => Promise<void> | void;
    }) => Promise<{
      attempted: Array<{ name: string; attempt: number }>;
      capped: Array<{ name: string; attempts: number }>;
      staleCrons: StaleCronForTest[];
    }>;
    resetStaleCronSelfHealForTest: () => void;
  }>;
}

describe("INF-341 AC1: stale cron self-heal retry cap", () => {
  const staleNeverFired: StaleCronForTest = {
    name: "inf-341-never-fired",
    schedule: "every 1m",
    lastRunAt: null,
    overdueByMs: 61_000,
  };

  test("register-but-never-fire cron is re-registered exactly once, then remains flagged", async () => {
    const { handleStaleCronsOnce, resetStaleCronSelfHealForTest } = await loadSelfHealModule();
    resetStaleCronSelfHealForTest();
    const reinitializeCron = jest.fn(async () => undefined);

    const firstEvaluation = await handleStaleCronsOnce({
      staleCrons: [staleNeverFired],
      detectionWindowId: "boot-window-1",
      now: new Date("2026-07-22T21:40:00.000Z"),
      reinitializeCron,
    });
    const secondEvaluation = await handleStaleCronsOnce({
      staleCrons: [staleNeverFired],
      detectionWindowId: "boot-window-1",
      now: new Date("2026-07-22T21:41:00.000Z"),
      reinitializeCron,
    });

    expect(reinitializeCron).toHaveBeenCalledTimes(1);
    expect(reinitializeCron).toHaveBeenCalledWith(staleNeverFired);
    expect(firstEvaluation.attempted).toEqual([
      expect.objectContaining({ name: staleNeverFired.name, attempt: 1 }),
    ]);
    expect(secondEvaluation.attempted).toEqual([]);
    expect(secondEvaluation.capped).toEqual([
      expect.objectContaining({ name: staleNeverFired.name, attempts: 1 }),
    ]);
    expect(secondEvaluation.staleCrons).toEqual([
      expect.objectContaining({ name: staleNeverFired.name, lastRunAt: null }),
    ]);
  });

  test("retry cap is per cron and does not suppress a different stale cron in the same window", async () => {
    const { handleStaleCronsOnce, resetStaleCronSelfHealForTest } = await loadSelfHealModule();
    resetStaleCronSelfHealForTest();
    const otherStaleCron = { ...staleNeverFired, name: "inf-341-other-stale" };
    const reinitializeCron = jest.fn(async () => undefined);

    await handleStaleCronsOnce({
      staleCrons: [staleNeverFired],
      detectionWindowId: "boot-window-2",
      now: new Date("2026-07-22T21:42:00.000Z"),
      reinitializeCron,
    });
    const result = await handleStaleCronsOnce({
      staleCrons: [staleNeverFired, otherStaleCron],
      detectionWindowId: "boot-window-2",
      now: new Date("2026-07-22T21:43:00.000Z"),
      reinitializeCron,
    });

    expect(reinitializeCron).toHaveBeenCalledTimes(2);
    expect(result.attempted).toEqual([
      expect.objectContaining({ name: otherStaleCron.name, attempt: 1 }),
    ]);
    expect(result.capped).toEqual([
      expect.objectContaining({ name: staleNeverFired.name, attempts: 1 }),
    ]);
  });
});
