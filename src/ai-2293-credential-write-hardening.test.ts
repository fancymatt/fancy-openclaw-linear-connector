/**
 * AI-2293 — the credential writer must never publish through a symlink, and must
 * never leave a truncated or world-readable live secret behind.
 *
 * The incident: grover's `.secrets/linear.env` was a symlink whose relative target
 * was off by one level, resolving to *main's* linear.env. `fs.writeFileSync`
 * follows symlinks, so the connector wrote grover's `lpx_` proxy token straight
 * through the link into main's credential file — a cross-agent credential clobber —
 * and left grover reading a file that was not his. A separate non-atomic write left
 * a 25-byte truncated stub at mode 777 (the `chmodSync` never ran), which cut grover
 * off from Linear for ~1 hour.
 *
 * Two structural fixes, tested here:
 *   1. lstat the target and REFUSE to write when it is a symlink (or any other
 *      non-regular file). We do not follow it, and we do not silently reclaim it —
 *      a symlinked credential path is never intentional, so we want to hear about it.
 *   2. Publish atomically: temp file in the same directory, 0600 fixed on the fd
 *      before the name is resolvable, fsync, then rename(2) over the target. A
 *      reader sees the whole old file or the whole new one, never a partial one.
 */
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadAgents, upsertAgent, updateTokens, type AgentConfig } from "./agents.js";

const PROXY_TOKEN = "lpx_grover_proxy_token";
const PROXY_URL = "https://connector.example/graphql";
const RAW_UPSTREAM_TOKEN = "lin_oauth_raw_upstream_master_credential";

function makeAgent(secretsPath: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "grover",
    linearUserId: "linear-user-grover",
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: RAW_UPSTREAM_TOKEN,
    refreshToken: "refresh-token",
    openclawAgent: "grover",
    secretsPath,
    proxyToken: PROXY_TOKEN,
    proxyUrl: PROXY_URL,
    ...overrides,
  };
}

/** Temp files are hidden dotfiles; the published secret is the only thing left. */
function strayTempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

