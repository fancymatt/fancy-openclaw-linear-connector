/**
 * AI-2619 — Config-sanity watchdog alert consumer.
 *
 * Reads the latest `config-sanity-watchdog.json` (written by the
 * `config-sanity-watchdog.py` Python cron on Nakazawa), parses findings, and
 * routes each through the AlertBus with a stable dedup key.
 *
 * Dedup behavior:
 *  - `git-remote-liveness` PUSH-DEAD findings (severity=critical) are keyed on
 *    `git-remote-liveness:critical:AI-2189` — the root-cause ticket, not the
 *    per-repo finding set — so an unchanged root cause does not page repeatedly.
 *  - All other findings use `{check}:{severity}` as their dedup key.
 *
 * Liveness: exported `getConfigSanityAlertLiveness()` returns the last-read
 * timestamp and finding count, surfaced at /health.configSanityAlert.
 *
 * Design: docs/alert-bus.md, lifecycle-os/infra/config-sanity-watchdog.md
 * (Alert routing §).
 */

import { componentLogger, createLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";
import { registerCron, formatIntervalMs } from "./cron/registry.js";
import fs from "node:fs";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "config-sanity-alert");

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Path to the latest config-sanity-watchdog JSON output.
 * Default: ~/.openclaw/logs/config-sanity-watchdog.json
 * Override: CONFIG_SANITY_WATCHDOG_PATH env var.
 */
const DEFAULT_WATCHDOG_JSON_PATH = (
  process.env.HOME
    ? `${process.env.HOME}/.openclaw/logs/config-sanity-watchdog.json`
    : "/home/fancymatt/.openclaw/logs/config-sanity-watchdog.json"
);
export const WATCHDOG_JSON_PATH = process.env.CONFIG_SANITY_WATCHDOG_PATH ?? DEFAULT_WATCHDOG_JSON_PATH;

/** Dedup key for `git-remote-liveness` critical findings (all PUSH-DEAD → AI-2189). */
const GIT_REMOTE_LIVENESS_DEDUP_KEY = "git-remote-liveness:critical:AI-2189";

/** Default sweep cadence: 30 minutes (matches the watchdog's own cadence). */
const DEFAULT_INTERVAL_MS = 30 * 60_000;

// ── Types ───────────────────────────────────────────────────────────────

export interface WatchdogFinding {
  /** Check slug, e.g. "git-remote-liveness", "config-json". */
  check: string;
  /** Severity: "critical", "warning", "info". */
  severity: string;
  /** Human-readable finding message. */
  message: string;
  /** Dedup key from the JSON (not used — we compute our own). */
  dedupe?: string;
  /** Optional playbook slug. */
  playbook?: string;
  /** Optional root-cause ticket reference. */
  ticket?: string;
  /** Optional extra detail. */
  detail?: Record<string, unknown>;
}

export interface WatchdogOutput {
  /** True when no critical findings are present. */
  ok: boolean;
  /** Array of findings. */
  findings: WatchdogFinding[];
  /** ISO timestamp of the watchdog run. */
  timestamp?: string;
  /** Optional list of checks that ran. */
  checks_run?: string[];
}

export interface ConfigSanityAlertLiveness {
  /** True when the component is armed (timer scheduled). */
  scheduled: boolean;
  /** ISO timestamp of the last successful read of watchdog JSON, or null. */
  lastReadAt: string | null;
  /** Number of findings forwarded from the last read. */
  lastFindingCount: number | null;
  /** ISO timestamp of the last alert fired, or null. */
  lastAlertAt: string | null;
}

// ── Singleton state ─────────────────────────────────────────────────────

let scheduled = false;
let lastReadAt: string | null = null;
let lastFindingCount: number | null = null;
let lastAlertAt: string | null = null;

// ── Dedup key computation ───────────────────────────────────────────────

/**
 * Compute the dedup key for a watchdog finding.
 *
 * Special case: `git-remote-liveness` critical findings (PUSH-DEAD) are
 * keyed on `git-remote-liveness:critical:AI-2189` — the root-cause ticket,
 * not the per-repo finding set. This prevents the dedup signature from
 * shifting when the repo roster changes between runs.
 *
 * All other findings use `{check}:{severity}`.
 */
export function dedupKeyForFinding(finding: WatchdogFinding): string {
  if (finding.check === "git-remote-liveness" && finding.severity === "critical") {
    return GIT_REMOTE_LIVENESS_DEDUP_KEY;
  }
  return `${finding.check}:${finding.severity}`;
}

