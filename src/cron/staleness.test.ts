import type { CronRegistryEntry } from "./registry.js";
import {
  computeStaleCrons,
  getCronStalenessMultiplier,
  parseCronScheduleMs,
} from "./staleness.js";

const base = Date.parse("2026-07-22T00:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

function cronEntry(overrides: Partial<CronRegistryEntry>): CronRegistryEntry {
  return {
    id: "sample-cron",
    name: "sample-cron",
    schedule: "every 5m",
    registeredAt: iso(0),
    lastRunAt: null,
    ...overrides,
  };
}

describe("cron staleness", () => {
  test("cron registered with no run is stale after the first-fire grace period", () => {
    const stale = computeStaleCrons([cronEntry({ lastRunAt: null })], {
      now: new Date(base + 11 * 60 * 1000),
    });

    expect(stale).toEqual([
      {
        name: "sample-cron",
        schedule: "every 5m",
        lastRunAt: null,
        overdueBy: "1m",
      },
    ]);
  });

  test("cron last ran 4x ago is stale when multiplier is 3", () => {
    const stale = computeStaleCrons(
      [cronEntry({ lastRunAt: iso(0) })],
      { now: new Date(base + 20 * 60 * 1000), multiplier: 3 },
    );

    expect(stale).toEqual([
      {
        name: "sample-cron",
        schedule: "every 5m",
        lastRunAt: iso(0),
        overdueBy: "5m",
      },
    ]);
  });

  test("cron last ran 2x ago is not stale when multiplier is 3", () => {
    const stale = computeStaleCrons(
      [cronEntry({ lastRunAt: iso(0) })],
      { now: new Date(base + 10 * 60 * 1000), multiplier: 3 },
    );

    expect(stale).toEqual([]);
  });

  test("parses schedule strings for m, h, and s formats", () => {
    expect(parseCronScheduleMs("every 5m")).toBe(5 * 60 * 1000);
    expect(parseCronScheduleMs("every 1h")).toBe(60 * 60 * 1000);
    expect(parseCronScheduleMs("every 90s")).toBe(90 * 1000);
  });

  test("reads staleness multiplier from env with default fallback", () => {
    expect(getCronStalenessMultiplier({ CRON_STALENESS_MULTIPLIER: "4" })).toBe(4);
    expect(getCronStalenessMultiplier({ CRON_STALENESS_MULTIPLIER: "0" })).toBe(3);
    expect(getCronStalenessMultiplier({})).toBe(3);
  });
});
