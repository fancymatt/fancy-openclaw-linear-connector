/**
 * Instance-local config resolution.
 *
 * The connector repo is the generic workflow *engine*; the workflow *definitions*
 * (dev-impl.yaml et al.), capability policy, and step guidance are per-deployment
 * instance data — they are NOT committed to this repo and must NOT live in the
 * human-curated Obsidian doc vault (a vault reorg there took the whole spine down,
 * 2026-06-14). They live in a stable instance-config root outside both the repo
 * and the vault, so they survive `git reset --hard` (canonical deploy) and vault
 * reorganizations alike.
 *
 * Root: $LINEAR_CONNECTOR_CONFIG_DIR, else ~/.openclaw/linear-connector.
 * Per-artifact env overrides (WORKFLOW_DEF_PATH, CAPABILITY_POLICY_PATH,
 * WORKFLOW_GUIDANCE_DIR) still win where consumers honor them (tests rely on them).
 */

import os from "node:os";
import path from "node:path";

export function instanceConfigRoot(): string {
  return (
    process.env.LINEAR_CONNECTOR_CONFIG_DIR ??
    path.join(os.homedir(), ".openclaw", "linear-connector")
  );
}

export function defaultWorkflowDefPath(): string {
  return path.join(instanceConfigRoot(), "workflows", "dev-impl.yaml");
}

export function defaultCapabilityPolicyPath(): string {
  return path.join(instanceConfigRoot(), "config", "capability-policy.yaml");
}

export function defaultGuidanceDir(): string {
  return path.join(instanceConfigRoot(), "guidance");
}
