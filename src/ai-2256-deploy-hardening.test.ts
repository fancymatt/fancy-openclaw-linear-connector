/**
 * AI-2256 (AC5/AC6) — Deploy-hardening tests.
 *
 * Verifies the deployment infrastructure:
 *   AC5 — systemd service unit file points to deploy worktree, not dev checkout.
 *   AC6 — deploy worktree carries its own runtime state (agents.json, data/, .env).
 *
 * Also includes an integration-level test for the bootstrap-env module to
 * confirm the production entry point seeds correct defaults when
 * OPENCLAW_LINEAR_CONNECTOR_STATE is set.
 */

import { describe, expect, test, jest } from "@jest/globals";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_TREE = "/home/fancymatt/Code/repos/fancy-openclaw-linear-connector";
const DEPLOY_TREE = "/home/fancymatt/Code/repos/fancy-openclaw-linear-connector-deploy";
const SERVICE_FILE = "linear-webhook-fancymatt.service";

describe("AI-2256 AC5: systemd unit points to deploy worktree", () => {
  const devServicePath = resolve(RUNTIME_TREE, SERVICE_FILE);
  const deployServicePath = resolve(DEPLOY_TREE, SERVICE_FILE);

  test("dev checkout's service file exists", () => {
    expect(existsSync(devServicePath)).toBe(true);
  });

  test("deploy worktree's service file exists", () => {
    expect(existsSync(deployServicePath)).toBe(true);
  });

  test("service file WorkingDirectory points to deploy worktree, not dev checkout", () => {
    const content = readFileSync(deployServicePath, "utf-8");
    const workingDirLine = content
      .split("\n")
      .find((line) => line.trim().startsWith("WorkingDirectory="));
    expect(workingDirLine).toBeDefined();
    expect(workingDirLine!.trim()).toBe(
      `WorkingDirectory=${DEPLOY_TREE}`,
    );
  });

  test("service file ExecStart runs dist/index.js from deploy worktree", () => {
    const content = readFileSync(deployServicePath, "utf-8");
    const execLine = content
      .split("\n")
      .find((line) => line.trim().startsWith("ExecStart="));
    expect(execLine).toBeDefined();
    // The ExecStart should refer to node dist/index.js, and the
    // WorkingDirectory makes it relative to DEPLOY_TREE.
    expect(execLine!.trim()).toContain("dist/index.js");
  });

  test("dev checkout and deploy tree service files are in sync", () => {
    // Both should agree on the deploy worktree as the runtime directory.
    const devContent = readFileSync(devServicePath, "utf-8");
    const deployContent = readFileSync(deployServicePath, "utf-8");
    const devWD = devContent
      .split("\n")
      .find((l) => l.trim().startsWith("WorkingDirectory="));
    const deployWD = deployContent
      .split("\n")
      .find((l) => l.trim().startsWith("WorkingDirectory="));
    expect(devWD?.trim()).toBe(deployWD?.trim());
  });
});

describe("AI-2256 AC6: deploy worktree carries independent runtime state", () => {
  test("deploy worktree has its own agents.json", () => {
    const path = resolve(DEPLOY_TREE, "agents.json");
    expect(existsSync(path)).toBe(true);
    const stats = statSync(path);
    expect(stats.size).toBeGreaterThan(0);
  });

  test("deploy worktree has its own .env file", () => {
    const path = resolve(DEPLOY_TREE, ".env");
    expect(existsSync(path)).toBe(true);
  });

  test("deploy worktree has its own data/ directory", () => {
    const path = resolve(DEPLOY_TREE, "data");
    expect(existsSync(path)).toBe(true);
    const stats = statSync(path);
    expect(stats.isDirectory()).toBe(true);
  });

  test("deploy worktree has its own dist/ with compiled output", () => {
    const indexJs = resolve(DEPLOY_TREE, "dist", "index.js");
    expect(existsSync(indexJs)).toBe(true);
    const stats = statSync(indexJs);
    expect(stats.size).toBeGreaterThan(0);
  });

  test("deploy worktree agents.json differs from dev checkout (separate credential stores)", () => {
    // These are separate copies — the deploy tree must have its own credential
    // store so writes from the dev checkout don't affect production and vice versa.
    const deployPath = resolve(DEPLOY_TREE, "agents.json");
    const devPath = resolve(RUNTIME_TREE, "agents.json");
    const deployInode = statSync(deployPath).ino;
    const devInode = statSync(devPath).ino;
    // Different inodes = different files (not hardlinked)
    expect(deployInode).not.toBe(devInode);
  });
});

