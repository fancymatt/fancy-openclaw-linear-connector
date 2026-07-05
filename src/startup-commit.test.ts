import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveStartupCommit } from "./startup-commit.js";

describe("resolveStartupCommit (AI-1841)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "startup-commit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers dist/DEPLOY_COMMIT over git HEAD when the stamp exists (AC1)", async () => {
    // A git repo whose HEAD is deliberately NOT the deployed commit — the
    // shared-working-tree-on-a-feature-branch scenario from AI-1813.
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "feature-branch head"], { cwd: dir });
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), "569626c\n");

    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toEqual({ commit: "569626c", source: "deploy-stamp" });
  });

  it("falls back to git HEAD when the stamp is absent (AC2)", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "dev head"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim();

    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toEqual({ commit: head, source: "git" });
  });

  it("treats an empty stamp file as absent and falls back to git", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "head"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim();
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), "  \n");

    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toEqual({ commit: head, source: "git" });
  });

  it("returns unknown when neither stamp nor git repo exists", async () => {
    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toEqual({ commit: "unknown", source: "unknown" });
  });

  it("trims whitespace from the stamp", async () => {
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), "  abc1234\n\n");
    const result = await resolveStartupCommit({ cwd: dir });
    expect(result).toEqual({ commit: "abc1234", source: "deploy-stamp" });
  });

  it("honors an explicit deployCommitPath override", async () => {
    const stamp = path.join(dir, "custom-stamp");
    await writeFile(stamp, "def5678\n");
    const result = await resolveStartupCommit({ cwd: dir, deployCommitPath: stamp });
    expect(result).toEqual({ commit: "def5678", source: "deploy-stamp" });
  });
});
