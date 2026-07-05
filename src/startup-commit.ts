import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface StartupCommitResult {
  commit: string;
  /** Where the commit came from: the deploy stamp, git HEAD, or neither. */
  source: "deploy-stamp" | "git" | "unknown";
}

/**
 * Resolve the commit that /health reports (AI-1841).
 *
 * Under the AI-1832 deploy model the shared working tree is never touched by
 * deploys and may sit on an unrelated feature branch, so `git rev-parse HEAD`
 * says nothing about the code actually running. The deploy script stamps the
 * deployed commit into dist/DEPLOY_COMMIT for exactly this reason — prefer
 * that stamp, and fall back to git HEAD only when it is absent (dev mode,
 * `npm run dev`, test runs).
 */
export async function resolveStartupCommit(
  opts: { deployCommitPath?: string; cwd?: string } = {},
): Promise<StartupCommitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const stampPath = opts.deployCommitPath ?? path.join(cwd, "dist", "DEPLOY_COMMIT");
  try {
    const stamped = (await readFile(stampPath, "utf8")).trim();
    if (stamped) return { commit: stamped, source: "deploy-stamp" };
  } catch {
    // Stamp absent or unreadable — fall through to git.
  }
  const commit = await new Promise<string>((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd }, (err, stdout) => {
      resolve(err ? "unknown" : stdout.trim());
    });
  });
  return { commit, source: commit === "unknown" ? "unknown" : "git" };
}
