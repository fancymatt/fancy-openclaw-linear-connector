/**
 * Tests for G-20 scheduled gate-silently-off canary (AI-1552, §5.1).
 *
 * AC1: scheduled canary fires a known-illegal command against a canary ticket.
 * AC2: alerts if the command is NOT rejected.
 * AC3: drill — deliberately disable the gate → canary alerts.
 *
 * Each test group maps to exactly one AC so review and ac-validate can trace coverage.
 */

import {
  runG20Canary,
  type G20CanaryConfig,
  type G20CanaryResult,
} from "./g20-canary-job.js";

// ── Fetch mock ─────────────────────────────────────────────────────────────

type MockResponse = {
  status: number;
  body: Record<string, unknown>;
};

let mockResponse: MockResponse = { status: 200, body: {} };
let capturedRequests: Array<{ url: string; init: RequestInit }> = [];

const originalFetch = globalThis.fetch;

function installMockFetch() {
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    capturedRequests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(mockResponse.body), {
      status: mockResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ── Alert capture ──────────────────────────────────────────────────────────

let capturedAlerts: G20CanaryResult[] = [];

function captureAlert(result: G20CanaryResult) {
  capturedAlerts.push(result);
}

// ── Baseline config ────────────────────────────────────────────────────────

const BASE_CONFIG: G20CanaryConfig = {
  proxyUrl: "http://localhost:3456",
  authToken: "canary-token",
  agentId: "canary-agent",
  canaryTicketId: "AI-CANARY",
  illegalIntent: "deploy",
  onAlert: captureAlert,
};

// ── Suite ──────────────────────────────────────────────────────────────────

describe("G20 scheduled canary", () => {
  beforeEach(() => {
    capturedRequests = [];
    capturedAlerts = [];
    mockResponse = { status: 200, body: {} };
    installMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  // ── AC1: scheduled canary fires a known-illegal command against a canary ticket ──

  describe("AC1 — fires illegal command at canary ticket", () => {
    it("sends a request to the proxy graphql endpoint", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [{ message: "illegal move" }] },
      };

      await runG20Canary(BASE_CONFIG);

      expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
      expect(capturedRequests[0].url).toContain("/proxy/graphql");
    });

    it("sets the X-Openclaw-Linear-Intent header to the illegal intent", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [{ message: "illegal move" }] },
      };

      await runG20Canary(BASE_CONFIG);

      const headers = capturedRequests[0].init.headers as Record<string, string>;
      expect(headers["X-Openclaw-Linear-Intent"]).toBe("deploy");
    });

    it("includes the canary ticket ID in the request body", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [{ message: "illegal move" }] },
      };

      await runG20Canary(BASE_CONFIG);

      const body = JSON.parse(capturedRequests[0].init.body as string) as {
        variables?: { id?: string };
      };
      expect(body.variables?.id).toBe("AI-CANARY");
    });

    it("sets the Authorization header with the configured auth token", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [{ message: "illegal move" }] },
      };

      await runG20Canary(BASE_CONFIG);

      const headers = capturedRequests[0].init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("canary-token");
    });

    it("sets the X-Openclaw-Agent header to the canary agent ID", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [{ message: "illegal move" }] },
      };

      await runG20Canary(BASE_CONFIG);

      const headers = capturedRequests[0].init.headers as Record<string, string>;
      expect(headers["X-Openclaw-Agent"]).toBe("canary-agent");
    });

    it("defaults illegalIntent to 'deploy' when not configured", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [{ message: "illegal move" }] },
      };

      const config: G20CanaryConfig = { ...BASE_CONFIG };
      delete (config as Partial<G20CanaryConfig>).illegalIntent;

      await runG20Canary(config);

      const headers = capturedRequests[0].init.headers as Record<string, string>;
      expect(headers["X-Openclaw-Linear-Intent"]).toBe("deploy");
    });
  });

  // ── AC2: alerts if the command is NOT rejected ─────────────────────────────

  describe("AC2 — alerts when enforcement silently allows illegal move", () => {
    it("returns passed=true when the proxy rejects the illegal move (errors in response)", async () => {
      mockResponse = {
        status: 200,
        body: {
          errors: [{ message: "[Proxy] 'deploy' is not a legal command in state 'intake'." }],
        },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(true);
      expect(capturedAlerts.length).toBe(0);
    });

    it("returns passed=false and fires alert when the proxy does NOT reject (no errors)", async () => {
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(false);
      expect(capturedAlerts.length).toBe(1);
    });

    it("alert includes the canary ticket ID in the error message", async () => {
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      await runG20Canary(BASE_CONFIG);

      expect(capturedAlerts[0].error).toContain("AI-CANARY");
    });

    it("alert includes the illegal intent in the error message", async () => {
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      await runG20Canary(BASE_CONFIG);

      expect(capturedAlerts[0].error).toContain("deploy");
    });

    it("alert result includes a timestamp", async () => {
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe("string");
      expect(result.timestamp.length).toBeGreaterThan(0);
    });

    it("returns passed=false and fires alert when response has an empty errors array", async () => {
      mockResponse = {
        status: 200,
        body: { errors: [], data: { issueUpdate: { success: true } } },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(false);
      expect(capturedAlerts.length).toBe(1);
    });

    it("returns passed=false when proxy returns HTTP 200 with no errors field", async () => {
      mockResponse = {
        status: 200,
        body: { data: null },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(false);
    });

    it("does not fire alert when proxy rejects via non-empty errors array", async () => {
      mockResponse = {
        status: 200,
        body: {
          errors: [
            { message: "[Proxy] enforcement blocked: illegal command 'deploy' in state 'intake'" },
          ],
        },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(true);
      expect(capturedAlerts.length).toBe(0);
    });
  });

  // ── AC3: drill — deliberately disable the gate → canary alerts ─────────────

  describe("AC3 — drill: disabled gate triggers canary alert", () => {
    it("detects gate-off when proxy accepts a known-illegal command (drill scenario)", async () => {
      // Simulates the AI-1361 pattern: gate returned null/allow because config-path issue
      // made it fail-open. Proxy responds with success, no errors — gate is off.
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(false);
      expect(result.error).toContain("enforcement");
    });

    it("fires exactly one alert per run when gate is off", async () => {
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      await runG20Canary(BASE_CONFIG);

      expect(capturedAlerts.length).toBe(1);
    });

    it("alert clearly identifies the failure as an enforcement failure (not a network error)", async () => {
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      await runG20Canary(BASE_CONFIG);

      const alert = capturedAlerts[0];
      expect(alert.error).toMatch(/enforcement|silently|gate|illegal/i);
      expect(alert.passed).toBe(false);
    });

    it("drill recovers: canary passes again when gate is re-enabled (errors returned)", async () => {
      // Round 1: gate off
      mockResponse = {
        status: 200,
        body: { data: { issueUpdate: { success: true } } },
      };

      const result1 = await runG20Canary(BASE_CONFIG);
      expect(result1.passed).toBe(false);
      expect(capturedAlerts.length).toBe(1);

      // Round 2: gate re-enabled
      capturedAlerts = [];
      mockResponse = {
        status: 200,
        body: {
          errors: [{ message: "[Proxy] enforcement: 'deploy' blocked in state 'intake'." }],
        },
      };

      const result2 = await runG20Canary(BASE_CONFIG);
      expect(result2.passed).toBe(true);
      expect(capturedAlerts.length).toBe(0);
    });

    it("network error during drill does not falsely pass — returns passed=false", async () => {
      globalThis.fetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      const result = await runG20Canary(BASE_CONFIG);

      expect(result.passed).toBe(false);
    });

    it("network error fires alert with fetch-error context, not enforcement-failure context", async () => {
      globalThis.fetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      await runG20Canary(BASE_CONFIG);

      const alert = capturedAlerts[0];
      expect(alert).toBeDefined();
      expect(alert.error).toContain("ECONNREFUSED");
    });
  });
});
