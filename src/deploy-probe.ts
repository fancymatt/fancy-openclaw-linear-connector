/**
 * INF-452 — Outcome-verified deployment probe.
 *
 * Verifies that a deployed artifact reflects the expected changes before
 * advancing a ticket to `done` or `ac-validate`.
 *
 * Requirements:
 *  - Automated live-service probe (AC1).
 *  - Behavioral/content evidence where possible, not just commit SHA (AC4/Astrid).
 *  - Fails open when HEALTH_CHECK_URL is missing or for non-connector repos (AC5).
 */

import { componentLogger, createLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "deploy-probe");

export interface DeployProbeResult {
  success: boolean;
  reason?: string;
  runningCommit?: string;
}

/**
 * Probes the running service to verify it reflects the expected deployment.
 */
export async function probeDeployOutcome(
  expectedCommit: string,
  probeUrl?: string,
  behaviorProbe?: { pattern: string; description: string }
): Promise<DeployProbeResult> {
  const url = probeUrl ?? process.env.HEALTH_CHECK_URL;

  if (!url) {
    log.warn("deploy-probe: no HEALTH_CHECK_URL configured; failing open");
    return { success: true, reason: "no health check URL configured" };
  }

  try {
    log.info(`deploy-probe: probing ${url} for commit ${expectedCommit}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return { success: false, reason: `health check returned ${res.status}`, runningCommit: "unknown" };
    }

    const body = await res.text();
    let runningCommit = "unknown";
    
    try {
      const json = JSON.parse(body);
      runningCommit = json.commit || "unknown";
    } catch {
      // Not JSON, maybe raw text?
      runningCommit = body.trim().slice(0, 40);
    }

    // 1. Behavioral probe (highest confidence)
    if (behaviorProbe) {
      if (body.includes(behaviorProbe.pattern)) {
        log.info(`deploy-probe: behavior probe passed: found pattern '${behaviorProbe.pattern}'`);
        return { success: true, runningCommit };
      }
      log.warn(`deploy-probe: behavior probe FAILED: pattern '${behaviorProbe.pattern}' not found in response`);
      return { 
        success: false, 
        reason: `behavioral probe failed: expected hallmark '${behaviorProbe.description}' not found in running service`,
        runningCommit 
      };
    }

    // 2. Commit SHA fallback
    if (runningCommit === expectedCommit || runningCommit.startsWith(expectedCommit) || expectedCommit.startsWith(runningCommit)) {
      log.info(`deploy-probe: commit SHA match: ${runningCommit}`);
      return { success: true, runningCommit };
    }

    log.warn(`deploy-probe: commit mismatch: running=${runningCommit} expected=${expectedCommit}`);
    return { 
      success: false, 
      reason: `running artifact is stale: running=${runningCommit}, expected=${expectedCommit}`,
      runningCommit 
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`deploy-probe: probe failed: ${msg}`);
    return { success: false, reason: `probe failed: ${msg}` };
  }
}
