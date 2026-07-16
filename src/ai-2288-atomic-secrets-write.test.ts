/**
 * AI-2288 — the agent secrets write must be atomic.
 *
 * `syncWorkspaceSecrets` rewrites every agent's `.secrets/linear.env` on *every*
 * OAuth token refresh. The liveness scheduler cron reads that same file every 30s.
 * The old implementation was:
 *
 *     fs.writeFileSync(secretsPath, contents, "utf8");  // O_TRUNC — truncate, then write
 *     fs.chmodSync(secretsPath, 0o600);                 // mode fixed only AFTER it is visible
 *
 * which leaves two observable windows, both of which were caught in the wild on
 * `grover/.secrets/linear.env` during triage:
 *
 *   1. truncate/partial — a reader sees an empty or half-written file (`size=25`),
 *      finds no `lpx_` line, and the scheduler dies with a misleading 401.
 *   2. mode flap — the file is briefly world-readable (`mode=777`) before chmod lands.
 *
 * The fix is the standard atomic publish: temp file in the *same* directory, mode
 * 0600 set on the fd before it is ever visible, then `rename(2)` into place. A
 * concurrent reader then only ever sees the complete old file or the complete new
 * one. These tests pin each property of that contract independently.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reloadAgents,
  updateTokens,
  upsertAgent,
  type AgentConfig,
} from "./agents.js";

function makeAgent(secretsPath: string): AgentConfig {
  return {
    name: "charles",
    linearUserId: "linear-user-1",
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    openclawAgent: "charles",
    secretsPath,
  };
}

const PROXY = {
  proxyToken: "lpx_charles_secret",
  proxyUrl: "http://127.0.0.1:3100/proxy/graphql",
};

describe("AI-2288 — atomic secrets write", () => {
  let dir: string;
  let secretsDir: string;
  let secretsPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2288-atomic-"));
    secretsDir = path.join(dir, ".secrets");
    secretsPath = path.join(secretsDir, "linear.env");
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    delete process.env.SECRETS_DIR;
    reloadAgents();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Provision the agent so a subsequent updateTokens() is a pure refresh-path rewrite. */
  function provision(): void {
    upsertAgent({ ...makeAgent(secretsPath), ...PROXY });
  }

  test("the live secrets path is never written in place — it is published by rename(2)", () => {
    provision();

    const writeSpy = jest.spyOn(fs, "writeFileSync");
    const renameSpy = jest.spyOn(fs, "renameSync");

    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    // O_TRUNC on the live path is precisely the truncate window. It must not happen.
    for (const [target] of writeSpy.mock.calls) {
      expect(target).not.toBe(secretsPath);
    }

    const publish = renameSpy.mock.calls.find(([, dest]) => dest === secretsPath);
    expect(publish).toBeDefined();
  });

  test("the temp file lives in the same directory, so rename(2) cannot cross a mount", () => {
    provision();
    const renameSpy = jest.spyOn(fs, "renameSync");

    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    const publish = renameSpy.mock.calls.find(([, dest]) => dest === secretsPath);
    expect(publish).toBeDefined();
    const [tmp] = publish!;
    // rename(2) is only atomic within a single filesystem.
    expect(path.dirname(String(tmp))).toBe(path.dirname(secretsPath));
  });

  test("a concurrent reader never sees a truncated or partial file: the old content is intact until the instant of the swap", () => {
    provision();
    const before = fs.readFileSync(secretsPath, "utf8");
    expect(before).toContain("LINEAR_OAUTH_TOKEN=lpx_charles_secret");

    // Sample the live path at the exact moment the new file is published. Under the
    // old truncate-then-write code this content was already destroyed by then.
    let observedAtSwap: string | undefined;
    const realRename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === secretsPath) observedAtSwap = fs.readFileSync(secretsPath, "utf8");
      return realRename(from, to);
    });

    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    expect(observedAtSwap).toBe(before);
    expect(observedAtSwap).toContain("LINEAR_OAUTH_TOKEN=lpx_charles_secret");
    expect(observedAtSwap!.length).toBeGreaterThan(0);
  });

  test("the file is already 0600 before it becomes visible — no world-readable mode flap", () => {
    provision();

    let modeAtSwap: number | undefined;
    const realRename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === secretsPath) modeAtSwap = fs.statSync(from as string).mode & 0o777;
      return realRename(from, to);
    });

    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    // The mode must be correct on the temp file, before the name is ever resolvable.
    expect(modeAtSwap).toBe(0o600);
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  test("mode is not repaired after the fact — no chmod on the live path once it is visible", () => {
    provision();
    const chmodSpy = jest.spyOn(fs, "chmodSync");

    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    // A post-hoc chmod on the live path IS the mode-flap window.
    for (const [target] of chmodSpy.mock.calls) {
      expect(target).not.toBe(secretsPath);
    }
  });

  test("content still lands correctly, and the temp file is not left behind", () => {
    provision();
    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env).toContain("LINEAR_OAUTH_TOKEN=lpx_charles_secret");
    expect(env).toContain("LINEAR_PROXY_URL=http://127.0.0.1:3100/proxy/graphql");
    expect(env).not.toContain("rotated-real-token");

    // No turds: a reader globbing the dir must not find a half-written stray.
    expect(fs.readdirSync(secretsDir)).toEqual(["linear.env"]);
  });

  test("a failed publish leaves the previous credentials intact and cleans up the temp file", () => {
    provision();
    const before = fs.readFileSync(secretsPath, "utf8");

    jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV: simulated cross-device publish failure");
    });

    // The write is best-effort and must not throw out of the refresh path...
    expect(() => updateTokens("charles", "rotated-real-token", "rotated-refresh")).not.toThrow();

    // ...and must fail closed: the old, valid credentials are still readable.
    expect(fs.readFileSync(secretsPath, "utf8")).toBe(before);
    expect(fs.readdirSync(secretsDir)).toEqual(["linear.env"]);
  });

  /**
   * AI-2289 §2 — the symlink-follow clobber.
   *
   * The pre-rename writer called writeFileSync on the *resolved* path, and
   * writeFileSync follows symlinks. On 2026-07-14 an off-by-one relative link
   * (`../../` where `../../../` was meant) pointed grover's linear.env at main's,
   * and grover's proxy token was published straight through it into main's
   * credential file — a cross-agent credential overwrite, confirmed by matching
   * sha256(token) across both files.
   *
   * rename(2) replaces the *link itself*, never its target, so publishing by rename
   * closes this by construction. These tests pin that, and pin that the reclaim is
   * loud — a silent one would destroy the only evidence that something is still
   * creating these links.
   */
  describe("symlinked credential path (AI-2289 §2)", () => {
    /** A symlinked linear.env pointing at another agent's real credential file. */
    function plantSymlinkTo(victimPath: string): void {
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(victimPath, "LINEAR_OAUTH_TOKEN=lin_oauth_main_untouched\n", "utf8");
      fs.chmodSync(victimPath, 0o600);
      fs.symlinkSync(victimPath, secretsPath);
    }

    test("never publishes a token through the link — the victim's file is untouched", () => {
      const victimPath = path.join(dir, "victim-main.env");
      plantSymlinkTo(victimPath);

      provision();

      // The whole point: main's credential file must not have been overwritten.
      expect(fs.readFileSync(victimPath, "utf8")).toBe("LINEAR_OAUTH_TOKEN=lin_oauth_main_untouched\n");
    });

    test("reclaims the path as a regular 0600 file holding this agent's own token", () => {
      const victimPath = path.join(dir, "victim-main.env");
      plantSymlinkTo(victimPath);

      provision();

      expect(fs.lstatSync(secretsPath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(secretsPath).isFile()).toBe(true);
      expect(fs.lstatSync(secretsPath).mode & 0o777).toBe(0o600);

      const env = fs.readFileSync(secretsPath, "utf8");
      expect(env).toContain(`LINEAR_OAUTH_TOKEN=${PROXY.proxyToken}`);
      expect(env).toContain(`LINEAR_PROXY_URL=${PROXY.proxyUrl}`);
      // The victim's contents must not have been inherited into the reclaimed file.
      expect(env).not.toContain("lin_oauth_main_untouched");
    });

    test("shouts — a reclaim is never silent, and names the path the token may have leaked to", () => {
      const victimPath = path.join(dir, "victim-main.env");
      plantSymlinkTo(victimPath);

      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      provision();

      const shouted = errSpy.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("SECURITY"));

      expect(shouted).toHaveLength(1);
      // Must name where the credential may already have been written, or the alert
      // is not actionable — that path is what has to be rotated.
      expect(shouted[0]).toContain(victimPath);
    });

    test("does not cry wolf on the ordinary case — a regular file is reclaimed silently", () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      provision(); // no symlink planted; plain first write
      updateTokens("charles", "rotated-real-token", "rotated-refresh"); // and a refresh

      const shouted = errSpy.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("SECURITY"));

      expect(shouted).toEqual([]);
    });
  });
});