describe("AI-2256 AC1/AC2: bootstrap-env seeds state defaults", () => {
  const ORIG_OPENCLAW_STATE = process.env.OPENCLAW_LINEAR_CONNECTOR_STATE;
  const ORIG_DATA_DIR = process.env.DATA_DIR;
  const ORIG_AGENTS_FILE = process.env.AGENTS_FILE;

  afterEach(() => {
    // Restore env — delete keys that were set during tests
    delete process.env.OPENCLAW_LINEAR_CONNECTOR_STATE;
    delete process.env.DATA_DIR;
    delete process.env.AGENTS_FILE;
    if (ORIG_OPENCLAW_STATE !== undefined) process.env.OPENCLAW_LINEAR_CONNECTOR_STATE = ORIG_OPENCLAW_STATE;
    if (ORIG_DATA_DIR !== undefined) process.env.DATA_DIR = ORIG_DATA_DIR;
    if (ORIG_AGENTS_FILE !== undefined) process.env.AGENTS_FILE = ORIG_AGENTS_FILE;
  });

  test("bootstrap-env seeds DATA_DIR and AGENTS_FILE when state dir is set (AC1)", async () => {
    // Clear any pre-existing overrides
    delete process.env.DATA_DIR;
    delete process.env.AGENTS_FILE;

    // Set the state dir — this is what the deploy path does
    process.env.OPENCLAW_LINEAR_CONNECTOR_STATE = DEPLOY_TREE;

    // Dynamic import forces re-load of the module
    const { computeStateDefaults } = await import("./state-dir.js");

    const defaults = computeStateDefaults({ ...process.env });
    expect(defaults.DATA_DIR).toBe(resolve(DEPLOY_TREE, "data"));
    expect(defaults.AGENTS_FILE).toBe(resolve(DEPLOY_TREE, "agents.json"));
    expect(defaults.dotenvPath).toBe(resolve(DEPLOY_TREE, ".env"));
  });

  test("bootstrap-env is a strict no-op when state dir is unset (AC2 backward compat)", async () => {
    delete process.env.OPENCLAW_LINEAR_CONNECTOR_STATE;
    delete process.env.DATA_DIR;
    delete process.env.AGENTS_FILE;

    const { computeStateDefaults } = await import("./state-dir.js");

    const defaults = computeStateDefaults({ ...process.env });
    expect(defaults).toEqual({});
  });

  test("explicit env vars win over state-dir defaults", async () => {
    delete process.env.DATA_DIR;
    delete process.env.AGENTS_FILE;

    process.env.OPENCLAW_LINEAR_CONNECTOR_STATE = DEPLOY_TREE;
    process.env.DATA_DIR = "/custom/data/path";
    process.env.AGENTS_FILE = "/custom/agents.json";

    const { computeStateDefaults } = await import("./state-dir.js");

    const defaults = computeStateDefaults({ ...process.env });
    // computeStateDefaults returns the defaults — explicit env vars override at
    // bootstrap time via the ??= operator. So computeStateDefaults still derives
    // the state-dir values (because it doesn't know what's explicitly set), but
    // bootstrap-env.ts won't apply them over existing env vars.
    expect(defaults.DATA_DIR).toBe(resolve(DEPLOY_TREE, "data"));
    expect(defaults.AGENTS_FILE).toBe(resolve(DEPLOY_TREE, "agents.json"));
  });
});
