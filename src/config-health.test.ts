/**
 * Tests for config-health.ts — Phase 6.5 / H-1 (§16.0).
 *
 * Tests the config health tracking module:
 *   - Recording success/failure per artifact
 *   - Overall health status (healthy only when ALL artifacts healthy)
 *   - Alert callbacks when health transitions
 *   - Consecutive failure tracking
 */

import {
  recordSuccess,
  recordFailure,
  isHealthy,
  getStatus,
  onAlert,
  resetConfigHealth,
  type ConfigHealthStatus,
} from "./config-health.js";

describe("config-health", () => {
  beforeEach(() => {
    resetConfigHealth();
  });

  it("starts healthy with all artifacts healthy", () => {
    expect(isHealthy()).toBe(true);
    const status = getStatus();
    expect(status.healthy).toBe(true);
    expect(status.artifacts["workflow-def"].healthy).toBe(true);
    expect(status.artifacts["capability-policy"].healthy).toBe(true);
    expect(status.artifacts["agents"].healthy).toBe(true);
  });

  it("becomes unhealthy when any artifact fails", () => {
    recordFailure("workflow-def", "file not found");
    expect(isHealthy()).toBe(false);
    const status = getStatus();
    expect(status.artifacts["workflow-def"].healthy).toBe(false);
    expect(status.artifacts["workflow-def"].lastError).toBe("file not found");
    expect(status.artifacts["workflow-def"].consecutiveFailures).toBe(1);
    // Other artifacts still healthy
    expect(status.artifacts["capability-policy"].healthy).toBe(true);
    expect(status.artifacts["agents"].healthy).toBe(true);
  });

  it("recovers when a failed artifact succeeds", () => {
    recordFailure("workflow-def", "file not found");
    expect(isHealthy()).toBe(false);
    recordSuccess("workflow-def");
    expect(isHealthy()).toBe(true);
    const status = getStatus();
    expect(status.artifacts["workflow-def"].healthy).toBe(true);
    expect(status.artifacts["workflow-def"].consecutiveFailures).toBe(0);
  });

  it("fires alert callback on healthy → unhealthy transition", () => {
    const alerts: ConfigHealthStatus[] = [];
    onAlert((status) => alerts.push(status));

    recordFailure("capability-policy", "YAML parse error");

    expect(alerts.length).toBe(1);
    expect(alerts[0].healthy).toBe(false);
    expect(alerts[0].artifacts["capability-policy"].lastError).toBe("YAML parse error");
  });

  it("does not fire alert on subsequent failures of same artifact", () => {
    const alerts: ConfigHealthStatus[] = [];
    onAlert((status) => alerts.push(status));

    recordFailure("capability-policy", "error 1");
    recordFailure("capability-policy", "error 2");
    recordFailure("capability-policy", "error 3");
    recordFailure("capability-policy", "error 4");

    // Only 1 alert: on first failure (subsequent failures don't re-alert)
    expect(alerts.length).toBe(1);
  });

  it("re-alerts on every 5th consecutive failure", () => {
    const alerts: ConfigHealthStatus[] = [];
    onAlert((status) => alerts.push(status));

    recordFailure("capability-policy", "error 1");  // 1st → alert
    recordFailure("capability-policy", "error 2");  // 2nd
    recordFailure("capability-policy", "error 3");  // 3rd
    recordFailure("capability-policy", "error 4");  // 4th
    recordFailure("capability-policy", "error 5");  // 5th → re-alert

    expect(alerts.length).toBe(2);
  });

  it("unsubscribe callback stops receiving alerts", () => {
    const alerts: ConfigHealthStatus[] = [];
    const unsub = onAlert((status) => alerts.push(status));

    recordFailure("capability-policy", "first");
    expect(alerts.length).toBe(1);

    unsub();

    recordSuccess("capability-policy");
    recordFailure("capability-policy", "second");
    expect(alerts.length).toBe(1); // No new alerts after unsubscribe
  });

  it("tracks lastSuccess and lastFailure timestamps", () => {
    recordSuccess("agents");

    const status = getStatus();
    expect(status.artifacts["agents"].lastSuccess).not.toBeNull();
    expect(status.artifacts["agents"].lastFailure).toBeNull();

    recordFailure("agents", "disk error");
    const status2 = getStatus();
    expect(status2.artifacts["agents"].lastFailure).not.toBeNull();
    expect(status2.artifacts["agents"].consecutiveFailures).toBe(1);
  });

  it("requires ALL artifacts to be healthy for overall health", () => {
    recordSuccess("workflow-def");
    recordSuccess("capability-policy");
    recordSuccess("agents");
    expect(isHealthy()).toBe(true);

    recordFailure("agents", "oops");
    expect(isHealthy()).toBe(false);

    recordSuccess("agents");
    expect(isHealthy()).toBe(true);

    recordFailure("capability-policy", "bad yaml");
    expect(isHealthy()).toBe(false);
  });
});
