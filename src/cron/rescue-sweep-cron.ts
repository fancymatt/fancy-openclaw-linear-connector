/**
 * AI-1566 — Periodic rescue sweep cron registration.
 *
 * Schedules runRescueSweep() on a configurable interval (RESCUE_SWEEP_INTERVAL env,
 * default 1h). Detects and repairs dormant/malformed/drifted wf:* tickets — a safety
 * net that fires independently of the auto-entry hook.
 *
 * Pattern mirrors src/cron/p4-metrics-distillation.ts.
 *
 * AI-1970 fix:
 *   - Auth now uses getAccessToken("ai") ?? env (matching every sibling caller),
 *     fixing the bug where the deployment's encrypted token was never read.
 *   - Skip and fail outcomes are recorded to /health state so a dead safety net
 *     no longer looks identical to a never-due one.
 *   - A first run fires immediately after registration (timer.unref'd) rather than
 *     waiting a full interval.
 */

import { runRescueSweep } from "../rescue-sweep.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import { loadWorkflowRegistry } from "../workflow-gate.js";
import { createLogger, componentLogger } from "../logger.js";
import { registerCron, formatIntervalMs, markCronRun } from "./registry.js";
import { getAccessToken } from "../agents.js";
import {
  recordRescueSweepRun,
  recordRescueSweepSkip,
  recordRescueSweepFail,
} from "../rescue-sweep-state.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "rescue-sweep-cron");

/** Parse a duration string like "1h", "30m", "3600s" or raw milliseconds. */
function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return 60 * 60 * 1000; // default 1h
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    case "d":  return n * 86_400_000;
    default:   return 3_600_000;
  }
}

const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.RESCUE_SWEEP_INTERVAL ?? "1h");

/**
 * Run one sweep iteration: resolve auth token, load registry, execute, record.
 * Extracted so it can be called both on-interval and on-first-run.
 *
 * AI-2093: the operationalEventStore is threaded through to runRescueSweep so
 * per-ticket rescue:* outcomes reach operational-events.db and are queryable.
 * Absent store → events are silently skipped (unchanged prior behaviour).
 */
async function runSweepIteration(operationalEventStore?: OperationalEventStore): Promise<void> {
  try {
    // AI-1970: canonical auth pattern — getAccessToken("ai") ?? env, matching every sibling.
    const authToken =
      getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
    if (!authToken) {
      const reason = "No LINEAR_OAUTH_TOKEN or LINEAR_API_KEY configured";
      log.warn(`[rescue-sweep] ${reason} — skipping sweep`);
      recordRescueSweepSkip(reason);
      return;
    }
    const workflowRegistry = await loadWorkflowRegistry();
    const result = await runRescueSweep({ authToken, workflowRegistry, operationalEventStore });
    recordRescueSweepRun(result);
    if (result.rescued > 0 || result.errors.length > 0) {
      log.info(
        `[rescue-sweep] Sweep complete: scanned=${result.scanned} rescued=${result.rescued} errors=${result.errors.length}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[rescue-sweep] Scheduled sweep failed: ${msg}`);
    recordRescueSweepFail(msg);
  } finally {
    markCronRun("rescue-sweep");
  }
}

/**
 * Register the rescue sweep as an in-process recurring job.
 * Interval is controlled by RESCUE_SWEEP_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 *
 * A first run fires via setImmediate-style setTimeout after registration
 * (also unref'd) so the sweep doesn't wait a full interval before initial
 * execution.
 */
export function registerRescueSweepCron(operationalEventStore?: OperationalEventStore): void {
  const intervalMs = DEFAULT_INTERVAL_MS;
  registerCron("rescue-sweep", `every ${formatIntervalMs(intervalMs)}`);

  // AI-1970: first run shortly after startup (unref'd).
  const firstRunTimer = setTimeout(() => {
    void runSweepIteration(operationalEventStore);
  }, 0);
  firstRunTimer.unref();

  // Recurring interval.
  const timer = setInterval(() => {
    void runSweepIteration(operationalEventStore);
  }, intervalMs);
  timer.unref();

  log.info(
    `[rescue-sweep] Rescue sweep scheduled every ${intervalMs}ms (RESCUE_SWEEP_INTERVAL=${process.env.RESCUE_SWEEP_INTERVAL ?? "1h"})` +
      " — first run queued immediately",
  );
}
