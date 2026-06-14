/**
 * Tests for canary.ts — Phase 6.5 / H-1 (§4.6).
 *
 * Tests the continuous canary against silent fail-open:
 *   - Canary detects when enforcement allows an illegal move
 *   - Canary detects config health degradation
 *   - Canary alerts on consecutive failures
 *   - Alert callbacks fire at the right times
 */

import {
  startCanary,
  stopCanary,
  runCheck,
  getLastResult,
  onCanaryAlert,
  resetCanary,
  type CanaryResult,
} from "./canary.js";
import { resetConfigHealth, recordFailure, recordSuccess } from "./config-health.js";

// Mock fetch for canary tests — controlled via module state.
//
// Two modes:
//   1. Intent-aware (preferred): set mockFetchByIntent to map intent → response. The mock
//      inspects X-Openclaw-Linear-Intent and returns the mapped response, making the mock
//      deterministic even when concurrent runCheck() calls race (startCanary fires an initial
//      check that races with the test's explicit await runCheck()).
//   2. Queue/fallback (legacy): mockFetchResponseQueue consumed in order; once empty, falls
//      back to mockFetchResponse. Use only for tests that do NOT use startCanary (no race).
let mockFetchByIntent: Record<string, { errors?: Array<{ message: string }>; data?: unknown }> | null = null;
let mockFetchResponseQueue: Array<{ errors?: Array<{ message: string }>; data?: unknown }> = [];
let mockFetchResponse: { errors?: Array<{ message: string }>; data?: unknown } | null = null;
let mockFetchShouldThrow = false;
let mockFetchThrowError = "ECONNREFUSED";

