/**
 * AI-2309 — a partial onboard must never blank a good credential.
 *
 * `upsertAgent` merges `{...existing, ...config}`, so any field the caller names
 * overwrites what is already on the record. The admin onboard endpoint named
 * `accessToken: ""` unconditionally, and its 409 guard only rejects a *fully*
 * onboarded agent (accessToken AND linearUserId). A **partially** onboarded agent —
 * access token issued, OAuth callback not yet back with a linearUserId — sailed
 * through the guard and had its good token overwritten with "". syncWorkspaceSecrets
 * then published `LINEAR_OAUTH_TOKEN=` over its live linear.env and bricked it.
 *
 * Two layers are pinned here, and they are deliberately independent:
 *   1. the caller (admin.ts) carries existing credentials forward instead of blanking;
 *   2. the writer refuses to publish an empty token over anything, for *any* caller.
 *
 * Layer 2 is the one that matters long-term: fixing a caller fixes one bug, but a
 * writer that will not destroy a credential it cannot replace is a property that
 * holds for callers nobody has written yet.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reloadAgents,
  upsertAgent,
  getAgent,
  type AgentConfig,
} from "./agents.js";

const GOOD_TOKEN = "lin_oauth_good_token_do_not_clobber";

describe("AI-2309 — empty token must never overwrite a good credential", () => {
  let dir: string;
  let secretsPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2309-"));
    secretsPath = path.join(dir, ".secrets", "linear.env");
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    fs.writeFileSync(process.env.AGENTS_FILE, JSON.stringify({ agents: [] }), "utf8");
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

  /** A partially-onboarded agent: token issued, OAuth callback has not returned a userId. */
  function partiallyOnboarded(): AgentConfig {
    return {
      name: "charles",
      linearUserId: "", // <- the half that is missing; this is what slips past the 409
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: GOOD_TOKEN,
      refreshToken: "refresh-token",
      openclawAgent: "charles",
      secretsPath,
    };
  }

  /**
   * Drive the real admin endpoint, not a hand-rolled imitation of it.
   *
   * An earlier draft of this file replayed what admin.ts *ought* to send, which
   * quietly modelled the fixed behaviour and passed against the broken code — a test
   * of the mock, not of the endpoint. AC1 is about the endpoint, so hit the endpoint.
   */
  async function postOnboard(): Promise<void> {
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { createAdminRouter } = await import("./admin.js");

    process.env.ADMIN_SECRET = "test-secret";
    const app = express();
    app.use(express.json());
    app.use("/admin", createAdminRouter({ deploymentName: "test" } as never));

    await supertest(app)
      .post("/admin/api/onboard/start")
      .set("x-admin-secret", "test-secret")
      .send({
        agentName: "charles",
        clientId: "client-id",
        clientSecret: "client-secret",
      });
  }

  /** Replay the *pre-fix* payload directly, standing in for any caller that blanks. */
  function reOnboard(overrides: Partial<AgentConfig> = {}): void {
    upsertAgent({
      name: "charles",
      linearUserId: "",
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: "",
      refreshToken: "",
      openclawAgent: "charles",
      secretsPath,
      ...overrides,
    });
  }

  test("re-running the onboard endpoint against a partially-onboarded agent keeps its access token", async () => {
    upsertAgent(partiallyOnboarded());
    expect(getAgent("charles")?.accessToken).toBe(GOOD_TOKEN);

    await postOnboard(); // the 409 does not catch this: linearUserId is still ""

    expect(getAgent("charles")?.accessToken).toBe(GOOD_TOKEN);
  });

  test("re-running the onboard endpoint does not publish an empty credential over the live linear.env", async () => {
    upsertAgent(partiallyOnboarded());
    // AI-2308 brokers the upstream token: what lands in linear.env is the minted
    // `lpx_` proxy token, never GOOD_TOKEN itself. The credential this test
    // protects is therefore the proxy token — the anti-clobber contract is
    // unchanged, only the identity of the credential being protected.
    const before = fs.readFileSync(secretsPath, "utf8");
    expect(before).toMatch(/LINEAR_OAUTH_TOKEN=lpx_/);
    expect(before).not.toContain(GOOD_TOKEN);

    await postOnboard();

    const env = fs.readFileSync(secretsPath, "utf8");
    expect(env).toBe(before); // the live credential survives the partial re-onboard
    expect(env).not.toMatch(/LINEAR_OAUTH_TOKEN=\s*$/m); // the bricking write
  });

  test("the writer itself refuses an empty token — the guard does not depend on the caller", () => {
    upsertAgent(partiallyOnboarded());
    const before = fs.readFileSync(secretsPath, "utf8");

    // A caller that blanks the token anyway — the pre-fix admin.ts, or any future one.
    reOnboard({ accessToken: "", refreshToken: "" });

    // The live credential file must be untouched, not emptied. Post-AI-2308 the
    // live credential is the minted proxy token (the raw GOOD_TOKEN is brokered,
    // never published), so that is what must survive a blanking caller.
    expect(fs.readFileSync(secretsPath, "utf8")).toBe(before);
    expect(fs.readFileSync(secretsPath, "utf8")).toMatch(/LINEAR_OAUTH_TOKEN=lpx_/);
  });

  test("a whitespace-only token is treated as empty, not written as a credential", () => {
    upsertAgent(partiallyOnboarded());
    const before = fs.readFileSync(secretsPath, "utf8");

    reOnboard({ accessToken: "   " });

    expect(fs.readFileSync(secretsPath, "utf8")).toBe(before);
  });

  test("a genuinely new agent with no credential yet writes no file at all, rather than an empty one", () => {
    upsertAgent({
      name: "charles",
      linearUserId: "",
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: "",
      refreshToken: "",
      openclawAgent: "charles",
      secretsPath,
    });

    // Nothing to write — so write nothing. An empty LINEAR_OAUTH_TOKEN= line is a
    // credential file that reads as configured-but-broken, which is worse than absent.
    expect(fs.existsSync(secretsPath)).toBe(false);
  });
});
