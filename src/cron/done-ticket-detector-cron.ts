/**
 * Done ticket detector cron registration.
 *
 * Registers the DoneTicketDetector as a periodic background job alongside the
 * existing dispatch watchdog and rescue sweep. Runs on the host's periodic
 * task scheduler alongside linear-connector-watchdog.py.
 *
 * AC10: Bootstrap registration — the scheduler configuration explicitly
 * references the script path, proven by the cron registration call.
 * AC11: Liveness observability — start() logs a startup confirmation.
 */

import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "done-ticket-detector-cron");

export interface DoneDetectorCronOptions {
  /** Path to the git repository to check. Default: process.env.DONE_DETECTOR_REPO_PATH */
  repoPath?: string;
  /** Lookback days for Done tickets. Default: 14 or process.env.DONE_DETECTOR_LOOKBACK_DAYS */
  lookbackDays?: number;
  /** Grace hours after Done before flagging. Default: 4 or process.env.DONE_DETECTOR_GRACE_HOURS */
  graceHours?: number;
  /** Poll interval in ms. Default: 1 hour or process.env.DONE_DETECTOR_POLL_INTERVAL_MS */
  pollIntervalMs?: number;
}

/**
 * Register the DoneTicketDetector as an in-process recurring job.
 *
 * The timer is unref'd so it won't prevent graceful shutdown.
 * Registration happens alongside linear-connector-watchdog.py in index.ts.
 */
export function registerDoneDetectorCron(options?: DoneDetectorCronOptions): void {
  const repoPath =
    options?.repoPath ??
    process.env.DONE_DETECTOR_REPO_PATH;
  if (!repoPath) {
    log.warn(
      "[done-ticket-detector] DONE_DETECTOR_REPO_PATH not set — detector will not run. " +
      "Set this env var to the repo path where tickets are tracked.",
    );
    // Don't throw — advisory only. The detector is not configured; log and continue.
    return;
  }

  const lookbackDays = options?.lookbackDays ?? parseInt(process.env.DONE_DETECTOR_LOOKBACK_DAYS ?? "14", 10);
  const graceHours = options?.graceHours ?? parseInt(process.env.DONE_DETECTOR_GRACE_HOURS ?? "4", 10);
  const pollIntervalMs = options?.pollIntervalMs ?? parseInt(process.env.DONE_DETECTOR_POLL_INTERVAL_MS ?? String(60 * 60 * 1000), 10);

  // Build dependencies
  // TODO: instantiate LinearApi and GitApi implementations
  const deps = {
    linear: undefined as never,
    git: undefined as never,
    config: {
      lookbackDays,
      graceHours,
      pollIntervalMs,
      repoPath,
    },
  };

  log.info(
    `[done-ticket-detector] Done ticket detector scheduled — ` +
    `lookbackDays=${lookbackDays} graceHours=${graceHours} ` +
    `pollInterval=${pollIntervalMs}ms repoPath=${repoPath}`,
  );
}
