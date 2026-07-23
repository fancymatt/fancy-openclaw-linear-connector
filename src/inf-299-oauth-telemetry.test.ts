/**
 * INF-299 — OAuth re-auth callback leaves stale token telemetry.
 *
 * Acceptance criteria (verbatim from intake):
 *
 * AC1 — Telemetry update on successful re-auth: When the `/oauth/callback`
 *       endpoint completes a successful code exchange, the handler updates the
 *       agent's token entry: `expiresAt` derived from the new token's
 *       `expires_in`; `lastRefreshOkAt` set to current timestamp; `lastFailure`
 *       cleared (or a success record supersedes the prior failure).
 *
 * AC2 — Derived state reflects health (`severity`): After the telemetry update,
 *       the agent's token record (and any derived fleet status, e.g.
 *       `/admin/api/fleet`) reads as green/healthy — not yellow/degraded.
 *
 * AC3 — Observable via admin API: The updated telemetry fields are observable
 *       via `/admin/api/tokens` immediately after the callback completes,
 *       without waiting for a sweep or refresh cycle.
 *
 * AC4 — The `/oauth/callback` route is registered at server bootstrap (reachable
 *       from the production entry point, proven by an integration test that boots
 *       the entry point and asserts registration). A module-level unit test does
 *       NOT satisfy this.
 *
 * AC5 — Liveness is observable at ac-validate without waiting for the callback
 *       trigger: a startup log line or `/health` endpoint field confirms the
 *       route is registered.
 *
 * RED until the handler is updated to write telemetry fields, the admin API
 * exposes a `/admin/api/tokens` endpoint, and the bootstrap wiring is proven.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

// ── AC4 part 1: source-level wiring check ────────────────────────────────────

describe("AC4: /oauth/callback route wiring in index.ts", () => {
  it("imports handleOAuthCallback from the oauth-callback module", () => {
    expect(
      INDEX_TS.includes(
        'import { handleOAuthCallback } from "./oauth-callback.js"',
      ) ||
      /handleOAuthCallback\s*}\s*from\s*"\.\/oauth-callback\.js"/.test(INDEX_TS),
    ).toBe(true);
  });

  it("registers handleOAuthCallback at the /oauth/callback route", () => {
    // Both paths must be registered: /callback (legacy) and /oauth/callback
    const oauthCount = (INDEX_TS.match(/app\.get\s*\(\s*"\/oauth\/callback"\s*,\s*handleOAuthCallback\s*\)/g) ?? []).length;
    const callbackCount = (INDEX_TS.match(/app\.get\s*\(\s*"\/callback"\s*,\s*handleOAuthCallback\s*\)/g) ?? []).length;
    // At minimum, /oauth/callback must be registered
    expect(oauthCount).toBeGreaterThanOrEqual(1);
    expect(oauthCount + callbackCount).toBeGreaterThanOrEqual(2);
  });
});

// ── AC4 part 2: integration test — boot createApp and assert route is live ────
// Mirrors the pattern in ai-1914-bootstrap-wiring.test.ts.

describe("AC4: /oauth/callback route responds via createApp boot", () => {
  let dir: string;
  let agentsFile: string;
  let appState: ReturnType<typeof createApp>;

  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "inf-299-"));
  }

  function writeAgents(dir: string, agents: Array<Record<string, unknown>>): string {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
    return file;
  }

  beforeEach(() => {
    dir = tempDir();
    agentsFile = writeAgents(dir, [{
      name: "sage",
      linearUserId: "user-sage-12345678",
      openclawAgent: "sage",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accessToken: "existing-access-token",
      refreshToken: "existing-refresh-token",
      lastFailure: {
        at: new Date(Date.now() - 3600_000).toISOString(),
        status: 400,
        retriable: false,
        reason: "invalid_grant",
      },
      host: "local" as const,
    }]);
    process.env.AGENTS_FILE = agentsFile;
    process.env.ADMIN_SECRET = "test-secret";
    // Disable startup drains that try to reach Linear API
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    if (appState) {
      appState.bag?.close();
      appState.sessionTracker?.close();
      appState.agentQueue?.close();
      appState.operationalEventStore?.close();
    }
    jest.restoreAllMocks();
  });

  it("serves the /oauth/callback route (returns 400 for missing params, not 404)", async () => {
    // Dynamic import to get fresh module state
    const { createApp } = await import("./index.js");
    appState = createApp();
    const res = await request(appState.app)
      .get("/oauth/callback")
      .query({});
    // The route exists (not 404) — it returns 400 because code and state are missing
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(400);
    expect(res.text).toContain("Missing");
  });

  it("also serves the legacy /callback route", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();
    const res = await request(appState.app)
      .get("/callback")
      .query({});
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(400);
    expect(res.text).toContain("Missing");
  });

  it("returns 400 for unknown agent via /oauth/callback", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();
    const res = await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "some-code", state: "nonexistent-agent" });
    expect(res.status).toBe(400);
    expect(res.text).toContain('No agent "nonexistent-agent"');
  });
});

// ── AC1, AC2, AC3: telemetry update + health + admin API observability ───────

describe("INF-299: OAuth callback telemetry update", () => {
  let dir: string;
  let agentsFile: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let mockFetchImpl: jest.Mock<typeof fetch>;

  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "inf-299-"));
  }

  function writeAgents(dir: string, agents: Array<Record<string, unknown>>): string {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
    return file;
  }

  beforeEach(async () => {
    dir = tempDir();
    agentsFile = writeAgents(dir, [{
      name: "test-agent",
      linearUserId: "user-test-12345678",
      openclawAgent: "test-agent",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      host: "local" as const,
      // Stale telemetry from a prior failure — should be cleared on re-auth
      lastFailure: {
        at: "2026-07-21T22:31:00.000Z",
        status: 400,
        retriable: false,
        reason: "invalid_grant",
      },
    }]);
    process.env.AGENTS_FILE = agentsFile;
    process.env.ADMIN_SECRET = "test-secret";
    process.env.NODE_ENV = "test";

    // Sync the ESM-cached agents module's in-memory _agents with our temp file.
    const { reloadAgents } = await import("./agents.js");
    reloadAgents();

    // Mock fetch for the OAuth token exchange and viewer query
    originalFetch = globalThis.fetch;
    let callCount = 0;
    mockFetchImpl = jest.fn<typeof fetch>().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      callCount++;

      if (urlStr.includes("oauth/token")) {
        // First call: token exchange with expires_in
        return new Response(JSON.stringify({
          access_token: "new-access-token-value",
          refresh_token: "new-refresh-token-value",
          expires_in: 3600, // 1 hour
          scope: "read write issues:create admin app:assignable app:mentionable",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (urlStr.includes("api.linear.app/graphql")) {
        // Second call: viewer query
        return new Response(JSON.stringify({
          data: { viewer: { id: "user-test-12345678", name: "Test Agent" } },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });
    globalThis.fetch = mockFetchImpl as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    if (appState) {
      appState.bag?.close();
      appState.sessionTracker?.close();
      appState.agentQueue?.close();
      appState.operationalEventStore?.close();
    }
    jest.restoreAllMocks();
  });

  // ── AC1: Telemetry update on successful re-auth ───────────────────────────

  it("AC1: updates expiresAt from the new token's expires_in after callback", async () => {
    const { reloadAgents } = await import("./agents.js");
    reloadAgents();
    const { createApp } = await import("./index.js");
    appState = createApp();

    await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "valid-auth-code", state: "test-agent" });

    reloadAgents();
    const { getAgent } = await import("./agents.js");
    const agent = getAgent("test-agent");

    expect(agent).toBeDefined();
    // expiresAt should be set from the 3600s expires_in
    expect(agent!.expiresAt).toBeDefined();
    const expiresMs = new Date(agent!.expiresAt!).getTime();
    const nowMs = Date.now();
    expect(expiresMs).toBeGreaterThan(nowMs);
    // 3600s ± 10s tolerance
    expect(expiresMs).toBeLessThanOrEqual(nowMs + 3700 * 1000);
  });

  it("AC1: sets lastRefreshOkAt to current timestamp after callback", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();

    await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "valid-auth-code", state: "test-agent" });

    const { reloadAgents } = await import("./agents.js");
    reloadAgents();
    const { getAgent } = await import("./agents.js");
    const agent = getAgent("test-agent");

    expect(agent).toBeDefined();
    expect(agent!.lastRefreshOkAt).toBeDefined();
    const okMs = new Date(agent!.lastRefreshOkAt!).getTime();
    expect(okMs).toBeGreaterThan(Date.now() - 5000);
    expect(okMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("AC1: clears lastFailure after successful callback", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();

    await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "valid-auth-code", state: "test-agent" });

    const { reloadAgents } = await import("./agents.js");
    reloadAgents();
    const { getAgent } = await import("./agents.js");
    const agent = getAgent("test-agent");

    expect(agent).toBeDefined();
    // The prior invalid_grant failure must be cleared
    expect(agent!.lastFailure).toBeUndefined();
  });

  it("AC1: updates accessToken and refreshToken from the OAuth response", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();

    await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "valid-auth-code", state: "test-agent" });

    const { reloadAgents } = await import("./agents.js");
    reloadAgents();
    const { getAgent } = await import("./agents.js");
    const agent = getAgent("test-agent");

    expect(agent).toBeDefined();
    expect(agent!.accessToken).toBe("new-access-token-value");
    expect(agent!.refreshToken).toBe("new-refresh-token-value");
  });

  // ── AC2: Derived state reflects health ───────────────────────────────────

  it("AC2: token state reads as 'healthy' via getTokenStatus after callback", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();

    await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "valid-auth-code", state: "test-agent" });

    const { reloadAgents } = await import("./agents.js");
    reloadAgents();
    const { getTokenStatus } = await import("./agents.js");
    const status = getTokenStatus("test-agent");

    expect(status).toBeDefined();
    expect(status!.state).toBe("healthy");
    expect(status!.lastRefreshOkAt).toBeDefined();
    expect(status!.expiresAt).toBeDefined();
    expect(status!.lastFailure).toBeNull();
  });

  // ── AC3: Observable via admin API ─────────────────────────────────────────

  it("AC3: telemetry fields are readable via /admin/api/tokens after callback", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();

    await request(appState.app)
      .get("/oauth/callback")
      .query({ code: "valid-auth-code", state: "test-agent" });

    // The updated telemetry must be observable immediately
    const tokensRes = await request(appState.app)
      .get("/admin/api/tokens")
      .set("x-admin-secret", "test-secret");

    // The endpoint should exist and return token data
    expect(tokensRes.status).not.toBe(404);

    // The response must include the updated telemetry
    const body = tokensRes.body as { tokens?: Array<Record<string, unknown>> };
    const tokens = body.tokens ?? (Array.isArray(body) ? body : [body]);
    const testToken = tokens.find(
      (t: Record<string, unknown>) => t.agentId === "test-agent" || t.name === "test-agent",
    ) ?? (tokens.length > 0 ? tokens[0] : undefined);

    expect(testToken).toBeDefined();
    expect(testToken!.expiresAt).toBeDefined();
    expect(testToken!.lastRefreshOkAt).toBeDefined();
    // lastFailure should be cleared or null
    expect(testToken!.lastFailure).toBeFalsy();
    expect(testToken!.state).toBe("healthy");
  });
});

// ── AC5: Liveness observable at /health ───────────────────────────────────────

describe("AC5: /health exposes oauth-callback route registration", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "inf-299-"));
  }

  function writeAgents(dir: string): string {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({
      agents: [{
        name: "test-agent",
        linearUserId: "user-test-12345678",
        openclawAgent: "test-agent",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        host: "local" as const,
      }],
    }), "utf8");
    return file;
  }

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    if (appState) {
      appState.bag?.close();
      appState.sessionTracker?.close();
      appState.agentQueue?.close();
      appState.operationalEventStore?.close();
    }
  });

  it("AC5: /health returns a field confirming the oauth callback route is registered", async () => {
    const { createApp } = await import("./index.js");
    appState = createApp();
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    // Must expose a field confirming the oauth callback route registration.
    // Candidate field names: oauthCallback, oauth, oauthRouteRegistered, etc.
    const oauthField = (
      body.oauthCallback ??
      body.oauth ??
      body.oauthRouteRegistered ??
      body.oauthCallbackRoute ??
      (body.routes as Record<string, unknown>)?.oauth?.callback ??
      undefined
    );

    expect(oauthField).toBeDefined();
    // Must read as registered/true
    if (typeof oauthField === "boolean") {
      expect(oauthField).toBe(true);
    } else if (typeof oauthField === "object") {
      expect((oauthField as Record<string, unknown>).registered).toBe(true);
    }
  });
});
