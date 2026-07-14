import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAccessToken,
  getAgentByProxyToken,
  getAgents,
  getTokenStatus,
  isAgentLocal,
  recordTokenFailure,
  reloadAgents,
  safeReloadAgents,
  updateAgentMetadata,
  updateTokens,
  upsertAgent,
  type AgentConfig,
} from "./agents.js";

const key = Buffer.alloc(32, 7).toString("base64");

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

describe("isAgentLocal", () => {
  const baseAgent: AgentConfig = {
    name: "felix",
    linearUserId: "linear-user-felix",
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: "access-token",
    refreshToken: "refresh-token",
  };

  test("returns true when secretsPath is set, regardless of host workspace dir", () => {
    const agent: AgentConfig = { ...baseAgent, secretsPath: "/container/path/linear.env" };
    expect(isAgentLocal(agent)).toBe(true);
  });

  test("returns false when no secretsPath and host workspace dir does not exist", () => {
    const agent: AgentConfig = { ...baseAgent, openclawAgent: "nonexistent-agent-xyz" };
    expect(isAgentLocal(agent)).toBe(false);
  });
});

describe("agents credential file encryption", () => {
  let dir: string;
  let agentsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-encryption-test-"));
    agentsFile = path.join(dir, "agents.json");
    process.env.AGENTS_FILE = agentsFile;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("saves plaintext when no encryption key is configured", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));

    const raw = fs.readFileSync(agentsFile, "utf8");
    const parsed = JSON.parse(raw) as { agents?: AgentConfig[] };

    expect(parsed.agents).toHaveLength(1);
    expect(raw).toContain("access-token-1");
    expect(getAgents()).toHaveLength(1);
  });

  test("encrypts agents.json and decrypts it on reload when key is configured", () => {
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;

    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    const raw = fs.readFileSync(agentsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed).toMatchObject({ version: 2, alg: "AES-256-GCM" });
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("tag");
    expect(parsed).toHaveProperty("ct");
    expect(raw).not.toContain("access-token-1");
    expect(raw).not.toContain("refresh-token-1");

    reloadAgents();
    expect(getAccessToken("charles")).toBe("access-token-1");
  });

  test("token refresh writes encrypted credentials back to disk", () => {
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;
    upsertAgent(makeAgent(path.join(dir, "linear.env")));

    updateTokens("charles", "access-token-2", "refresh-token-2");

    const raw = fs.readFileSync(agentsFile, "utf8");
    expect(raw).toContain('"version": 2');
    expect(raw).not.toContain("access-token-2");
    expect(raw).not.toContain("refresh-token-2");

    reloadAgents();
    expect(getAccessToken("charles")).toBe("access-token-2");
  });

  test("migrates plaintext to encrypted on first save with key configured", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    expect(fs.readFileSync(agentsFile, "utf8")).toContain("access-token-1");

    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;
    updateTokens("charles", "access-token-2", "refresh-token-2");

    const raw = fs.readFileSync(agentsFile, "utf8");
    expect(raw).toContain('"version": 2');
    expect(raw).not.toContain("access-token-2");
    reloadAgents();
    expect(getAccessToken("charles")).toBe("access-token-2");
  });

  test("throws clearly when encrypted file exists but no key is configured", () => {
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;

    expect(() => reloadAgents()).toThrow(/Encrypted agents file present/);

    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;
  });

  test("reads key material from LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE", () => {
    const keyFile = path.join(dir, "agents.key");
    fs.writeFileSync(keyFile, `${key}\n`, "utf8");
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE = keyFile;

    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    expect(fs.readFileSync(agentsFile, "utf8")).toContain('"version": 2');

    reloadAgents();
    expect(getAccessToken("charles")).toBe("access-token-1");
  });
});

