/**
 * AI-1795 — Per-repo deploy policy: which repos lack CI auto-deploy.
 *
 * The dev-impl `deploy` transition (deployment → ac-validate) assumes merge
 * alone puts the new build in production. For repos without CI auto-deploy
 * (e.g. linear-webhook-fancymatt) that assumption is false: merge leaves the
 * running service on the old artifact, and ac-validate verifies a stale build.
 * Twice on AI-1775 this recurred despite YAML-comment guidance, so the engine
 * now enforces it: workflow-gate consults this policy and rejects `deploy` on
 * flagged repos, pointing at `handoff-host-deploy` instead.
 *
 * Policy file (instance config, NOT committed to this repo):
 *   {configRoot}/config/deploy-policy.yaml   (override: DEPLOY_POLICY_PATH)
 *
 *   repos:
 *     linear-webhook-fancymatt:
 *       ci_auto_deploy: false
 *     fancymatt/some-other-repo:      # owner-qualified keys also accepted
 *       ci_auto_deploy: false
 *
 * Fail posture: a missing policy file means no repos are flagged (the guard
 * is opt-in per repo, so absence must not block anyone). A malformed file is
 * treated the same but raises a deduped warning alert — silently losing
 * enforcement is exactly the failure mode this module exists to close.
 */

import fs from "node:fs";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { defaultDeployPolicyPath } from "./instance-config.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "deploy-policy");

export interface DeployPolicy {
  /** Keyed by repo name ("linear-webhook-fancymatt") or "owner/repo". */
  repos: Record<string, { ci_auto_deploy?: boolean }>;
}

const EMPTY_POLICY: DeployPolicy = { repos: {} };

export function deployPolicyPath(): string {
  return process.env.DEPLOY_POLICY_PATH ?? defaultDeployPolicyPath();
}

let cache: { policy: DeployPolicy; path: string; mtimeMs: number } | null = null;

/** Test hook: drop the mtime-keyed cache. */
export function resetDeployPolicyCache(): void {
  cache = null;
}

/**
 * Load the deploy policy, cached by (path, mtime) so config edits are picked
 * up without a restart. Never throws.
 */
export function loadDeployPolicy(): DeployPolicy {
  const file = deployPolicyPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Missing file: no repos flagged. Expected on instances that never opt in.
    cache = { policy: EMPTY_POLICY, path: file, mtimeMs: -1 };
    return EMPTY_POLICY;
  }

  if (cache && cache.path === file && cache.mtimeMs === mtimeMs) return cache.policy;

  try {
    const raw = yaml.load(fs.readFileSync(file, "utf8"));
    const repos = (raw as { repos?: unknown } | null)?.repos;
    if (raw !== null && (typeof raw !== "object" || (repos !== undefined && (typeof repos !== "object" || repos === null || Array.isArray(repos))))) {
      throw new Error("deploy-policy.yaml must be a mapping with a 'repos' mapping");
    }
    const policy: DeployPolicy = { repos: {} };
    for (const [key, value] of Object.entries((repos ?? {}) as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        policy.repos[key] = value as { ci_auto_deploy?: boolean };
      } else {
        throw new Error(`repo entry '${key}' must be a mapping (e.g. ci_auto_deploy: false)`);
      }
    }
    cache = { policy, path: file, mtimeMs };
    return policy;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`deploy-policy: failed to load ${file}: ${msg} — treating as empty (no repos flagged)`);
    notify({
      severity: "warning",
      source: "deploy-policy",
      title: "deploy-policy.yaml failed to load — no-CI-auto-deploy enforcement is OFF",
      detail: `${file}: ${msg}`,
    });
    cache = { policy: EMPTY_POLICY, path: file, mtimeMs };
    return EMPTY_POLICY;
  }
}

/** Normalize a repo ref for matching: lowercase, no trailing ".git". */
function normalizeRepoRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/\.git$/, "");
}

/**
 * Does `repoRef` (bare name or "owner/repo") match a policy key (bare name or
 * "owner/repo")? A bare key matches any owner; an owner-qualified key must
 * match exactly. Case-insensitive.
 */
function repoMatchesKey(repoRef: string, key: string): boolean {
  const ref = normalizeRepoRef(repoRef);
  const k = normalizeRepoRef(key);
  if (ref === k) return true;
  const refName = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
  const keyName = k.includes("/") ? k.slice(k.lastIndexOf("/") + 1) : k;
  if (!k.includes("/") && refName === keyName) return true; // bare key ↔ qualified ref
  if (!ref.includes("/") && refName === keyName) return true; // bare ref ↔ qualified key
  return false;
}

/**
 * Of the given repo refs, return those flagged `ci_auto_deploy: false` in the
 * policy (deduped, in policy-key form for stable messaging).
 */
export function reposWithoutCiAutoDeploy(repoRefs: string[]): string[] {
  const policy = loadDeployPolicy();
  const flaggedKeys = Object.entries(policy.repos)
    .filter(([, v]) => v.ci_auto_deploy === false)
    .map(([k]) => k);
  const hits = new Set<string>();
  for (const ref of repoRefs) {
    for (const key of flaggedKeys) {
      if (repoMatchesKey(ref, key)) hits.add(key);
    }
  }
  return [...hits];
}

/**
 * Extract "owner/repo" refs from GitHub URLs (PR/branch/commit attachments).
 * Non-GitHub URLs and unparseable strings are ignored.
 */
export function githubRepoFromUrl(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)/i.exec(url.trim());
  if (!m) return null;
  return normalizeRepoRef(`${m[1]}/${m[2]}`);
}
