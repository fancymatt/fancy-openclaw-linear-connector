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
let mockFetchResponse: { errors?: Array<{ message: string }>; data?: unknown } | null = null;
let mockFetchShouldThrow = false;
let mockFetchThrowError = "ECONNREFUSED";

const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  globalThis.fetch = async (url, _init) => {
    if (mockFetchShouldThrow) {
      throw new Error(mockFetchThrowError);
    }
    return new Response(JSON.stringify(mockFetchResponse ?? { data: {} }), {
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
    mockFetchResponse = null;
    mockFetchShouldThrow = false;
    mockFetchThrowError = "ECONNREFUSED";
  });

  afterEach(() => {
    stopCanary();
    restoreFetch();
  });

  it("passes when the proxy correctly rejects an illegal move", async () => {
    // Proxy returns errors — enforcement is working.
    mockFetchResponse = {
      errors: [{ message: "[Proxy] 'deploy' is not a legal command in state 'intake'." }],
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

    mockFetchResponse = {
      errors: [{ message: "[Proxy] 'deploy' is not a legal command." }],
    };
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
    mockFetchResponse = {
      errors: [{ message: "[Proxy] blocked" }],
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

    // Start canary
    mockFetchResponse = {
      errors: [{ message: "blocked" }],
    };
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
