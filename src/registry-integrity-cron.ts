/**
 * AI-2359 — Periodic registry-integrity check cron.
 *
 * A daily safety net that cross-checks capability-policy bodies against the
 * agent registry (agents.json). Any body declared in the policy that has no
 * corresponding agent entry is surfaced as a violation and produces an alert.
 *
 * This cron is registered at server bootstrap (index.ts) and observable at
 * /health via the cron registry — liveness is visible without waiting for
 * the first trigger (AI-1808).
 *
 * AC4 (optional): When an unregistered body is detected, the recovery flow
 * surfaces the Linear OAuth authorize URL so a human can re-onboard the agent.
 * Folded into the same cron check rather than a separate timer.
 */

import { componentLogger, createLogger } from "./logger.js";
import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";
import { runRegistryPolicyCheck } from "./registry-policy.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "registry-integrity",
);

/** Default cadence: run every 24 hours. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** Linear OAuth authorize URL prefix — replace client_id from env. */
function authorizeUrlForBody(bodyName: string): string {
  const clientId = process.env.LINEAR_CLIENT_ID ?? "unknown";
  const redirectUri = process.env.LINEAR_REDIRECT_URI ?? "http://localhost:3456/oauth/callback";
  return `https://linear.app/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=recover:${encodeURIComponent(bodyName)}&response_type=code`;
}

/**
 * Register the periodic registry-integrity check.
 *
 * Follows the AI-1810 cron registration pattern: calls registerCron() from
 * inside the registrar (not at module load) so /health reflects live state.
 *
 * Every interval, runs the cross-check with the trigger "cron".
 * For each unregistered body found, surfaces the recovery authorize URL (AC4).
 */
export function registerRegistryIntegrityCron(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  registerCron("registry-integrity-check", formatIntervalMs(intervalMs));

  const timer = setInterval(() => {
    void runRegistryPolicyCheck("cron")
      .then((status) => {
        // AC4: surface recovery URLs for unregistered bodies
        if (status.violations.length > 0) {
          const unregisteredBodies: string[] = [];
          for (const v of status.violations) {
            // Match "policy body '...' has no registered agent" pattern
            const m = v.match(/policy body '([^']+)' has no registered agent/);
            if (m) unregisteredBodies.push(m[1]);
          }

          if (unregisteredBodies.length > 0) {
            log.warn(
              `registry-integrity: unregistered bodies detected — ${unregisteredBodies.join(", ")}. ` +
                `To re-onboard, visit the Linear OAuth authorize URL for each body.`,
            );
            for (const body of unregisteredBodies) {
              log.info(
                `registry-integrity: re-onboard '${body}' via: ${authorizeUrlForBody(body)}`,
              );
            }
          }
        }
      })
      .catch((err) => {
        log.error(
          `registry-integrity: unexpected check failure: ${err instanceof Error ? err.message : String(err)}`,
        );
      }).finally(() => {
        markCronRun("registry-integrity-check");
      });
  }, intervalMs);

  timer.unref();

  log.info(
    `registry-integrity: cron registered (${formatIntervalMs(intervalMs)} interval)`,
  );

  return timer;
}
