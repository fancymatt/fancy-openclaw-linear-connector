import { formatIntervalMs, type CronRegistryEntry } from "./registry.js";

export interface StaleCronEntry {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueBy: string;
}

export interface CronStalenessOptions {
  now?: Date;
  multiplier?: number;
}

const DEFAULT_STALENESS_MULTIPLIER = 3;
const FIRST_EXPECTED_FIRE_GRACE_MULTIPLIER = 2;

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getCronStalenessMultiplier(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumberOrDefault(env.CRON_STALENESS_MULTIPLIER, DEFAULT_STALENESS_MULTIPLIER);
}

export function parseCronScheduleMs(schedule: string): number | null {
  const normalized = schedule.trim().toLowerCase().replace(/^every\s+/, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours)$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2];
  if (unit === "ms" || unit === "msec" || unit.startsWith("millisecond")) return value;
  if (unit === "s" || unit === "sec" || unit.startsWith("second")) return value * 1_000;
  if (unit === "m" || unit === "min" || unit.startsWith("minute")) return value * 60_000;
  if (unit === "h" || unit === "hr" || unit.startsWith("hour")) return value * 3_600_000;
  return null;
}

export function computeStaleCrons(
  entries: CronRegistryEntry[],
  options: CronStalenessOptions = {},
): StaleCronEntry[] {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) return [];

  const multiplier = positiveNumberOrDefault(options.multiplier, DEFAULT_STALENESS_MULTIPLIER);
  const stale: StaleCronEntry[] = [];

  for (const entry of entries) {
    const intervalMs = parseCronScheduleMs(entry.schedule);
    if (intervalMs == null || !Number.isFinite(intervalMs) || intervalMs <= 0) continue;

    const referenceIso = entry.lastRunAt ?? entry.registeredAt;
    const referenceMs = Date.parse(referenceIso);
    if (!Number.isFinite(referenceMs)) continue;

    const allowedAgeMs = entry.lastRunAt == null
      ? intervalMs * FIRST_EXPECTED_FIRE_GRACE_MULTIPLIER
      : intervalMs * multiplier;
    const overdueMs = nowMs - (referenceMs + allowedAgeMs);
    if (overdueMs <= 0) continue;

    stale.push({
      name: entry.name,
      schedule: entry.schedule,
      lastRunAt: entry.lastRunAt,
      overdueBy: formatIntervalMs(overdueMs),
    });
  }

  return stale;
}
