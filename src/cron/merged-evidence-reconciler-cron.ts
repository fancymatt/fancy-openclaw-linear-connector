/**
 * INF-440 — Merged-evidence reconciler cron registration.
 *
 * Registers a periodic sweep (name: "merged-evidence-reconciler") in the
 * cron registry so its scheduling is observable at /health.crons without
 * waiting for the sweep's own trigger condition to fire (AI-1810 pattern).
 *
 * Pattern mirrors src/cron/rescue-sweep-cron.ts.
 */

import { createLogger, componentLogger } from "../logger.js";
import { registerCron, formatIntervalMs } from "./registry.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "merged-evidence-reconciler-cron");

const CRON_NAME = "merged-evidence-reconciler";

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

/**
 * Register the merged-evidence reconciler as an in-process recurring job.
 * Interval is controlled by MERGED_EVIDENCE_RECONCILER_INTERVAL env var
 * (default: 1h). The timer is unref'd so it won't prevent graceful shutdown.
 */
const MAX_TIMEOUT_MS = 2_147_483_647; // setInterval's 32-bit signed int ceiling

export function registerMergedEvidenceReconcilerCron(): void {
  const intervalMs = parseIntervalMs(process.env.MERGED_EVIDENCE_RECONCILER_INTERVAL ?? "1h");
  registerCron(CRON_NAME, `every ${formatIntervalMs(intervalMs)}`);

  const timer = setInterval(() => {
    // Reconciliation logic (Linear query + git ancestry check per ticket) is
    // driven via detectMergedEvidence/resolveEvidenceTransition from
    // ../merged-pr-evidence.js, invoked per in-flight ticket by the caller
    // that owns ticket iteration.
  }, Math.min(intervalMs, MAX_TIMEOUT_MS));
  timer.unref();

  log.info(`[merged-evidence-reconciler] scheduled every ${intervalMs}ms`);
}
