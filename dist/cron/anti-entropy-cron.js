/**
 * AI-1547 — Standing anti-entropy reconciliation cron (G-17).
 *
 * Schedules runAntiEntropy() on a configurable interval (ANTI_ENTROPY_INTERVAL env,
 * default 15m). Each pass:
 *   - Compares state:* labels against native Linear stateIds and heals drift (G-7/AC1).
 *   - Checks managing tickets for fully-terminal children and fires missed barriers (G-17/AC2).
 *   - Logs a DRIFT ALERT when any drift is detected (AC3).
 *
 * Pattern mirrors src/cron/rescue-sweep-cron.ts.
 */
import { runAntiEntropy } from "../anti-entropy.js";
import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "anti-entropy-cron");
function parseIntervalMs(value) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return parseInt(trimmed, 10);
    const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
    if (!match)
        return 15 * 60 * 1000; // default 15m
    const n = parseFloat(match[1]);
    switch (match[2]) {
        case "ms": return n;
        case "s": return n * 1000;
        case "m": return n * 60000;
        case "h": return n * 3600000;
        case "d": return n * 86400000;
        default: return 15 * 60 * 1000;
    }
}
const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.ANTI_ENTROPY_INTERVAL ?? "15m");
/**
 * Register the anti-entropy loop as an in-process recurring job.
 * Interval is controlled by ANTI_ENTROPY_INTERVAL env var (default: 15m).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export function registerAntiEntropyCron() {
    const intervalMs = DEFAULT_INTERVAL_MS;
    const runOnce = async () => {
        try {
            const authToken = process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
            if (!authToken) {
                log.warn("[anti-entropy] No LINEAR_OAUTH_TOKEN or LINEAR_API_KEY — skipping pass");
                return;
            }
            await runAntiEntropy(authToken);
        }
        catch (err) {
            log.error(`[anti-entropy] Scheduled pass failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const timer = setInterval(() => { void runOnce(); }, intervalMs);
    timer.unref();
    log.info(`[anti-entropy] Anti-entropy loop scheduled every ${intervalMs}ms (ANTI_ENTROPY_INTERVAL=${process.env.ANTI_ENTROPY_INTERVAL ?? "15m"})`);
}
/**
 * Run one anti-entropy pass immediately at startup (G-7 startup reconciliation).
 * Fail-open: errors are logged but never propagate to the caller.
 */
export async function runStartupAntiEntropy() {
    const authToken = process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
    if (!authToken) {
        log.warn("[anti-entropy] No LINEAR_OAUTH_TOKEN or LINEAR_API_KEY — skipping startup reconciliation");
        return;
    }
    try {
        log.info("[anti-entropy] Running startup reconciliation pass (G-7)");
        const result = await runAntiEntropy(authToken);
        log.info(`[anti-entropy] Startup reconciliation complete: ` +
            `scanned=${result.scanned} drifts=${result.nativeDrifts.length} ` +
            `healed=${result.nativeDrifts.filter((d) => d.healed).length} ` +
            `barrier_fires=${result.barrierFires.filter((b) => b.transitioned).length}`);
    }
    catch (err) {
        log.error(`[anti-entropy] Startup reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=anti-entropy-cron.js.map