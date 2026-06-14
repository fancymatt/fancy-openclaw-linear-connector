/**
 * AI-1566 — Periodic rescue sweep cron registration.
 *
 * Schedules runRescueSweep() on a configurable interval (RESCUE_SWEEP_INTERVAL env,
 * default 1h). Detects and repairs dormant/malformed/drifted wf:* tickets — a safety
 * net that fires independently of the auto-entry hook.
 *
 * Pattern mirrors src/cron/p4-metrics-distillation.ts.
 */
import { runRescueSweep } from "../rescue-sweep.js";
import { loadWorkflowRegistry } from "../workflow-gate.js";
import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "rescue-sweep-cron");
/** Parse a duration string like "1h", "30m", "3600s" or raw milliseconds. */
function parseIntervalMs(value) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return parseInt(trimmed, 10);
    const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
    if (!match)
        return 60 * 60 * 1000; // default 1h
    const n = parseFloat(match[1]);
    switch (match[2]) {
        case "ms": return n;
        case "s": return n * 1000;
        case "m": return n * 60000;
        case "h": return n * 3600000;
        case "d": return n * 86400000;
        default: return 3600000;
    }
}
const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.RESCUE_SWEEP_INTERVAL ?? "1h");
/**
 * Register the rescue sweep as an in-process recurring job.
 * Interval is controlled by RESCUE_SWEEP_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export function registerRescueSweepCron() {
    const intervalMs = DEFAULT_INTERVAL_MS;
    const timer = setInterval(() => {
        void (async () => {
            try {
                const authToken = process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
                if (!authToken) {
                    log.warn("[rescue-sweep] No LINEAR_OAUTH_TOKEN or LINEAR_API_KEY — skipping sweep");
                    return;
                }
                const workflowRegistry = await loadWorkflowRegistry();
                const result = await runRescueSweep({ authToken, workflowRegistry });
                if (result.rescued > 0 || result.errors.length > 0) {
                    log.info(`[rescue-sweep] Sweep complete: scanned=${result.scanned} rescued=${result.rescued} errors=${result.errors.length}`);
                }
            }
            catch (err) {
                log.error(`[rescue-sweep] Scheduled sweep failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
    }, intervalMs);
    timer.unref();
    log.info(`[rescue-sweep] Rescue sweep scheduled every ${intervalMs}ms (RESCUE_SWEEP_INTERVAL=${process.env.RESCUE_SWEEP_INTERVAL ?? "1h"})`);
}
//# sourceMappingURL=rescue-sweep-cron.js.map