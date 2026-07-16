/**
 * AI-2444: the roster must fail closed on active-with-no-token.
 *
 * `active` + no refresh token was a fourth, unnamed state meaning "should be
 * enrolled but isn't". Nothing rejected it, so the hourly credential-liveness
 * probe re-diagnosed it forever: nine tickets, zero roster mutations. These
 * tests pin the state machine that removes it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgent,
  getAgents,
  isPolledForLinear,
  reloadAgents,
  updateAgentMetadata,
  upsertAgent,
  type AgentConfig,
} from "./agents.js";

let dir: string;

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "jiwon",
    linearUserId: "linear-user-jiwon",
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: "",
    refreshToken: "",
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2444-roster-"));
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  // secretsPath keeps syncWorkspaceSecrets inside the temp dir.
  reloadAgents();
});

afterEach(() => {
  delete process.env.AGENTS_FILE;
  reloadAgents();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AC1: adding an active agent with no token is refused", () => {
  test("explicit status:active with no refresh token is coerced to never-onboarded", () => {
    upsertAgent(agent({ status: "active", secretsPath: path.join(dir, "linear.env") }));

    expect(getAgent("jiwon")?.status).toBe("never-onboarded");
  });

  test("absent status with no refresh token is coerced too (absent means active)", () => {
    // This is the state both onboard paths actually create: a pre-OAuth partial
    // entry with refreshToken "" and no status field at all.
    upsertAgent(agent({ secretsPath: path.join(dir, "linear.env") }));

    expect(getAgent("jiwon")?.status).toBe("never-onboarded");
  });

  test("the coerced agent is not polled, so it cannot page the hourly probe", () => {
    upsertAgent(agent({ status: "active", secretsPath: path.join(dir, "linear.env") }));

    expect(isPolledForLinear(getAgent("jiwon")!)).toBe(false);
  });

  test("coercion survives the write: it is persisted, not just returned", () => {
    upsertAgent(agent({ status: "active", secretsPath: path.join(dir, "linear.env") }));
    reloadAgents();

    expect(getAgent("jiwon")?.status).toBe("never-onboarded");
  });

  test("updating an existing agent to active with no token is coerced", () => {
    upsertAgent(agent({ status: "never-onboarded", secretsPath: path.join(dir, "linear.env") }));

    const updated = updateAgentMetadata("jiwon", { status: "active" });

    expect(updated?.status).toBe("never-onboarded");
    expect(getAgent("jiwon")?.status).toBe("never-onboarded");
  });

  test("an agent that already holds a credential stays active", () => {
    upsertAgent(agent({
      status: "active",
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      secretsPath: path.join(dir, "linear.env"),
    }));

    expect(getAgent("jiwon")?.status).toBe("active");
    expect(isPolledForLinear(getAgent("jiwon")!)).toBe(true);
  });

  test("a partial upsert that omits the token does not demote a credentialed agent", () => {
    // The reconcile must read the MERGED entry, not the incoming patch —
    // otherwise a metadata-only upsert reads as "no credential" and silently
    // knocks a live agent off Linear.
    upsertAgent(agent({
      status: "active",
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      secretsPath: path.join(dir, "linear.env"),
    }));

    updateAgentMetadata("jiwon", { displayName: "Jiwon" });

    expect(getAgent("jiwon")?.status).toBe("active");
    expect(getAgent("jiwon")?.refreshToken).toBe("refresh-token-1");
  });
});

describe("AC2: a successful onboard promotes never-onboarded -> active", () => {
  test("storing a refresh token promotes the agent", () => {
    upsertAgent(agent({ status: "never-onboarded", secretsPath: path.join(dir, "linear.env") }));
    expect(getAgent("jiwon")?.status).toBe("never-onboarded");

    // What oauth-callback.ts does on success: re-upsert the entry with the
    // credential Linear just issued.
    upsertAgent(agent({
      status: "never-onboarded",
      linearUserId: "linear-user-jiwon",
      accessToken: "access-token-fresh",
      refreshToken: "refresh-token-fresh",
      secretsPath: path.join(dir, "linear.env"),
    }));

    expect(getAgent("jiwon")?.status).toBe("active");
    expect(isPolledForLinear(getAgent("jiwon")!)).toBe(true);
  });

  test("promotion is automatic — the onboard path never names a status", () => {
    upsertAgent(agent({ status: "never-onboarded", secretsPath: path.join(dir, "linear.env") }));

    upsertAgent(agent({
      accessToken: "access-token-fresh",
      refreshToken: "refresh-token-fresh",
      secretsPath: path.join(dir, "linear.env"),
    }));

    expect(getAgent("jiwon")?.status).toBe("active");
  });
});

describe("off-linear is a decision, not a pending intent", () => {
  test("an off-linear agent with no token is NOT coerced to never-onboarded", () => {
    upsertAgent(agent({ status: "off-linear", secretsPath: path.join(dir, "linear.env") }));

    expect(getAgent("jiwon")?.status).toBe("off-linear");
  });

  test("a credential arriving does NOT silently re-enroll an off-linear agent", () => {
    // Decommissioned by decision (jiwon, hachi, scout). A stray token must not
    // overturn that — re-onboarding is an explicit act, not a side effect.
    upsertAgent(agent({ status: "off-linear", secretsPath: path.join(dir, "linear.env") }));

    upsertAgent(agent({
      status: "off-linear",
      accessToken: "access-token-fresh",
      refreshToken: "refresh-token-fresh",
      secretsPath: path.join(dir, "linear.env"),
    }));

    expect(getAgent("jiwon")?.status).toBe("off-linear");
    expect(isPolledForLinear(getAgent("jiwon")!)).toBe(false);
  });
});

describe("AC3: never-onboarded agents are skipped by the proxy probe", () => {
  // The watchdog (credential-liveness-watchdog.py, check_linear ~line 287)
  // skips whatever /health reports in offLinearAgentNames. That field is built
  // from !isPolledForLinear, so it already carries never-onboarded agents —
  // this pins the contract the Python side depends on, which had no coverage.
  test("/health's offLinearAgentNames carries never-onboarded, not just off-linear", () => {
    upsertAgent(agent({ name: "jiwon", status: "never-onboarded", secretsPath: path.join(dir, "j.env") }));
    upsertAgent(agent({
      name: "scout",
      linearUserId: "linear-user-scout",
      status: "off-linear",
      secretsPath: path.join(dir, "s.env"),
    }));
    upsertAgent(agent({
      name: "igor",
      linearUserId: "linear-user-igor",
      status: "active",
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      secretsPath: path.join(dir, "i.env"),
    }));

    // Mirrors src/index.ts:320.
    const offLinearAgentNames = getAgents()
      .filter((a) => !isPolledForLinear(a))
      .map((a) => a.name);

    expect(offLinearAgentNames).toEqual(expect.arrayContaining(["jiwon", "scout"]));
    expect(offLinearAgentNames).not.toContain("igor");
  });

  test("an agent added active-with-no-token lands in the skip set end to end", () => {
    // The whole bug in one assertion: the state that paged hourly for 3 days
    // now cannot be created, and the probe skips it.
    upsertAgent(agent({ status: "active", secretsPath: path.join(dir, "linear.env") }));

    const offLinearAgentNames = getAgents()
      .filter((a) => !isPolledForLinear(a))
      .map((a) => a.name);

    expect(offLinearAgentNames).toContain("jiwon");
  });
});