describe("AI-2293 credential write hardening", () => {
  let dir: string;
  let secretsDir: string;
  let secretsPath: string;
  let errors: string[];
  let realConsoleError: typeof console.error;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2293-"));
    secretsDir = path.join(dir, "grover", ".secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    secretsPath = path.join(secretsDir, "linear.env");

    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    reloadAgents();

    // The logger writes every level to console.error.
    errors = [];
    realConsoleError = console.error;
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
  });

  afterEach(() => {
    console.error = realConsoleError;
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("symlink guard", () => {
    test("refuses to write through a symlink and leaves the link target untouched", () => {
      // Exactly the incident shape: grover's credential path is a symlink pointing
      // at main's real credential file, which holds the raw upstream token.
      const mainSecrets = path.join(dir, "main-linear.env");
      const mainContents = `LINEAR_OAUTH_TOKEN=${RAW_UPSTREAM_TOKEN}\n`;
      fs.writeFileSync(mainSecrets, mainContents, { mode: 0o600 });
      fs.symlinkSync(mainSecrets, secretsPath);

      upsertAgent(makeAgent(secretsPath));

      // The clobber that actually happened must not happen.
      expect(fs.readFileSync(mainSecrets, "utf8")).toBe(mainContents);
      expect(fs.readFileSync(mainSecrets, "utf8")).not.toContain(PROXY_TOKEN);
    });

    test("logs loudly when it finds a symlinked credential path", () => {
      const mainSecrets = path.join(dir, "main-linear.env");
      fs.writeFileSync(mainSecrets, "LINEAR_OAUTH_TOKEN=whatever\n", { mode: 0o600 });
      fs.symlinkSync(mainSecrets, secretsPath);

      upsertAgent(makeAgent(secretsPath));

      const shouted = errors.filter((e) => /symlink/i.test(e));
      expect(shouted.length).toBeGreaterThan(0);
      expect(shouted.join("\n")).toMatch(/\[ERROR\]/);
      // The operator needs to know which path, and where it pointed.
      expect(shouted.join("\n")).toContain(secretsPath);
      expect(shouted.join("\n")).toContain(mainSecrets);
    });

    test("does not auto-repair the symlink — reconciliation is a separate, supervised job", () => {
      const mainSecrets = path.join(dir, "main-linear.env");
      fs.writeFileSync(mainSecrets, "LINEAR_OAUTH_TOKEN=whatever\n", { mode: 0o600 });
      fs.symlinkSync(mainSecrets, secretsPath);

      upsertAgent(makeAgent(secretsPath));

      expect(fs.lstatSync(secretsPath).isSymbolicLink()).toBe(true);
      expect(strayTempFiles(secretsDir)).toEqual([]);
    });

    test("refuses when the credential path is not a regular file at all", () => {
      fs.mkdirSync(secretsPath); // a directory where the secret should be

      upsertAgent(makeAgent(secretsPath));

      expect(fs.statSync(secretsPath).isDirectory()).toBe(true);
      expect(errors.filter((e) => /not a regular file/i.test(e)).length).toBeGreaterThan(0);
    });
  });

  describe("atomic publish", () => {
    test("happy path: writes proxy token + proxy URL at mode 0600 with no stray temp file", () => {
      upsertAgent(makeAgent(secretsPath));

      const contents = fs.readFileSync(secretsPath, "utf8");
      expect(contents).toBe(`LINEAR_OAUTH_TOKEN=${PROXY_TOKEN}\nLINEAR_PROXY_URL=${PROXY_URL}\n`);
      // The raw upstream token must never reach an agent body when a proxy token exists.
      expect(contents).not.toContain(RAW_UPSTREAM_TOKEN);
      expect(fs.lstatSync(secretsPath).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(secretsPath).isFile()).toBe(true);
      expect(strayTempFiles(secretsDir)).toEqual([]);
    });

    test("re-emits the proxy URL on every token refresh", () => {
      upsertAgent(makeAgent(secretsPath));
      updateTokens("grover", "lin_oauth_rotated", "refresh-2");

      const contents = fs.readFileSync(secretsPath, "utf8");
      expect(contents).toContain(`LINEAR_OAUTH_TOKEN=${PROXY_TOKEN}`);
      expect(contents).toContain(`LINEAR_PROXY_URL=${PROXY_URL}`);
      expect(contents).not.toContain("lin_oauth_rotated");
      expect(fs.lstatSync(secretsPath).mode & 0o777).toBe(0o600);
    });

    test("an interrupted publish leaves the live secret intact and no temp behind", () => {
      // A good credential is already in place — the state grover was in before the
      // truncated write destroyed it.
      const good = `LINEAR_OAUTH_TOKEN=${PROXY_TOKEN}\nLINEAR_PROXY_URL=${PROXY_URL}\n`;
      fs.writeFileSync(secretsPath, good, { mode: 0o600 });

      // Kill the publish at the last possible moment, after the temp file is fully
      // written: this is the window that produced the 25-byte stub.
      const realRename = fs.renameSync;
      fs.renameSync = () => {
        throw new Error("EIO: simulated crash mid-publish");
      };
      try {
        upsertAgent(makeAgent(secretsPath, { proxyToken: "lpx_rotated" }));
      } finally {
        fs.renameSync = realRename;
      }

      // The old credential is still whole, still 0600. No truncation, no 777.
      expect(fs.readFileSync(secretsPath, "utf8")).toBe(good);
      expect(fs.lstatSync(secretsPath).mode & 0o777).toBe(0o600);
      // And the half-finished write is not lying around world-readable.
      expect(strayTempFiles(secretsDir)).toEqual([]);
      expect(errors.filter((e) => /Failed to sync token/i.test(e)).length).toBeGreaterThan(0);
    });

    test("never leaves a world-readable file in the secrets dir, whatever the umask", () => {
      const prev = process.umask(0o000);
      try {
        upsertAgent(makeAgent(secretsPath));
        for (const f of fs.readdirSync(secretsDir)) {
          const mode = fs.lstatSync(path.join(secretsDir, f)).mode & 0o777;
          expect(mode & 0o077).toBe(0);
        }
      } finally {
        process.umask(prev);
      }
    });
  });
});
