/**
 * AI-2256 (AC3/AC4) — Tests for guard-build-location.js.
 *
 * Verifies that the prebuild guard correctly refuses builds in the runtime tree
 * (dev checkout) when the deploy marker is absent, and allows them when the
 * marker is set, when in CI, or when in a worktree.
 *
 * The guard is the outer fence: guard-build-location.js runs first (via
 * `prebuild` in package.json), then guard-runtime-build.mjs runs as a second
 * layer. Both must agree. The .mjs guard is tested in ai-2280-build-guard.test.ts.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, jest } from "@jest/globals";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GUARD_SRC = resolve(__dirname, "..", "scripts", "guard-build-location.js");

interface TempRepo {
  root: string;
  cleanup: () => void;
}

function createRepo(hasDist: boolean): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "ai-2256-repo-"));
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(GUARD_SRC, join(scriptsDir, "guard-build-location.js"));
  if (hasDist) {
    const distDir = join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.js"), "// fake build output");
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function invokeGuard(cwd: string, env: Record<string, string> = {}): { status: number | null; stderr: string } {
  try {
    const result = execFileSync(
      process.execPath,
      [join(cwd, "scripts", "guard-build-location.js")],
      { cwd, env: { ...process.env, ...env }, timeout: 10_000, encoding: "utf8" },
    );
    return { status: 0, stderr: "" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr: string; status: number | null };
    return { status: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

describe("AI-2256 AC3: guard-build-location.js refuses build in runtime tree", () => {
  test("refuses when cwd is the runtime tree and no deploy marker is set (AC3)", () => {
    const repo = createRepo(true);
    try {
      const result = invokeGuard(repo.root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to build");
      expect(result.stderr).toContain("live runtime tree");
    } finally {
      repo.cleanup();
    }
  });

  test("refuses when dist/ resolves to runtime tree's dist/ via symlink (AC3)", () => {
    // Simulate: cwd is a symlink that points into the runtime tree.
    const repo = createRepo(true);
    const symlinkCwd = mkdtempSync(join(tmpdir(), "ai-2256-sym-"));
    const realCwd = repo.root;
    // Remove the symlink dir and replace it with a symlink to the runtime tree
    rmSync(symlinkCwd, { recursive: true, force: true });
    symlinkSync(realCwd, symlinkCwd);
    try {
      const result = invokeGuard(symlinkCwd);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to build");
    } finally {
      repo.cleanup();
      rmSync(symlinkCwd, { recursive: true, force: true });
    }
  });
});

describe("AI-2256 AC4: guard-build-location.js allows builds in safe contexts", () => {
  test("allows when CONNECTOR_DEPLOY_BUILD=1 is set (AC4 deploy path)", () => {
    const repo = createRepo(true);
    try {
      const result = invokeGuard(repo.root, { CONNECTOR_DEPLOY_BUILD: "1" });
      expect(result.status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  test("allows when CI env var is set (AC4 CI path)", () => {
    const repo = createRepo(true);
    try {
      const result = invokeGuard(repo.root, { CI: "true" });
      expect(result.status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  test("allows from a worktree (cwd differs from runtime tree root)", () => {
    const repo = createRepo(true);
    // Worktree is a sibling dir with its own dist/
    const worktree = mkdtempSync(join(tmpdir(), "ai-2256-wt-"));
    mkdirSync(join(worktree, "dist"), { recursive: true });
    writeFileSync(join(worktree, "dist", "index.js"), "// worktree build");
    try {
      const result = invokeGuard(worktree);
      // No scripts/ in the worktree — guard is being invoked from repo's scripts
      // but cwd is the worktree. The guard script resolves cwd to worktree,
      // which won't match RUNTIME_TREE, so it should allow.
      // We need to use the repo's guard script, but cwd = worktree.
      const guardPath = join(repo.root, "scripts", "guard-build-location.js");
      const execResult = execFileSync(
        process.execPath,
        [guardPath],
        { cwd: worktree, env: { ...process.env }, timeout: 10_000, encoding: "utf8" },
      );
      expect(execResult.status).toBeUndefined(); // execFileSync throws on non-zero
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { status: number | null };
      expect(e.status).toBe(0); // success exit code
    } finally {
      repo.cleanup();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("allows when dist/ does not exist yet (fresh checkout, first build)", () => {
    const repo = createRepo(false);
    try {
      const result = invokeGuard(repo.root);
      expect(result.status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});

describe("AI-2256 AC3/AC4: guard-build-location.js fail-closed behavior", () => {
  test("writes a clear error message when refusing (AC3 failure UX)", () => {
    const repo = createRepo(true);
    try {
      const result = invokeGuard(repo.root);
      expect(result.status).toBe(1);
      // Must mention the worktree alternative so devs know what to do
      expect(result.stderr).toContain("worktree");
      expect(result.stderr).toContain("git worktree");
      // Must mention the deploy marker so deployers know how to bypass
      expect(result.stderr).toContain("CONNECTOR_DEPLOY_BUILD");
    } finally {
      repo.cleanup();
    }
  });
});
