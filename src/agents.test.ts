import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAccessToken,
  getAgents,
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