// ── JSON reader ─────────────────────────────────────────────────────────

/**
 * Read and parse the latest config-sanity-watchdog.json.
 * Returns null when the file doesn't exist or is unparseable.
 *
 * Separated for testability: tests can mock this to exercise alert routing.
 */
export function readWatchdogJson(path?: string): WatchdogOutput | null {
  const resolvedPath = path ?? WATCHDOG_JSON_PATH;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as WatchdogOutput;

    // Normalise: ensure findings is an array.
    if (!Array.isArray(parsed.findings)) {
      parsed.findings = [];
    }
    return parsed;
  } catch (err) {
    // ENOENT is expected when the watchdog hasn't run yet on a fresh host.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    log.warn(`failed to parse watchdog JSON at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Alert firing ───────────────────────────────────────────────────────

/**
 * Process a single watchdog output: fire alerts for each finding and update
 * liveness state.
 *
 * Each finding's dedup key is computed via `dedupKeyForFinding`. Only
 * critical and warning severity findings fire alerts (info findings are
 * logged but not alerted, consistent with the existing watchdog severity
 * contract).
 */
export function processWatchdogOutput(output: WatchdogOutput, now = new Date()): void {
  const findings = output.findings ?? [];
  const nowIso = now.toISOString();
  lastReadAt = nowIso;
  lastFindingCount = findings.length;

  for (const finding of findings) {
    const dedupKey = dedupKeyForFinding(finding);
    const severity = finding.severity === "critical" || finding.severity === "warning"
      ? finding.severity
      : "info";

    notify({
      severity,
      source: "config-sanity",
      title: `[${finding.check}] ${finding.message}`,
      detail: finding.detail ?? undefined,
      ticket: finding.ticket ?? undefined,
      dedupKey,
      // git-remote-liveness critical uses a 6h suppression window (AI-2620)
      // so the 30-min cron cadence doesn't create fresh pushes every cycle.
      suppressWindowMs: finding.check === "git-remote-liveness" && severity === "critical"
        ? 6 * 60 * 60_000
        : undefined,
    });

    if (severity === "critical" || severity === "warning") {
      lastAlertAt = nowIso;
    }
  }
}

/**
 * Run a single cycle: read the watchdog JSON and fire alerts.
 * Returns the number of findings processed (0 if no file or parse error).
 */
export function runCycle(path?: string): number {
  const output = readWatchdogJson(path);
  if (!output) {
    return 0;
  }
  processWatchdogOutput(output);
  return output.findings?.length ?? 0;
}

// ── Liveness ────────────────────────────────────────────────────────────

export function getConfigSanityAlertLiveness(): ConfigSanityAlertLiveness {
  return {
    scheduled,
    lastReadAt,
    lastFindingCount,
    lastAlertAt,
  };
}

// ── Test-only reset ─────────────────────────────────────────────────────

export function _resetConfigSanityAlertForTests(): void {
  scheduled = false;
  lastReadAt = null;
  lastFindingCount = null;
  lastAlertAt = null;
}

// ── Cron registration ───────────────────────────────────────────────────

/**
 * Register the config-sanity alert consumer as an in-process recurring job.
 *
 * Interval: 30 minutes (matching the 30-min watchdog cadence).
 * The timer is unref'd so it won't block graceful shutdown.
 *
 * Registration is unconditional (the component always runs when the
 * connector is alive). If the watchdog JSON file doesn't exist yet, the
 * cycle is a no-op.
 */
export function registerConfigSanityAlertCron(): void {
  if (scheduled) {
    log.warn("config-sanity-alert: already scheduled — ignoring duplicate register() call");
    return;
  }

  const intervalMs = DEFAULT_INTERVAL_MS;
  registerCron("config-sanity-alert", `every ${formatIntervalMs(intervalMs)}`);
  scheduled = true;

  // Run the first cycle immediately, then on the interval.
  setImmediate(() => {
    try {
      const count = runCycle();
      if (count > 0) {
        log.info(`config-sanity-alert: initial cycle processed ${count} finding(s)`);
      } else {
        log.info("config-sanity-alert: initial cycle — no findings (file not available or empty)");
      }
    } catch (err) {
      log.error(`config-sanity-alert: initial cycle threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const timer = setInterval(() => {
    try {
      runCycle();
    } catch (err) {
      log.error(`config-sanity-alert: cycle threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, intervalMs);
  timer.unref();

  log.info(`config-sanity-alert: scheduled every ${formatIntervalMs(intervalMs)} (path=${WATCHDOG_JSON_PATH})`);
}
