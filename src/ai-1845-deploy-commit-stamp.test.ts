/**
 * AI-1845 — /health should report DEPLOY_COMMIT stamp, not git HEAD.
 *
 * The deploy script stamps `dist/DEPLOY_COMMIT` with the actually-deployed
 * build's commit. Previously getStartupCommit() always read git HEAD, which
 * can drift from the deployed build after a merge-without-redeploy. These
 * tests cover both resolution paths in resolveStartupCommit():
 *
 *   AC1: stamp present → returns stamp
 *   AC2: stamp absent  → falls back to git HEAD (dev)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveStartupCommit } from "./startup-commit.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-1845-commit-"));
}

function gitHeadShort(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

describe("AI-1845: resolveStartupCommit", () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1 — returns dist/DEPLOY_COMMIT stamp when present", async () => {
    dir = tempDir();
    const stamp = "276624c";
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "DEPLOY_COMMIT"), stamp, "utf8");

    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toBe(stamp);
  });

  test("AC1 — trims whitespace from the stamp", async () => {
    dir = tempDir();
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "DEPLOY_COMMIT"), "  abc1234\n", "utf8");

    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toBe("abc1234");
  });

  test("AC2 — falls back to git HEAD when stamp is absent", async () => {
    // Use the real repo root so git HEAD resolves to a meaningful value.
    // Point deployCommitPath at a non-existent file to exercise the fallback.
    const repoRoot = process.cwd();
    dir = tempDir(); // still set so afterEach cleanup is valid

    const result = await resolveStartupCommit({ cwd: repoRoot, deployCommitPath: path.join(dir, "dist", "DEPLOY_COMMIT") });
    const expected = gitHeadShort(repoRoot);
    expect(result).toBe(expected);
  });

  test("AC2 — returns 'unknown' when stamp is absent and git is unavailable", async () => {
    // A directory with no .git → git rev-parse fails.
    dir = tempDir();

    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toBe("unknown");
  });

  test("blank stamp falls through to git HEAD", async () => {
    const repoRoot = process.cwd();
    dir = tempDir();
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "DEPLOY_COMMIT"), "  \n", "utf8");

    const result = await resolveStartupCommit({ cwd: repoRoot, deployCommitPath: path.join(dir, "dist", "DEPLOY_COMMIT") });
    const expected = gitHeadShort(repoRoot);
    expect(result).toBe(expected);
  });
});
