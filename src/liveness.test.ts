/**
 * Unit tests for liveness check module (AI-1428).
 */

import { jest } from "@jest/globals";
import { checkAgentLiveness, type LivenessConfig } from "./liveness.js";

// Minimal fetch mock — global fetch is available in Node 18+.
const originalFetch = globalThis.fetch;

function mockFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis.fetch as any) = jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: response.json ?? (() => Promise.resolve({ ok: true })),
    text: response.text ?? (() => Promise.resolve("")),
  });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe("checkAgentLiveness", () => {
  afterEach(() => {
    restoreFetch();
    jest.restoreAllMocks();
  });

  it("returns available=true when hooks mode returns 2xx with ok:true", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token" };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(true);
  });

  it("returns available=false with reason=error when hooks returns ok:false", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.resolve({ ok: false, error: "no models" }) });
    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token" };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("error");
      expect(result.detail).toContain("ok=false");
    }
  });

  it("returns available=false with reason=unreachable when hooks returns 500", async () => {
    mockFetch({ ok: false, status: 500, text: () => Promise.resolve("Internal Server Error") });
    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token" };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("unreachable");
    }
  });

  it("returns available=true when hooks returns a non-auth 4xx (gateway responded)", async () => {
    mockFetch({ ok: false, status: 400, text: () => Promise.resolve('{"ok":false,"error":"message required"}') });
    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token" };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(true);
  });

  it("returns available=false with reason=error when hooks returns 403 (auth failure)", async () => {
    mockFetch({ ok: false, status: 403, text: () => Promise.resolve("Forbidden") });
    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token" };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("error");
    }
  });

  it("returns available=false with reason=timeout when fetch aborts", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.fetch as any) = jest.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
      // Simulate abort
      const error = new DOMException("The operation was aborted", "AbortError");
      // Trigger abort immediately
      if (opts?.signal) {
        // Can't really abort synchronously in jest, so just throw
      }
      return Promise.reject(error);
    });

    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token", timeoutMs: 1 };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("timeout");
    }
  });

  it("returns available=false with reason=error when fetch throws non-abort", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.fetch as any) = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const config: LivenessConfig = { hooksUrl: "http://localhost:3100/test", hooksToken: "test-token" };
    const result = await checkAgentLiveness("igor", config);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("error");
    }
  });

  describe("CLI mode (no hooksUrl)", () => {
    it("returns available=true when LINEAR_OAUTH_TOKEN is set", async () => {
      process.env.LINEAR_OAUTH_TOKEN = "test-token";
      try {
        const result = await checkAgentLiveness("igor", {});
        expect(result.available).toBe(true);
      } finally {
        delete process.env.LINEAR_OAUTH_TOKEN;
      }
    });

    it("returns available=false when no Linear token in environment", async () => {
      // Ensure no token env vars
      const saved: Record<string, string | undefined> = {};
      for (const key of ["LINEAR_OAUTH_TOKEN", "LINEAR_API_KEY", "LINEAR_DEVELOPER_TOKEN"]) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      try {
        const result = await checkAgentLiveness("igor", {});
        expect(result.available).toBe(false);
        if (!result.available) {
          expect(result.reason).toBe("error");
        }
      } finally {
        for (const [key, val] of Object.entries(saved)) {
          if (val !== undefined) process.env[key] = val;
        }
      }
    });
  });
});