describe("broker proxy-token model", () => {
  let dir: string;
  let agentsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-broker-test-"));
    agentsFile = path.join(dir, "agents.json");
    process.env.AGENTS_FILE = agentsFile;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    delete process.env.SECRETS_DIR;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("getAgentByProxyToken resolves an agent by its proxy token", () => {
    upsertAgent({
      ...makeAgent(path.join(dir, "linear.env")),
      proxyToken: "lpx_charles_secret",
      proxyUrl: "http://127.0.0.1:3100/proxy/graphql",
    });
    expect(getAgentByProxyToken("lpx_charles_secret")?.name).toBe("charles");
    expect(getAgentByProxyToken("unknown")).toBeUndefined();
    expect(getAgentByProxyToken("")).toBeUndefined();
  });

  test("syncWorkspaceSecrets writes the proxy token + URL, never the real token, when provisioned", () => {
    const secretsPath = path.join(dir, "linear.env");
    upsertAgent({
      ...makeAgent(secretsPath),
      accessToken: "real-secret-token",
      proxyToken: "lpx_charles_secret",
      proxyUrl: "http://127.0.0.1:3100/proxy/graphql",
    });

    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env).toContain("LINEAR_OAUTH_TOKEN=lpx_charles_secret");
    expect(env).toContain("LINEAR_PROXY_URL=http://127.0.0.1:3100/proxy/graphql");
    expect(env).not.toContain("real-secret-token");
  });

  test("syncWorkspaceSecrets keeps legacy direct-token behavior when no proxy token is set", () => {
    const secretsPath = path.join(dir, "linear.env");
    upsertAgent({ ...makeAgent(secretsPath), accessToken: "real-secret-token" });

    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env.trim()).toBe("LINEAR_OAUTH_TOKEN=real-secret-token");
    expect(env).not.toContain("LINEAR_PROXY_URL");
  });

  test("token refresh does not leak the real token into a provisioned agent's env", () => {
    const secretsPath = path.join(dir, "linear.env");
    upsertAgent({
      ...makeAgent(secretsPath),
      proxyToken: "lpx_charles_secret",
      proxyUrl: "http://127.0.0.1:3100/proxy/graphql",
    });

    updateTokens("charles", "rotated-real-token", "rotated-refresh");

    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env).toContain("LINEAR_OAUTH_TOKEN=lpx_charles_secret");
    expect(env).toContain("LINEAR_PROXY_URL=http://127.0.0.1:3100/proxy/graphql");
    expect(env).not.toContain("rotated-real-token");
    // The rotated real token still lands in the vault for the proxy to use.
    expect(getAccessToken("charles")).toBe("rotated-real-token");
  });
});

describe("safeReloadAgents — malformed hot edit must not crash (audit #15)", () => {
  let dir: string;
  let agentsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-safe-reload-"));
    agentsFile = path.join(dir, "agents.json");
    process.env.AGENTS_FILE = agentsFile;
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [{ name: "felix", linearUserId: "u1" }] }), "utf8");
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
    reloadAgents();
  });

  test("valid edit reloads and returns true", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [{ name: "felix", linearUserId: "u1" }, { name: "igor", linearUserId: "u2" }] }), "utf8");
    expect(safeReloadAgents()).toBe(true);
    expect(getAgents().map((a) => a.name)).toEqual(["felix", "igor"]);
  });

  test("malformed edit keeps last-good registry and does not throw", () => {
    fs.writeFileSync(agentsFile, "{ agents: [ TRUNCATED", "utf8");
    expect(() => safeReloadAgents()).not.toThrow();
    expect(safeReloadAgents()).toBe(false);
    expect(getAgents().map((a) => a.name)).toEqual(["felix"]);
  });
});

describe("getTokenStatus — credential state ladder (AI-2231)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-token-status-"));
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The bug: a never-onboarded credential has no lastRefreshOkAt, no expiresAt,
  // and no lastFailure, so it fell through the ladder to "healthy" — masking a
  // dead/never-configured cred that 401s in practice (jiwon case on AI-2230).
  test("reports a never-onboarded credential as unconfigured, not healthy", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));

    const status = getTokenStatus("charles");
    expect(status).toBeDefined();
    expect(status!.lastRefreshOkAt).toBeNull();
    expect(status!.expiresAt).toBeNull();
    expect(status!.lastFailure).toBeNull();
    // The core assertion: must not read as healthy.
    expect(status!.state).not.toBe("healthy");
    expect(status!.state).toBe("unconfigured");
  });

  test("a successfully refreshed credential still reports healthy", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    updateTokens("charles", "access-2", "refresh-2", 24 * 60 * 60);

    expect(getTokenStatus("charles")!.state).toBe("healthy");
  });

  test("a never-refreshed credential with a recorded failure reports failing, not unconfigured", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    recordTokenFailure("charles", 401, false, "unauthorized");

    // lastFailure && !lastRefreshOkAt is caught by the earlier "failing" branch;
    // the unconfigured branch must not shadow it.
    expect(getTokenStatus("charles")!.state).toBe("failing");
  });
});

