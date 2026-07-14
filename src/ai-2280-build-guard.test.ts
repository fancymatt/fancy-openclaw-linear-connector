/**
 * AI-2280 — Build guard tests.
 *
 * Verifies that guard-runtime-build.mjs exits 0 (allow) or 1 (refuse) in each
 * scenario. Use isolated temp dirs to simulate the runtime tree, a worktree,
 * fresh clones, and marker toggles.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@jest/globals";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GUARD_SRC = resolve(__dirname, "..", "scripts", "guard-runtime-build.mjs");

interface TempRepo {
  root: string;
  cleanup: () => void;
}

/** Create a temp directory tree that mirrors the connector project layout. */
function setupRepo(hasDist: boolean): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "ai-2280-repo-"));
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(GUARD_SRC, join(scriptsDir, "guard-runtime-build.mjs"));
  if (hasDist) {
    const distDir = join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.js"), "// fake build");
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function invokeGuard(guardScript: string, cwd: string, env: Record<string, string> = {}): { status: number | null; stderr: string } {
  try {
    const result = execFileSync(
      process.execPath,
      [guardScript],
      { cwd, env: { ...process.env, ...env }, timeout: 10_000, encoding: "utf8" },
    );
    return { status: 0, stderr: result.stderr ?? "" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr: string; status: number | null };
    return { status: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

describe("build guard — guard-runtime-build.mjs", () => {
  test("refuses when cwd matches projectRoot (runtime tree) and marker is unset (AC1)", () => {
    const repo = setupRepo(true);
    try {
      const guardScript = join(repo.root, "scripts", "guard-runtime-build.mjs");
      const result = invokeGuard(guardScript, repo.root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to build");
      expect(result.stderr).toContain("dist/ is the runtime tree");
    } finally {
      repo.cleanup();
    }
  });

  test("allows when runtime tree with CONNECTOR_DEPLOY=1 (AC2)", () => {
    const repo = setupRepo(true);
    try {
      const guardScript = join(repo.root, "scripts", "guard-runtime-build.mjs");
      const result = invokeGuard(guardScript, repo.root, { CONNECTOR_DEPLOY: "1" });
      expect(result.status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  test("allows from a worktree (cwd differs from projectRoot, different dist/)", () => {
    const repo = setupRepo(true);
    const worktree = mkdtempSync(join(tmpdir(), "ai-2280-wt-"));
    mkdirSync(join(worktree, "dist"), { recursive: true });
    writeFileSync(join(worktree, "dist", "index.js"), "// worktree build");
    try {
      const guardScript = join(repo.root, "scripts", "guard-runtime-build.mjs");
      // cwd=worktree, so cwdReal resolves to worktree; runtimeDist = worktree/dist
      // projectRoot from scriptDir = repo.root; outDir = repo.root/dist
      // outDirReal (repo.root/dist) ≠ runtimeDistReal (worktree/dist) → allow
      const result = invokeGuard(guardScript, worktree);
      expect(result.status).toBe(0);
    } finally {
      repo.cleanup();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("allows when dist/ does not exist (fresh clone)", () => {
    const repo = setupRepo(false);
    try {
      const guardScript = join(repo.root, "scripts", "guard-runtime-build.mjs");
      const result = invokeGuard(guardScript, repo.root);
      expect(result.status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});
