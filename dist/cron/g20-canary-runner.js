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
import { runG20Canary } from "./g20-canary-job.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "g20-canary");
const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.G20_CANARY_INTERVAL ?? "15m");
function parseIntervalMs(value) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return parseInt(trimmed, 10);
    const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
    if (!match)
        return 15 * 60 * 1000;
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
function buildConfig(onAlert) {
    const proxyUrl = process.env.G20_CANARY_PROXY_URL ?? process.env.OPENCLAW_PROXY_URL ?? "http://localhost:18789";
    const authToken = process.env.G20_CANARY_AUTH_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    const agentId = process.env.G20_CANARY_AGENT_ID ?? "g20-canary";
    const canaryTicketId = process.env.G20_CANARY_TICKET_ID ?? "";
    const illegalIntent = process.env.G20_CANARY_ILLEGAL_INTENT;
    return { proxyUrl, authToken, agentId, canaryTicketId, illegalIntent, onAlert };
}
function onAlert(result) {
    const msg = `[G-20 CANARY] ALERT — enforcement gate may be silently off. error=${result.error} timestamp=${result.timestamp}`;
    log.error(msg);
    // Best-effort push via gateway; do not let failure mask the primary log alert.
    const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789").replace(/\/$/, "");
    const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_PASSWORD;
    const headers = { "Content-Type": "application/json" };
    if (token)
        headers["Authorization"] = `Bearer ${token}`;
    fetch(`${gatewayUrl}/tools/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            tool: "push_notification",
            args: { message: msg },
        }),
    }).catch((err) => {
        log.warn(`[G-20 CANARY] push_notification failed (primary log alert was emitted): ${err instanceof Error ? err.message : String(err)}`);
    });
}
async function main() {
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
    }
    else {
        log.error(`[G-20 CANARY] FAILED — ${result.error}`);
        process.exit(1);
    }
}
/**
 * Register the G-20 canary as an in-process recurring job.
 * Interval controlled by G20_CANARY_INTERVAL env var (default: 15m).
 * Timer is unref'd so it won't block graceful shutdown.
 */
export function registerG20CanaryCron() {
    const canaryTicketId = process.env.G20_CANARY_TICKET_ID;
    if (!canaryTicketId) {
        log.warn("[G-20 CANARY] G20_CANARY_TICKET_ID not set — skipping canary registration (set the env var to enable)");
        return;
    }
    const intervalMs = DEFAULT_INTERVAL_MS;
    const config = buildConfig(onAlert);
    const timer = setInterval(() => {
        runG20Canary(config).catch((err) => {
            log.error(`[G-20 CANARY] Scheduled run threw: ${err instanceof Error ? err.message : String(err)}`);
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
//# sourceMappingURL=g20-canary-runner.js.map