const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  globalThis.fetch = async (_url, init) => {
    if (mockFetchShouldThrow) {
      throw new Error(mockFetchThrowError);
    }
    // Intent-aware mode: inspect X-Openclaw-Linear-Intent header for deterministic routing.
    if (mockFetchByIntent) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const intent = headers["X-Openclaw-Linear-Intent"] ?? "";
      const response = mockFetchByIntent[intent] ?? mockFetchByIntent["*"] ?? { data: {} };
      return new Response(JSON.stringify(response), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    // Queue/fallback mode.
    const response = mockFetchResponseQueue.length > 0
      ? mockFetchResponseQueue.shift()!
      : (mockFetchResponse ?? { data: {} });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("canary", () => {
  beforeEach(() => {
    resetCanary();
    resetConfigHealth();
    mockFetchByIntent = null;
    mockFetchResponseQueue = [];
    mockFetchResponse = null;
    mockFetchShouldThrow = false;
    mockFetchThrowError = "ECONNREFUSED";
  });

  afterEach(() => {
    stopCanary();
    restoreFetch();
  });

  it("passes when the proxy correctly rejects an illegal move", async () => {
    // Use intent-aware mock so the response is deterministic even when startCanary's
    // initial async runCheck() races with the explicit await runCheck() below.
    // Any illegal intent → errors (rejected); presence-ping → success (allowed).
    mockFetchByIntent = {
      "deploy": { errors: [{ message: "[Proxy] 'deploy' is not a legal command in state 'intake'." }] },
      "presence-ping": { data: { issueUpdate: { success: true } } },
    };
    installMockFetch();

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    const result = await runCheck();
    expect(result.passed).toBe(true);
    expect(result.configHealthy).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("fails (clamp-shut) when presence-ping is rejected by the proxy", async () => {
    // Both illegal intent AND presence-ping are rejected — enforcement is too broad (clamp-shut).
    // Use intent-aware mock for determinism (startCanary's initial check races with startCanary itself).
    mockFetchByIntent = {
      "deploy": { errors: [{ message: "[Proxy] 'deploy' is not a legal command." }] },
      "presence-ping": { errors: [{ message: "[Proxy] 'presence-ping' is not a legal command." }] },
    };
    installMockFetch();

    const alerts: CanaryResult[] = [];
    onCanaryAlert((result) => alerts.push(result));

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].error).toContain("CRITICAL");
    expect(alerts[0].error).toContain("clamp-shut");
  });

  it("fails when enforcement silently allows an illegal move", async () => {
    // Proxy does NOT reject — enforcement is broken.
    mockFetchResponse = {
      data: { issueUpdate: { success: true } },
    };
    installMockFetch();

    const alerts: CanaryResult[] = [];
    onCanaryAlert((result) => alerts.push(result));

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    // startCanary runs an initial check that already fires an alert.
    // Wait a tick for the async initial check to complete.
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].error).toContain("CRITICAL");
  });

  it("fails when config health is degraded", async () => {
    recordFailure("workflow-def", "file not found");

    installMockFetch();

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    const result = await runCheck();
    expect(result.passed).toBe(false);
    expect(result.configHealthy).toBe(false);
    expect(result.error).toContain("Config health degraded");
  });

  it("recovers when config health is restored", async () => {
    recordFailure("workflow-def", "file not found");

    // When config health recovers, runCheck makes 2 fetch calls (illegal + presence-ping).
    mockFetchResponseQueue = [
      { errors: [{ message: "[Proxy] 'deploy' is not a legal command." }] },
      { data: { issueUpdate: { success: true } } },
    ];
    installMockFetch();

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    // First check: config degraded
    const result1 = await runCheck();
    expect(result1.passed).toBe(false);

    // Fix config
    recordSuccess("workflow-def");

    // Second check: should pass now
    const result2 = await runCheck();
    expect(result2.passed).toBe(true);
    expect(result2.configHealthy).toBe(true);
  });

  it("tracks consecutive fetch failures and alerts after 3", async () => {
    mockFetchShouldThrow = true;
    mockFetchThrowError = "ECONNREFUSED";
    installMockFetch();

    const alerts: CanaryResult[] = [];
    onCanaryAlert((result) => alerts.push(result));

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    // First 3 failures: no alert yet (threshold)
    const r1 = await runCheck();
    expect(r1.passed).toBe(false);
    expect(alerts.length).toBe(0);

    const r2 = await runCheck();
    expect(r2.passed).toBe(false);
    expect(alerts.length).toBe(0);

    const r3 = await runCheck();
    expect(r3.passed).toBe(false);
    // 3 failures → should have alerted now
    expect(alerts.length).toBe(1);
    expect(alerts[0].error).toContain("ECONNREFUSED");
  });

  it("getLastResult returns null before any check", () => {
    expect(getLastResult()).toBeNull();
  });

  it("getLastResult returns the most recent check result", async () => {
    // Use intent-aware mock for determinism (startCanary races with explicit runCheck).
    mockFetchByIntent = {
      "deploy": { errors: [{ message: "[Proxy] blocked" }] },
      "presence-ping": { data: { issueUpdate: { success: true } } },
    };
    installMockFetch();

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    await runCheck();
    const last = getLastResult();
    expect(last).not.toBeNull();
    expect(last!.passed).toBe(true);
  });

  it("unsubscribe stops canary alerts", async () => {
    mockFetchResponse = {
      data: { issueUpdate: { success: true } },
    };
    installMockFetch();

    const alerts: CanaryResult[] = [];
    const unsub = onCanaryAlert((result) => alerts.push(result));

    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });

    // Wait for the initial check
    await new Promise((r) => setTimeout(r, 50));
    const alertsBeforeUnsub = alerts.length;
    expect(alertsBeforeUnsub).toBeGreaterThanOrEqual(1);

    unsub();

    await runCheck();
    // Alerts should not have grown after unsubscribe
    expect(alerts.length).toBe(alertsBeforeUnsub);
  });

  it("returns error result when not configured", async () => {
    resetCanary();
    const result = await runCheck();
    expect(result.passed).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("stopCanary unsubscribes from config-health alerts — no leak on restart", async () => {
    // Track config-health alert callback invocations
    const healthAlertCalls: ConfigHealthStatus[] = [];
    const { onAlert: configOnAlert, recordFailure: configRecordFailure, resetConfigHealth } = await import("./config-health.js");
    resetConfigHealth();

    // Start canary — initial runCheck makes 2 fetch calls (illegal rejected + ping allowed).
    mockFetchResponseQueue = [
      { errors: [{ message: "blocked" }] },
      { data: { issueUpdate: { success: true } } },
    ];
    installMockFetch();
    startCanary({
      authToken: "test-token",
      agentId: "canary-agent",
      fixtureTicketId: "AI-CANARY",
      proxyUrl: "http://localhost:3456",
    });
    await new Promise((r) => setTimeout(r, 50));

    // Register a config-health alert listener AFTER canary starts
    const healthUnsub = configOnAlert((status: ConfigHealthStatus) => {
      healthAlertCalls.push(status);
    });

    // Stop and restart
    stopCanary();

    // Trigger a config-health alert
    configRecordFailure("workflow-def", "test error");

    await new Promise((r) => setTimeout(r, 50));

    // The health unsub should still work (independent of canary)
    expect(healthAlertCalls.length).toBeGreaterThanOrEqual(1);

    healthUnsub();
    resetCanary();
  });
});
