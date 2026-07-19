/**
 * Tests for token-refresh sequential refresh with single-flight, boot-skip,
 * and invalid_grant detection (INF-51).
 *
 * Covers the rewritten token-refresh.ts API introduced in INF-51:
 *   - isRefreshTokenRevoked / clearRevokedState
 *   - getAgentTokenState / getAllTokenStates
 *   - refreshAgent (per-agent single-flight, skip logic, success, failures)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { AgentConfig } from "./agents.js";

// ── ESM-compatible mocks (declared before dynamic import) ───────────────────

const mockUpdateTokens = jest.fn<(name: string, at: string, rt: string) => void>();
const mockIsAgentLocal = jest.fn<(agent: AgentConfig) => boolean>();
const mockGetAgents = jest.fn<() => AgentConfig[]>();
const mockRecordTokenFailure = jest.fn<(name: string, status: number, retriable: boolean, reason: string) => void>();
const mockGetTokenStatus = jest.fn<(name: string) => TokenStatus | undefined>();
const mockNotify = jest.fn<(alert: unknown) => void>();
let mockFetch: jest.Mock<typeof fetch>;
let nextFetchId = 0;

jest.unstable_mockModule("./agents.js", () => ({
  isAgentLocal: mockIsAgentLocal,
  updateTokens: mockUpdateTokens,
  getAgents: mockGetAgents,
  recordTokenFailure: mockRecordTokenFailure,
  getTokenStatus: mockGetTokenStatus,
}));

jest.unstable_mockModule("./alerts/alert-bus.js", () => ({
  notify: mockNotify,
}));

// Dynamic import after mocks are registered
const mod = await import("./token-refresh.js");

interface TokenStatus {
  agentId: string;
  lastRefreshOkAt: string | null;
  expiresAt: string | null;
  lastFailure: { at: string; status: number; retriable: boolean; reason: string } | null;
  state: "healthy" | "stale" | "expired" | "failing" | "unconfigured";
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    linearUserId: "user-test",
    clientId: "test-cid",
    clientSecret: "test-secret",
    accessToken: "old-access-token",
    refreshToken: "valid-refresh-token",
    ...overrides,
  };
}

function resp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const TOKEN_OK = {
  access_token: "new-access-token-abcdef",
  refresh_token: "new-refresh-token-xyz",
  expires_in: 3600,
  token_type: "Bearer",
};

function setMockFetch(impl: jest.Mock<typeof fetch>): void {
  mockFetch = impl;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
}

function makeTokenStatus(overrides: Partial<TokenStatus> = {}): TokenStatus {
  return {
    agentId: "test-agent",
    lastRefreshOkAt: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-18T12:00:00.000Z",
    lastFailure: null,
    state: "healthy",
    ...overrides,
  };
}

beforeEach(() => {
  mockUpdateTokens.mockClear();
  mockIsAgentLocal.mockClear();
  mockGetAgents.mockClear();
  mockRecordTokenFailure.mockClear();
  mockGetTokenStatus.mockClear();
  mockNotify.mockClear();
  // By default all agents are local
  mockIsAgentLocal.mockReturnValue(true);
  // Default getAgents returns an empty list
  mockGetAgents.mockReturnValue([]);
  // Default token status reflects a healthy agent
  mockGetTokenStatus.mockReturnValue(makeTokenStatus());
  // Reset fetch to a default that throws
  globalThis.fetch = (() => {
    throw new Error("fetch not mocked in this test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Token state query helpers ──────────────────────────────────────────────

describe("isRefreshTokenRevoked", () => {
  it("returns false for an agent that has never been refreshed", () => {
    expect(mod.isRefreshTokenRevoked("unknown-agent")).toBe(false);
  });

  it("returns true after a refresh with invalid_grant", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));
    await mod.refreshAgent(makeAgent({ name: "revoked-agent-1" }));
    expect(mod.isRefreshTokenRevoked("revoked-agent-1")).toBe(true);
  });

  it("returns false after clearRevokedState clears the flag", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));
    await mod.refreshAgent(makeAgent({ name: "cleared-agent" }));
    expect(mod.isRefreshTokenRevoked("cleared-agent")).toBe(true);

    mod.clearRevokedState("cleared-agent");
    expect(mod.isRefreshTokenRevoked("cleared-agent")).toBe(false);
  });
});

describe("clearRevokedState", () => {
  it("clears failure state", () => {
    mod.clearRevokedState("fresh-agent-clear");
    expect(mod.isRefreshTokenRevoked("fresh-agent-clear")).toBe(false);
  });

  it("does not throw for a never-before-seen agent", () => {
    expect(() => mod.clearRevokedState("nonexistent-clear")).not.toThrow();
  });
});

describe("getAgentTokenState", () => {
  it("returns undefined for an unknown agent", () => {
    expect(mod.getAgentTokenState("unknown-to-state")).toBeUndefined();
  });

  it("returns state after a successful refresh", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(200, TOKEN_OK),
    ));
    await mod.refreshAgent(makeAgent({ name: "state-success-agent" }));

    const state = mod.getAgentTokenState("state-success-agent");
    expect(state).toBeDefined();
    expect(state!.revoked).toBe(false);
    expect(state!.lastRefreshOkAt).not.toBeNull();
    expect(state!.lastFailureAt).toBeNull();
    expect(state!.expiresAt).not.toBeNull();
  });

  it("returns state with lastFailure set after a failed refresh", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(503, "service unavailable"),
    ));
    await mod.refreshAgent(makeAgent({ name: "state-fail-agent" }));

    const state = mod.getAgentTokenState("state-fail-agent");
    expect(state).toBeDefined();
    expect(state!.lastFailureAt).not.toBeNull();
    expect(state!.lastFailureReason).toContain("503");
  });
});

describe("getAllTokenStates", () => {
  it("returns an object (may be empty)", () => {
    const all = mod.getAllTokenStates();
    expect(typeof all).toBe("object");
  });

  it("returns entries for agents that have been refreshed", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(200, TOKEN_OK),
    ));
    await mod.refreshAgent(makeAgent({ name: "all-agent-a" }));
    await mod.refreshAgent(makeAgent({ name: "all-agent-b" }));

    const all = mod.getAllTokenStates();
    expect(all["all-agent-a"]).toBeDefined();
    expect(all["all-agent-b"]).toBeDefined();
  });
});

// ── refreshAgent ───────────────────────────────────────────────────────────

describe("refreshAgent", () => {
  it("refreshes a token successfully and calls updateTokens", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(200, TOKEN_OK),
    ));

    await mod.refreshAgent(makeAgent({ name: "success-agent" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const body = (mockFetch.mock.calls[0][1] as RequestInit).body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=valid-refresh-token");
    expect(mockUpdateTokens).toHaveBeenCalledWith(
      "success-agent",
      TOKEN_OK.access_token,
      TOKEN_OK.refresh_token,
      TOKEN_OK.expires_in,
    );
  });

  it("skips refresh for non-local agents", async () => {
    mockIsAgentLocal.mockReturnValue(false);
    setMockFetch(jest.fn<typeof fetch>());

    await mod.refreshAgent(makeAgent({ name: "nonlocal-agent" }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateTokens).not.toHaveBeenCalled();
  });

  it("skips refresh when agent has no refresh token", async () => {
    setMockFetch(jest.fn<typeof fetch>());

    await mod.refreshAgent(makeAgent({ name: "no-refresh-agent", refreshToken: "" }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateTokens).not.toHaveBeenCalled();
  });

  it("skips refresh when agent's refresh token was revoked", async () => {
    // First call triggers invalid_grant → sets revoked flag
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));
    await mod.refreshAgent(makeAgent({ name: "revoked-skip-agent" }));
    expect(mod.isRefreshTokenRevoked("revoked-skip-agent")).toBe(true);

    // Second call should skip because revoked
    const fetch2 = jest.fn<typeof fetch>();
    setMockFetch(fetch2);
    await mod.refreshAgent(makeAgent({ name: "revoked-skip-agent" }));

    expect(fetch2).not.toHaveBeenCalled(); // skipped
  });

  it("handles single-flight: concurrent calls for same agent join in-flight promise", async () => {
    let resolveFetch: (v: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchImpl = jest.fn<typeof fetch>().mockReturnValue(fetchPromise);
    setMockFetch(fetchImpl);

    const agent = makeAgent({ name: "single-flight-agent" });
    const p1 = mod.refreshAgent(agent);
    const p2 = mod.refreshAgent(agent); // should join p1

    // Resolve the fetch
    resolveFetch!(resp(200, TOKEN_OK));
    await Promise.all([p1, p2]);

    // Only one fetch call should have been made (single-flight)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // updateTokens called once
    expect(mockUpdateTokens).toHaveBeenCalledTimes(1);
    expect(mockUpdateTokens).toHaveBeenCalledWith(
      "single-flight-agent",
      TOKEN_OK.access_token,
      TOKEN_OK.refresh_token,
      TOKEN_OK.expires_in,
    );
  });

  it("sets revoked flag on invalid_grant (400)", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));

    expect(mod.isRefreshTokenRevoked("invalid-grant-agent")).toBe(false);
    await mod.refreshAgent(makeAgent({ name: "invalid-grant-agent" }));
    expect(mod.isRefreshTokenRevoked("invalid-grant-agent")).toBe(true);
  });

  it("handles non-revoked 4xx without setting revoked flag", async () => {
    // Clean state for this agent
    mod.clearRevokedState("nonrevoked-401-agent");
    expect(mod.isRefreshTokenRevoked("nonrevoked-401-agent")).toBe(false);

    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(401, "unauthorized"),
    ));

    await mod.refreshAgent(makeAgent({ name: "nonrevoked-401-agent" }));
    // 401 != 400 + invalid_grant, so revoked stays false
    expect(mod.isRefreshTokenRevoked("nonrevoked-401-agent")).toBe(false);
  });

  it("handles network error gracefully (sets lastFailure)", async () => {
    setMockFetch(jest.fn<typeof fetch>().mockRejectedValue(
      new Error("ECONNRESET"),
    ));

    await mod.refreshAgent(makeAgent({ name: "network-error-agent" }));

    const state = mod.getAgentTokenState("network-error-agent");
    expect(state).toBeDefined();
    expect(state!.lastFailureAt).not.toBeNull();
    expect(state!.lastFailureReason).toContain("ECONNRESET");
    expect(mockUpdateTokens).not.toHaveBeenCalled();
  });
});

// ── Credential alert (AI-2559) ─────────────────────────────────────────────

describe("credential alert on non-healthy OAuth state (AI-2559)", () => {
  it("AC1: invalid_grant alert fires and identifies the token state", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({
      state: "stale",
      expiresAt: "2026-07-18T12:00:00.000Z",
    }));
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));

    await mod.refreshAgent(makeAgent({ name: "stale-agent" }));

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { title: string };
    expect(alert.title).toMatch(/\(state: stale\)/);
  });

  it("AC2: invalid_grant alert identifies access-token expiry deadline", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({
      state: "stale",
      expiresAt: "2026-07-18T12:00:00.000Z",
    }));
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));

    await mod.refreshAgent(makeAgent({ name: "expiry-agent" }));

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { title: string };
    expect(alert.title).toMatch(/2026-07-18/);
    expect(alert.title).toMatch(/expires at/);
  });

  it("AC3: alert fires within one refresh cycle, not on /health read", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({
      state: "stale",
      expiresAt: "2026-07-18T12:00:00.000Z",
    }));
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));

    await mod.refreshAgent(makeAgent({ name: "inline-agent" }));

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("alert identifies the agent name in both field and title", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({
      agentId: "scout",
      state: "stale",
    }));
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(400, "invalid_grant"),
    ));

    await mod.refreshAgent(makeAgent({ name: "scout" }));

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { agent: string; title: string };
    expect(alert.agent).toBe("scout");
    expect(alert.title).toMatch(/scout/);
  });

  it("notifies after retriable failures are exhausted", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({
      state: "failing",
      lastRefreshOkAt: null,
      expiresAt: null,
    }));
    setMockFetch(jest.fn<typeof fetch>().mockRejectedValue(
      new Error("ECONNRESET"),
    ));

    await mod.refreshAgent(makeAgent({ name: "net-error-alert" }), {
      sleep: async () => undefined,
      rng: () => 0,
    });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { title: string };
    expect(alert.title).toMatch(/\(state: failing\)/);
  });

  it("does not notify on successful refresh", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ state: "healthy" }));
    setMockFetch(jest.fn<typeof fetch>().mockResolvedValue(
      resp(200, TOKEN_OK),
    ));

    await mod.refreshAgent(makeAgent({ name: "healthy-alert-check" }));

    expect(mockNotify).not.toHaveBeenCalled();
  });
});
