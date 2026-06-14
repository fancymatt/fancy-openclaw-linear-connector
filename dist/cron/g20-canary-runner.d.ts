/**
 * G-20 canary runner — scheduled entry point for AI-1552 (§5.1).
 *
 * Reads config from env, fires runG20Canary on an interval, and alerts via
 * console.error + gateway push_notification when enforcement is silently off.
 *
 * Run manually: tsx src/cron/g20-canary-runner.ts
 * Scheduled:    registerG20CanaryCron() during connector startup
 */
/**
 * Register the G-20 canary as an in-process recurring job.
 * Interval controlled by G20_CANARY_INTERVAL env var (default: 15m).
 * Timer is unref'd so it won't block graceful shutdown.
 */
export declare function registerG20CanaryCron(): void;
//# sourceMappingURL=g20-canary-runner.d.ts.map