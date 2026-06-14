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
/**
 * Register the anti-entropy loop as an in-process recurring job.
 * Interval is controlled by ANTI_ENTROPY_INTERVAL env var (default: 15m).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export declare function registerAntiEntropyCron(): void;
/**
 * Run one anti-entropy pass immediately at startup (G-7 startup reconciliation).
 * Fail-open: errors are logged but never propagate to the caller.
 */
export declare function runStartupAntiEntropy(): Promise<void>;
//# sourceMappingURL=anti-entropy-cron.d.ts.map