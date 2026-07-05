/**
 * AI-1845 — Deploy-commit stamp resolution for /health.
 *
 * The deploy script stamps `dist/DEPLOY_COMMIT` with the actually-deployed
 * build's commit. Previously the server read git HEAD at startup, which can
 * drift from the deployed build after a merge-without-redeploy — making
 * /health unreliable as a deploy-verification signal.
 *
 * `resolveStartupCommit()` prefers the stamp, falling back to git HEAD only
 * when the stamp is absent (local dev).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface ResolveCommitOptions {
  cwd?: string;
  /** Override path to the DEPLOY_COMMIT stamp file (tests). */
  deployCommitPath?: string;
}

/**
 * Resolve the deployed commit hash for /health reporting.
 *
 * 1. Prefer `dist/DEPLOY_COMMIT` (written by the deploy script).
 * 2. Fall back to `git rev-parse --short HEAD` (local dev).
 * 3. "unknown" if neither is available.
 *
 * Never rejects — always returns a string.
 */
export async function resolveStartupCommit(options?: ResolveCommitOptions): Promise<string> {
  const cwd = options?.cwd ?? process.cwd();
  const stampPath = options?.deployCommitPath ?? path.join(cwd, "dist", "DEPLOY_COMMIT");
  try {
    const stamp = (await fs.readFile(stampPath, "utf8")).trim();
    if (stamp) return stamp;
  } catch {
    // No stamp file — fall through to git HEAD for dev runs.
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
