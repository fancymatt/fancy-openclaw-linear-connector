import type { CronRegistryEntry } from "./registry.js";

export interface CronStartupReadiness {
  status: "ok" | "degraded";
  neverVerifiedCrons: Array<{ name: string; lastRunAt: string | null; overdueByMs: number }>;
}

const DURATION_RE = /(\d+(?:\.\d+)?)(ms|s|m|h|d)\b/;

function parseScheduleIntervalMs(schedule: string): number | null {
  const match = schedule.match(DURATION_RE);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1_000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return null;
  }
}

function timestampMs(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseCronStartupGraceMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function evaluateCronStartupReadiness(options: {
  crons: CronRegistryEntry[];
  bootedAt: Date;
  now: Date;
  bootGraceMs: number;
  log?: { error: (message: string) => void };
}): CronStartupReadiness {
  const neverVerifiedCrons: CronStartupReadiness["neverVerifiedCrons"] = [];
  const fallbackStartedAt = options.bootedAt.getTime();
  const nowMs = options.now.getTime();

  for (const cron of options.crons) {
    if (cron.lastRunAt !== null) continue;

    const startedAtMs = timestampMs(cron.registeredAt, fallbackStartedAt);
    const intervalMs = parseScheduleIntervalMs(cron.schedule);
    if (intervalMs === null) continue;

    const graceMs = Math.max(intervalMs, options.bootGraceMs);
    const overdueByMs = Math.max(0, nowMs - startedAtMs - graceMs);

    if (overdueByMs > 0) {
      neverVerifiedCrons.push({
        name: cron.name,
        lastRunAt: cron.lastRunAt,
        overdueByMs,
      });
    }
  }

  if (neverVerifiedCrons.length > 0) {
    options.log?.error(
      `cron startup readiness degraded: never verified ${neverVerifiedCrons.map((cron) => cron.name).join(", ")}`,
    );
  }

  return {
    status: neverVerifiedCrons.length > 0 ? "degraded" : "ok",
    neverVerifiedCrons,
  };
}
