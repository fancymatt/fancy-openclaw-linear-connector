/**
 * INF-314 — Periodic stall-liveness sweep cron registration.
 *
 * Schedules a recurring sweep that evaluates LivenessRecords against the
 * stall classifier. On each tick, stalled tickets are logged. The cron
 * is registered in the connector cron registry (AI-1810) so it is
 * observable at /health.crons, and the stall detection state is marked
 * active for /health.stallDetection (AC8/AC9).
 *
 * Pattern mirrors src/cron/rescue-sweep-cron.ts:
 *   - registerCron() called from inside the registrar (not at module load).
 *   - Timer is unref'd so it won't prevent graceful shutdown.
 *   - First run fires immediately after registration (unref'd setTimeout 0).
 *   - markCronRun() at the end of each iteration.
 */

import type { LivenessRecord, StallClassifierConfig } from "../stall-detection.js";
import { getStalledTickets } from "../stall-detection.js";
import { createLogger, componentLogger } from "../logger.js";
import { registerCron, markCronRun, formatIntervalMs } from "./registry.js";
import { recordStallDetectionActive } from "../stall-detection-state.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "stall-sweep-cron");

/** Parse a duration string like "5m", "30s", "3600s" or raw milliseconds. */
function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return 5 * 60 * 1000; // default 5m
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    case "d":  return n * 86_400_000;
    default:   return 5 * 60 * 1000;
  }
}

const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.STALL_SWEEP_INTERVAL ?? "5m");

export interface StallSweepCronOptions {
  /** Provides the current set of liveness records to evaluate. */
  livenessRecords: () => LivenessRecord[];
  /** Stall classification thresholds. */
  config: StallClassifierConfig;
}

/**
 * Run one sweep iteration: collect records, classify, log stalled tickets.
 * Extracted so it can be called both on-interval and on-first-run.
 */
function runSweepIteration(options: StallSweepCronOptions): void {
  try {
    const records = options.livenessRecords();
    const stalled = getStalledTickets(records, options.config);
    if (stalled.length > 0) {
      const summary = stalled
        .map((s) => `${s.ticketId} (${s.reason})`)
        .join(", ");
      log.warn(`[stall-sweep] ${stalled.length} stalled ticket(s): ${summary}`);
    } else {
      log.info(`[stall-sweep] No stalled tickets detected (${records.length} record(s) checked)`);
    }
  } catch (err) {
    log.error(
      `[stall-sweep] Iteration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  markCronRun("stall-liveness-sweep");
}

/**
 * Register the stall-liveness sweep as an in-process recurring job.
 * Interval is controlled by STALL_SWEEP_INTERVAL env var (default: 5m).
 * The timer is unref'd so it won't prevent graceful shutdown.
 *
 * A first run fires via setImmediate-style setTimeout after registration
 * (also unref'd) so the sweep doesn't wait a full interval before initial
 * execution.
 */
export function registerStallSweepCron(options: StallSweepCronOptions): void {
  const intervalMs = DEFAULT_INTERVAL_MS;

  registerCron("stall-liveness-sweep", `every ${formatIntervalMs(intervalMs)}`);

  // Mark stall detection as active in /health state (AC9).
  recordStallDetectionActive({
    ackTimeoutMs: options.config.ackTimeoutMs,
    progressTimeoutMs: options.config.progressTimeoutMs,
  });

  // First run fires shortly after startup (unref'd).
  const firstRunTimer = setTimeout(() => {
    runSweepIteration(options);
  }, 0);
  firstRunTimer.unref();

  // Recurring interval.
  const timer = setInterval(() => {
    runSweepIteration(options);
  }, intervalMs);
  timer.unref();

  log.info(
    `[stall-sweep] Stall liveness sweep scheduled every ${intervalMs}ms ` +
      `(STALL_SWEEP_INTERVAL=${process.env.STALL_SWEEP_INTERVAL ?? "5m"})` +
      " — first run queued immediately",
  );
}
