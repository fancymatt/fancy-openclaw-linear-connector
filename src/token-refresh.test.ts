/**
 * Tests for token-refresh retry-with-backoff (AI-1911).
 *
 * Regression guard for the no-retry gap surfaced by AI-1907: a single transient
 * upstream 503 must not skip a refresh cycle, because the next scheduled attempt
 * is ~20h out and can land after the ~24h token expires — silently 401ing every
 * proxied Linear call for that agent.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ── ESM-compatible mocks (declared before dynamic import) ───────────────────

const mockUpdateTokens = jest.fn<(name: string, at: string, rt: string, expiresIn?: number) => void>();
const mockRecordTokenFailure = jest.fn<(name: string, status: number, retriable: boolean, reason: string) => void>();
const mockGetAgents = jest.fn<() => { name: string; expiresAt?: string }[]>();
const mockGetTokenStatus = jest.fn<(agentName: string) => TokenStatus | undefined>();
const mockNotify = jest.fn<(alert: unknown) => void>();

jest.unstable_mockModule("./agents.js", () => ({
  // isAgentLocal is called before any network work; make every test agent local.
  isAgentLocal: jest.fn().mockReturnValue(true),
  // isPolledForLinear: all test agents are polled by default.
  isPolledForLinear: jest.fn().mockReturnValue(true),
  updateTokens: mockUpdateTokens,
  recordTokenFailure: mockRecordTokenFailure,
  getAgents: mockGetAgents,
  getTokenStatus: mockGetTokenStatus,
}));

jest.unstable_mockModule("./alerts/alert-bus.js", () => ({
  notify: mockNotify,
}));

const { refreshAgent } = await import("./token-refresh.js");

interface TokenStatus {
  agentId: string;
  lastRefreshOkAt: string | null;
  expiresAt: string | null;
  lastFailure: { at: string; status: number; retriable: boolean; reason: string } | null;
  state: "healthy" | "stale" | "expired" | "failing" | "unconfigured";
}

interface AgentConfig {
  name: string;
  linearUserId: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "igor",
    linearUserId: "user-igor",
    clientId: "cid",
    clientSecret: "secret",
    accessToken: "old-access",
    refreshToken: "refresh-tok",
    ...overrides,
  };
}

/** Build a fetch-like Response stub. */
function resp(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const TOKEN_OK = {
  access_token: "new-access-token-abcdef…",
  refresh_token: "new-refresh",
  expires_in: 86400,
  token_type: "Bearer",
};

// No-op sleep + deterministic rng so tests never actually wait on backoff.
const noSleep = async (): Promise<void> => {};
const fixedRng = (): number => 0.5;

function makeTokenStatus(overrides: Partial<TokenStatus> = {}): TokenStatus {
  return {
    agentId: "igor",
    lastRefreshOkAt: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-18T12:00:00.000Z",
    lastFailure: null,
    state: "healthy",
    ...overrides,
  };
}

beforeEach(() => {
  mockUpdateTokens.mockClear();
  mockRecordTokenFailure.mockClear();
  mockGetAgents.mockClear();
  mockGetTokenStatus.mockClear();
  mockNotify.mockClear();
  // Default: token status reflects an agent with a valid recent refresh
  mockGetTokenStatus.mockReturnValue(makeTokenStatus());
});

describe("token-refresh retry-with-backoff (AI-1911)", () => {
  it("AC2: a transient 503 then 200 succeeds without external intervention", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(resp(503, "upstream unavailable"))
      .mockResolvedValueOnce(resp(200, TOKEN_OK));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(fetchImpl).toHaveBeenCalledTimes(2); // retried once
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled(); // recovered → no alert
    // 503 was recorded as failure; success cleared it
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 503, true, expect.stringContaining("503"));
  });

  it("AC1: refresh failure triggers at least one automatic retry with backoff", async () => {
    mockGetAgents.mockReturnValue([]);
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(503, "still down"));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await refreshAgent(makeAgent(), { fetchImpl, sleep, rng: fixedRng });

    // 3 attempts total → 2 backoff sleeps between them.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Backoff grows (exponential): second wait > first wait.
    const firstWait = sleep.mock.calls[0][0];
    const secondWait = sleep.mock.calls[1][0];
    expect(firstWait).toBeGreaterThan(0);
    expect(secondWait).toBeGreaterThan(firstWait);
    // Each attempt recorded its failure (3 from refreshAgentOnce + 1 from exhausted path)
    expect(mockRecordTokenFailure).toHaveBeenCalledTimes(4);
  });

  it("AC3: all retries exhausted logs a critical alert (real expiry risk)", async () => {
    mockGetAgents.mockReturnValue([]);
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(503, "down"));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(mockUpdateTokens).not.toHaveBeenCalled();
    expect(mockRecordTokenFailure).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { severity: string; agent: string; source: string };
    expect(alert.severity).toBe("critical");
    expect(alert.agent).toBe("igor");
    expect(alert.source).toBe("token-refresh");
  });

  it("succeeds first try → no retry, no alert", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(200, TOKEN_OK));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mockUpdateTokens).toHaveBeenCalledTimes(1);
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("non-retriable 4xx (revoked token) fails fast without retrying", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ state: "stale" }));
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(400, "invalid_grant"));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry on hard failure
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 400, false, expect.stringContaining("400"));
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { severity: string; title: string };
    expect(alert.severity).toBe("critical");
    // AC: alert identifies the credential state
    expect(alert.title).toMatch(/\(state: stale\)/);
  });

  it("429 rate-limit is treated as transient and retried", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(resp(429, "rate limited"))
      .mockResolvedValueOnce(resp(200, TOKEN_OK));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 429, true, expect.stringContaining("429"));
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("a thrown network error is retried then recovers", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(resp(200, TOKEN_OK));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 0, true, expect.stringContaining("ECONNRESET"));
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // ── AC: credential-alert (AI-2559) ────────────────────────────────────────

  it("AC1: invalid_grant alert identifies the token state", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ state: "stale", expiresAt: "2026-07-18T12:00:00.000Z" }));
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(400, "invalid_grant"));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { title: string };
    // Alert must identify the token state: stale (token TTL remains but refresh failed)
    expect(alert.title).toMatch(/\(state: stale\)/);
  });

  it("AC2: invalid_grant alert identifies access-token expiry deadline", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ state: "stale", expiresAt: "2026-07-18T12:00:00.000Z" }));
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(400, "invalid_grant"));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { title: string };
    // Alert must include the access-token expiry deadline as a timestamp
    expect(alert.title).toMatch(/2026-07-18/);
    expect(alert.title).toMatch(/expires at|deadline|expiry/);
  });

  it("AC3: invalid_grant alert fires within one refresh cycle (not on /health read)", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ state: "stale", expiresAt: "2026-07-18T12:00:00.000Z" }));
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(400, "invalid_grant"));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    // The alert fires inline during refreshAgent execution — not deferred to
    // a /health poll. If notify was called within the retry loop, we pass.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBeDefined();
  });

  it("AC4: exhausted retries alert identifies token state", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ state: "expired", expiresAt: "2026-07-15T12:00:00.000Z" }));
    mockGetAgents.mockReturnValue([
      { name: "igor", expiresAt: "2026-07-15T12:00:00.000Z" }, // already expired
    ]);
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(503, "still down"));

    await refreshAgent(makeAgent(), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { title: string };
    // Token is expired AND refresh failing
    expect(alert.title).toMatch(/\(state: expired\)/);
  });

  it("AC5: alert identifies agent name", async () => {
    mockGetTokenStatus.mockReturnValue(makeTokenStatus({ agentId: "scout", state: "stale" }));
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(resp(400, "invalid_grant"));

    await refreshAgent(makeAgent({ name: "scout" }), { fetchImpl, sleep: noSleep, rng: fixedRng });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { agent: string; title: string };
    // AC: alert identifies the agent — both via dedicated field AND in title
    expect(alert.agent).toBe("scout");
    expect(alert.title).toMatch(/scout/);
  });
});
