import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgents,
  reloadAgents,
  upsertAgent,
  updateTokens,
  type AgentConfig,
} from "./agents.js";

/**
 * AI-2304 — Kill implicit raw-token else branch in syncWorkspaceSecrets,
 * gate legacy direct-token behind explicit allowDirectToken opt-in.
 *
 * Re-scoped AC (Astrid's 2026-07-14 ruling):
 *
 * 1. upsertAgent new-agent path mints a proxyToken — no agent record can
 *    be created without one (AI-2308 already landed).
 * 2. syncWorkspaceSecrets: falsy proxyToken AND no allowDirectToken opt-in
 *    → writes nothing, preserves any existing file, logs a loud
 *    provisioning-bug error (no implicit raw-token else).
 * 3. allowDirectToken: true → legacy direct-token write still works
 *    (mode 600, atomic — reuses AI-2289's writer).
 * 4. Onboarding non-breaking — guaranteed by (1).
 */

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

describe("AI-2304: allowDirectToken opt-in", () => {
  let dir: string;
  let agentsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2304-"));
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

  // AC2: falsy proxyToken, no allowDirectToken → fail-closed
  test("falsy proxyToken without allowDirectToken writes nothing and preserves existing file", () => {
    const secretsPath = path.join(dir, "linear.env");
    // Write a pre-existing credential file first (as if left from a prior
    // valid state — the target must not be clobbered).
    fs.writeFileSync(secretsPath, "LINEAR_OAUTH_TOKEN=prior-valid-token\n", "utf8");

    // upsertAgent normally mints a proxyToken (AI-2308). To test the
    // fail-closed path we need an agent record with no proxyToken.
    // Directly create the agent record with accessToken but without proxyToken.
    // We do this by calling upsertAgent (which mints) then clearing the field.
    const result = upsertAgent({ ...makeAgent(secretsPath), accessToken: "raw-secret" });
    expect(result.isNew).toBe(true);

    // Verify proxyToken was minted (AI-2308 invariant satisfied)
    const agent = getAgents().find((a) => a.name === "charles")!;
    expect(agent.proxyToken).toMatch(/^lpx_/);

    // The env file should contain the proxy token, not the raw token
    // (already covered by existing tests). This test is about the fail-closed
    // path. Let me construct a scenario where an agent has no proxyToken:
    // clear it from the in-memory store and call syncWorkspaceSecrets
    // via updateTokens, which re-reads from _agents.

    // Actually — with AI-2308 minting, every upserted agent has a proxyToken
    // by construction. The fail-closed path is the edge case where somehow an
    // agent record exists without proxyToken AND without allowDirectToken.
    // This happens in practice when an agent record was written before AI-2308
    // landed or when the record is manually manipulated.

    // Approach: create a test-only agent record that has no proxyToken by
    // writing agents.json directly and reloading.
    const santa: AgentConfig = {
      name: "santa",
      linearUserId: "lu-santa",
      clientId: "c",
      clientSecret: "s",
      accessToken: "raw-token-for-santa",
      refreshToken: "r",
      secretsPath: path.join(dir, "santa.env"),
    };

    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [santa] }), "utf8");
    reloadAgents();

    // santa has no proxyToken and no allowDirectToken → calling
    // syncWorkspaceSecrets must NOT write the raw accessToken.
    // The prior-existing file should be preserved untouched.
    fs.writeFileSync(path.join(dir, "santa.env"), "LINEAR_OAUTH_TOKEN=preexisting-token\n", "utf8");

    // Call updateTokens which triggers syncWorkspaceSecrets
    updateTokens("santa", "raw-token-for-santa", "r");

    // The env file must still contain the preexisting token, not the raw one
    const env = fs.readFileSync(path.join(dir, "santa.env"), "utf8");
    expect(env).toContain("preexisting-token");
    expect(env).not.toContain("raw-token-for-santa");
  });

  // AC3: allowDirectToken: true → legacy direct-token write works
  test("allowDirectToken: true writes the raw accessToken into the env file", () => {
    const secretsPath = path.join(dir, "direct.env");
    const ag: AgentConfig = {
      name: "direct-agent",
      linearUserId: "lu-direct",
      clientId: "c",
      clientSecret: "s",
      accessToken: "raw-direct-token",
      refreshToken: "r",
      secretsPath,
      allowDirectToken: true,
    };

    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [ag] }), "utf8");
    reloadAgents();

    // updateTokens triggers syncWorkspaceSecrets
    updateTokens("direct-agent", "raw-direct-token", "r");

    // The env file must contain the raw token
    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env).toContain("LINEAR_OAUTH_TOKEN=raw-direct-token");
  });

  // AC3: allowDirectToken: true writes with proper mode 600
  test("allowDirectToken: true writes with mode 600", () => {
    const secretsPath = path.join(dir, "direct-mode.env");
    const ag: AgentConfig = {
      name: "mode-agent",
      linearUserId: "lu-mode",
      clientId: "c",
      clientSecret: "s",
      accessToken: "raw-mode-token",
      refreshToken: "r",
      secretsPath,
      allowDirectToken: true,
    };

    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [ag] }), "utf8");
    reloadAgents();

    updateTokens("mode-agent", "raw-mode-token", "r");

    const stat = fs.statSync(secretsPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // AC2 + AC3: agent with proxyToken still works normally
  test("agent with proxyToken writes proxy token, never raw token — unaffected by allowDirectToken", () => {
    const secretsPath = path.join(dir, "proxy.env");
    const ag: AgentConfig = {
      name: "proxy-agent",
      linearUserId: "lu-proxy",
      clientId: "c",
      clientSecret: "s",
      accessToken: "raw-secret",
      refreshToken: "r",
      secretsPath,
      proxyToken: "lpx_proxy_token",
      proxyUrl: "http://proxy:3100",
    };

    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [ag] }), "utf8");
    reloadAgents();

    updateTokens("proxy-agent", "rotated-secret", "rotated-r");

    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env).toContain("LINEAR_OAUTH_TOKEN=lpx_proxy_token");
    expect(env).toContain("LINEAR_PROXY_URL=http://proxy:3100");
    expect(env).not.toContain("raw-secret");
    expect(env).not.toContain("rotated-secret");
  });
});