/**
 * AI-2305 — save() must chmod agents.json to 0600 on every write.
 *
 * agents.json holds AES-256-GCM-encrypted agent secrets at rest, but save()
 * wrote it with a bare writeFileSync and no chmodSync, so the file regressed to
 * the umask default (0664 observed, group/other-readable) on every token refresh
 * and registry edit.
 *
 * These tests force a permissive umask (0o022) so a passing result proves the
 * mode is applied by the code, not inherited from ambient process state.
 */
describe("agents.json file mode hardening (AI-2305)", () => {
  const MODE_MASK = 0o777;
  const PERMISSIVE_UMASK = 0o022;

  let dir: string;
  let agentsFile: string;
  let previousUmask: number;

  function modeOf(filePath: string): number {
    return fs.statSync(filePath).mode & MODE_MASK;
  }

  beforeEach(() => {
    // A permissive umask is the whole point: under 0o022 a bare writeFileSync
    // creates 0644, so 0600 can only come from an explicit chmod in save().
    previousUmask = process.umask(PERMISSIVE_UMASK);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-mode-test-"));
    agentsFile = path.join(dir, "agents.json");
    process.env.AGENTS_FILE = agentsFile;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
    process.umask(previousUmask);
  });

  // AC1 (fresh create) + AC2: on-disk mode is 0600 after save() under umask 0o022.
  test("fresh create under a permissive umask lands at 0600, not the umask default", () => {
    expect(fs.existsSync(agentsFile)).toBe(false);

    upsertAgent(makeAgent(path.join(dir, "linear.env")));

    expect(fs.existsSync(agentsFile)).toBe(true);
    expect(modeOf(agentsFile)).toBe(0o600);
  });

  // AC1 (rewrite): the regression itself — writeFileSync does not reset the mode
  // of an existing file, so a file left at 0664 stays group/other-readable
  // through every subsequent save() unless save() chmods it back.
  test("rewrite re-asserts 0600 on a file that is already group/other-readable", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    fs.chmodSync(agentsFile, 0o664);
    expect(modeOf(agentsFile)).toBe(0o664);

    // Token refresh is the hot path that rewrites the file in production.
    updateTokens("charles", "access-token-2", "refresh-token-2");

    expect(modeOf(agentsFile)).toBe(0o600);
  });

  // AC1: the mode guarantee holds on the encrypted branch of save() too — that
  // is the branch that actually puts ciphered secrets on disk.
  test("encrypted writes are 0600 as well", () => {
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;

    upsertAgent(makeAgent(path.join(dir, "linear.env")));

    const raw = fs.readFileSync(agentsFile, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 2, alg: "AES-256-GCM" });
    expect(modeOf(agentsFile)).toBe(0o600);
  });

  // AC1: every exported mutator routes through save(), so none of them may leave
  // the file readable. updateAgentMetadata is the third writer, distinct from
  // upsertAgent (create) and updateTokens (refresh).
  test("metadata edits also leave the file at 0600", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    fs.chmodSync(agentsFile, 0o644);

    updateAgentMetadata("charles", { openclawAgent: "charles-renamed" });

    expect(modeOf(agentsFile)).toBe(0o600);
  });

  // AC4: no behavioral change beyond file mode — the round-trip still works.
  test("round-trip read/write is unaffected by the mode change (plaintext)", () => {
    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    updateTokens("charles", "access-token-2", "refresh-token-2");

    reloadAgents();

    expect(getAgents()).toHaveLength(1);
    expect(getAccessToken("charles")).toBe("access-token-2");
    expect(modeOf(agentsFile)).toBe(0o600);
  });

  // AC4: same round-trip guarantee on the encrypted branch.
  test("round-trip read/write is unaffected by the mode change (encrypted)", () => {
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = key;

    upsertAgent(makeAgent(path.join(dir, "linear.env")));
    updateTokens("charles", "access-token-3", "refresh-token-3");
    reloadAgents();

    expect(getAccessToken("charles")).toBe("access-token-3");
    expect(fs.readFileSync(agentsFile, "utf8")).not.toContain("access-token-3");
    expect(modeOf(agentsFile)).toBe(0o600);
  });
});
