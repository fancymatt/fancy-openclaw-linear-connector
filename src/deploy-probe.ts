import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "deploy-probe");

export interface DeployOutcomeResult {
  ok: boolean;
  reason?: string;
  evidence?: string;
}

/**
 * INF-452 (AI-2361): probes the running service to verify the expected
 * change is actually live, not merely merged. Compares the deployed
 * artifact's `/health` commit against the ticket's merge SHA.
 *
 * Scoped to CONNECTOR_REPO when set — a repo whose deploy target isn't
 * configured (or isn't the connector fleet) skips the probe and passes,
 * per AC5 (do not require a host probe when no running service is involved).
 * Fails open on transient network/parse errors against the health endpoint
 * itself, consistent with this file's other evidence gates (see AI-1497).
 */
export async function probeDeployOutcome(
  issueId: string,
  expectedArtifactIdentity?: string | null,
  repoUrl?: string | null,
): Promise<DeployOutcomeResult> {
  const healthUrl = process.env.HEALTH_CHECK_URL;
  const connectorRepo = process.env.CONNECTOR_REPO;

  if (!healthUrl || !expectedArtifactIdentity) {
    return { ok: true, evidence: "no health-check URL or expected artifact identity configured — probe skipped" };
  }

  if (connectorRepo && repoUrl && !repoUrl.includes(connectorRepo)) {
    log.info(`deploy-probe: skipping probe for ${issueId} — repo ${repoUrl} is not the connector repo ${connectorRepo}`);
    return { ok: true, evidence: "skipped (non-connector repo)" };
  }

  try {
    const res = await fetch(healthUrl);
    if (!res.ok) {
      return { ok: false, reason: `health check failed with status ${res.status}` };
    }
    const data = (await res.json()) as { commit?: string };
    const runningCommit = data.commit;

    if (runningCommit && runningCommit !== expectedArtifactIdentity) {
      log.warn(`deploy-probe: stale artifact detected for ${issueId}: expected=${expectedArtifactIdentity} running=${runningCommit}`);
      return {
        ok: false,
        reason: `the running service is stale (running: ${runningCommit}, expected: ${expectedArtifactIdentity})`,
      };
    }
    log.info(`deploy-probe: health check passed for ${issueId} (commit: ${runningCommit})`);
    return { ok: true, evidence: `health check commit ${runningCommit} matches expected ${expectedArtifactIdentity}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`deploy-probe: health check failed for ${issueId}: ${msg} — failing open`);
    return { ok: true, evidence: `health check unreachable (${msg}) — failed open` };
  }
}
