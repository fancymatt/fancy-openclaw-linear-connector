/**
 * AI-1566 — Periodic rescue sweep cron registration.
 *
 * Schedules runRescueSweep() on a configurable interval (RESCUE_SWEEP_INTERVAL env,
 * default 1h). Detects and repairs dormant/malformed/drifted wf:* tickets — a safety
 * net that fires independently of the auto-entry hook.
 *
 * Pattern mirrors src/cron/p4-metrics-distillation.ts.
 */
/**
 * Register the rescue sweep as an in-process recurring job.
 * Interval is controlled by RESCUE_SWEEP_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export declare function registerRescueSweepCron(): void;
//# sourceMappingURL=rescue-sweep-cron.d.ts.map