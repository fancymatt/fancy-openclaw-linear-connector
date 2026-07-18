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
const mockNotify = jest.fn<(alert: unknown) => void>();

jest.unstable_mockModule("./agents.js", () => ({
  // isAgentLocal is called before any network work; make every test agent local.
  isAgentLocal: jest.fn().mockReturnValue(true),
  // isPolledForLinear: all test agents are polled by default.
  isPolledForLinear: jest.fn().mockReturnValue(true),
  updateTokens: mockUpdateTokens,
  recordTokenFailure: mockRecordTokenFailure,
  getAgents: mockGetAgents,
}));

jest.unstable_mockModule("./alerts/alert-bus.js", () => ({
  notify: mockNotify,
}));

const { refreshAgent } = await import("./token-refresh.js");

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

let _originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  mockUpdateTokens.mockClear();
  mockRecordTokenFailure.mockClear();
  mockGetAgents.mockClear();
  mockNotify.mockClear();
});

// Restore global fetch after each test so it doesn't bleed into other suites
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

describe("token-refresh retry-with-backoff (AI-1911)", () => {
  /**
   * INF-51 (2026-07-17): refreshAgent was refactored — it no longer accepts a
   * second options argument with fetchImpl/sleep/rng injection. The function
   * uses globalThis.fetch directly with internal retry logic. These tests use
   * globalThis.fetch mock to exercise the live retry path.
   *
   * TODO(AI-1911): re-evaluate retry coverage — the INF-51 retry mechanism
   * differs from the original and may need dedicated tests for full coverage.
   */

  it("AC2: a transient 503 then 200 succeeds", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(resp(503, "upstream unavailable"))
      .mockResolvedValueOnce(resp(200, TOKEN_OK));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await refreshAgent(makeAgent());

    expect(fetchMock).toHaveBeenCalled();
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 503, true, expect.stringContaining("503"));
  });

  it("AC3: all retries exhausted logs a critical alert", async () => {
    mockGetAgents.mockReturnValue([]);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(resp(503, "down"));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await refreshAgent(makeAgent());

    expect(mockUpdateTokens).not.toHaveBeenCalled();
    expect(mockRecordTokenFailure).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { severity: string; agent: string; source: string };
    expect(alert.severity).toBe("critical");
    expect(alert.agent).toBe("igor");
    expect(alert.source).toBe("token-refresh");
  });

  it("succeeds first try → no retry, no alert", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(resp(200, TOKEN_OK));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await refreshAgent(makeAgent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockUpdateTokens).toHaveBeenCalledTimes(1);
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("non-retriable 4xx (revoked token) fails fast", async () => {
    mockGetAgents.mockReturnValue([]);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(resp(400, "invalid_grant"));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await refreshAgent(makeAgent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 400, false, expect.stringContaining("400"));
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const alert = mockNotify.mock.calls[0][0] as { severity: string };
    expect(alert.severity).toBe("critical");
  });

  it("a thrown network error is retried then recovers", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(resp(200, TOKEN_OK));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await refreshAgent(makeAgent());

    expect(fetchMock).toHaveBeenCalled();
    expect(mockRecordTokenFailure).toHaveBeenCalledWith("igor", 0, true, expect.stringContaining("ECONNRESET"));
    expect(mockUpdateTokens).toHaveBeenCalledWith("igor", TOKEN_OK.access_token, TOKEN_OK.refresh_token, TOKEN_OK.expires_in);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
