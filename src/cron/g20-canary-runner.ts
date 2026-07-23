/**
 * G-20 canary runner — scheduled entry point for AI-1552 (§5.1).
 *
 * Reads config from env, fires runG20Canary on an interval, and alerts via
 * console.error + gateway push_notification when enforcement is silently off.
 *
 * Run manually: tsx src/cron/g20-canary-runner.ts
 * Scheduled:    registerG20CanaryCron() during connector startup
 */

import { createLogger, componentLogger } from "../logger.js";
import { runG20Canary, type G20CanaryConfig, type G20CanaryResult } from "./g20-canary-job.js";
import { notify } from "../alerts/alert-bus.js";
import { registerCron, formatIntervalMs, markCronRun } from "./registry.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "g20-canary");

const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.G20_CANARY_INTERVAL ?? "15m");

function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return 15 * 60 * 1000;
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    case "d":  return n * 86_400_000;
    default:   return 15 * 60 * 1000;
  }
}

function buildConfig(onAlert: (result: G20CanaryResult) => void): G20CanaryConfig {
  const proxyUrl = process.env.G20_CANARY_PROXY_URL ?? process.env.OPENCLAW_PROXY_URL ?? "http://localhost:18789";
  const authToken = process.env.G20_CANARY_AUTH_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const agentId = process.env.G20_CANARY_AGENT_ID ?? "g20-canary";
  const canaryTicketId = process.env.G20_CANARY_TICKET_ID ?? "";
  const illegalIntent = process.env.G20_CANARY_ILLEGAL_INTENT;
  return { proxyUrl, authToken, agentId, canaryTicketId, illegalIntent, onAlert };
}

function onAlert(result: G20CanaryResult): void {
  const msg = `[G-20 CANARY] ALERT — enforcement gate may be silently off. error=${result.error} timestamp=${result.timestamp}`;
  log.error(msg);
  // Route through the alert bus (log + store + push transport chain) instead
  // of the pre-bus ad-hoc push_notification call this replaced.
  notify({
    severity: "critical",
    source: "canary",
    title: "G-20 canary: enforcement gate may be silently off",
    detail: `error=${result.error} timestamp=${result.timestamp}`,
    dedupKey: "canary|g20",
  });
}

async function main(): Promise<void> {
  const config = buildConfig(onAlert);
  if (!config.canaryTicketId) {
    console.error("[G-20 CANARY] G20_CANARY_TICKET_ID is not set — cannot run canary without a target ticket.");
    process.exit(1);
  }
  log.info(`[G-20 CANARY] Running once against canary ticket ${config.canaryTicketId}`);
  const result = await runG20Canary(config);
  if (result.passed) {
    log.info(`[G-20 CANARY] PASSED — enforcement rejected illegal intent as expected (${result.timestamp})`);
    process.exit(0);
  } else {
    log.error(`[G-20 CANARY] FAILED — ${result.error}`);
    process.exit(1);
  }
}

/**
 * Register the G-20 canary as an in-process recurring job.
 * Interval controlled by G20_CANARY_INTERVAL env var (default: 15m).
 * Timer is unref'd so it won't block graceful shutdown.
 */
export function registerG20CanaryCron(): void {
  const canaryTicketId = process.env.G20_CANARY_TICKET_ID;
  if (!canaryTicketId) {
    log.warn("[G-20 CANARY] G20_CANARY_TICKET_ID not set — skipping canary registration (set the env var to enable)");
    return;
  }
  const intervalMs = DEFAULT_INTERVAL_MS;
  const config = buildConfig(onAlert);
  // Register only on the scheduling path — a skipped canary (no ticket id)
  // must not appear in /health as if it were live (AI-1810).
  registerCron("g20-canary", `every ${formatIntervalMs(intervalMs)}`);
  const timer = setInterval(() => {
    runG20Canary(config).catch((err) => {
      log.error(`[G-20 CANARY] Scheduled run threw: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      markCronRun("g20-canary");
    });
  }, intervalMs);
  timer.unref();
  log.info(`[G-20 CANARY] Scheduled every ${intervalMs}ms against ticket ${canaryTicketId} (G20_CANARY_INTERVAL=${process.env.G20_CANARY_INTERVAL ?? "15m"})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
