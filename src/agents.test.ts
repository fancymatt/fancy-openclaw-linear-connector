import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAccessToken,
  getAgentByProxyToken,
  getAgents,
  isAgentLocal,
  reloadAgents,
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
