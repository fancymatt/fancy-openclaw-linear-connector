/**
 * Failing tests for INF-97: sprint-spawner pre-flight readiness gate.
 *
 * AC-to-test mapping:
 *   AC1: Pre-flight runs automatically at spawner start and blocks fan-out
 *        on failure, emitting a single actionable readiness report.
 *   AC2: Five minimum health checks:
 *        (a) Workflow def registry matches canonical fixtures (no drift)
 *        (b) All fleet heartbeats healthy (no 0m/disabled)
 *        (c) Done-gate GitHub verification live
 *        (d) Target repo clean (no stale .worktrees gitlink / phantom-red)
 *        (e) Required delegate agents reachable (token not revoked/expired)
 *   AC3: Failed pre-flight produces named-owner remediation list.
 *   AC4: Break-glass override path exists (human launches anyway with
 *        explicit acknowledgment logged).
 *   AC5: Component registered at server bootstrap (AI-1808 integration).
 *        → Covered by inf-97-spawner-preflight-bootstrap.test.ts
 *   AC6: Liveness observable at /health without trigger condition.
 *        → Covered by inf-97-spawner-preflight-bootstrap.test.ts
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";

// ═══════════════════════════════════════════════════════════════════════════════
// The below import references a module that does NOT exist yet.
// This test file will fail to compile/load until `src/spawner-preflight.ts` is
// created and exports the required symbols — this IS the failing-first test.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  runPreFlight,
  getPreFlightLiveness,
  resetPreFlightStatus,
  type PreFlightResult,
  type PreFlightCheck,
  type PreFlightStatus,
} from "./spawner-preflight.js";

// ── Test helpers ───────────────────────────────────────────────────────────

const MOCK_AGENTS = [
  { name: "igor", linearUserId: "user-igor", openclawAgent: "igor", host: "local" as const },
  { name: "sage", linearUserId: "user-sage", openclawAgent: "sage", host: "local" as const },
  { name: "ai", linearUserId: "user-ai", openclawAgent: "ai", host: "local" as const },
  { name: "hanzo", linearUserId: "user-hanzo", openclawAgent: "hanzo", host: "local" as const },
];

function healthyFixture() {
  return {
    workflowDefDrift: { ok: true, detail: "All 10 workflow defs match canonical fixtures" },
    fleetHeartbeats: { ok: true, detail: "All 8 agents have heartbeats within 5m threshold" },
    doneGateVerification: { ok: true, detail: "Done-gate GitHub verify endpoint responded 200" },
    targetRepoClean: { ok: true, detail: "Target repo has no stale .worktrees or phantom CI reds" },
    delegateAgentsReachable: { ok: true, detail: "All 3 required delegates have valid tokens" },
  };
}

function failedFixture(): Record<string, { ok: false; detail: string; owner: string }> {
  return {
    workflowDefDrift: { ok: false, detail: "8/10 workflow defs drifted from canonical", owner: "Kana" },
    fleetHeartbeats: { ok: false, detail: "Igor 0m heartbeat, Hanzo disabled", owner: "Astrid" },
    doneGateVerification: { ok: false, detail: "Done-gate verify endpoint not responding", owner: "Hanzo" },
    delegateAgentsReachable: { ok: false, detail: "Felix token expired (revoked 2026-07-17)", owner: "Astrid" },
  };
}

// ── AC1: Pre-flight runs at spawner start and blocks fan-out ───────────────

describe("AC1: pre-flight runs at spawner start and blocks fan-out on failure", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-97-ac1-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns { ok: true } when all checks pass", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    // FAILING: spawner-preflight.ts does not exist — this test cannot compile yet
    expect(result.ok).toBe(true);
    expect(result.blockFanOut).toBe(false);
    expect(result.report).toBeDefined();
  });

  it("returns { ok: false } and blocks fan-out when any check fails", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    // FAILING: same reason — module does not exist
    expect(result.ok).toBe(false);
    expect(result.blockFanOut).toBe(true);
  });

  it("emits a single actionable readiness report regardless of outcome", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    expect(result.report).toBeDefined();
    expect(typeof result.report.timestamp).toBe("string");
    expect(Array.isArray(result.report.checks)).toBe(true);
    expect(result.report.checks.length).toBeGreaterThanOrEqual(5);
  });
});

// ── AC2: Five minimum health checks ────────────────────────────────────────

describe("AC2a: workflow def registry matches canonical fixtures (no drift)", () => {
  it("passes when all deployed defs match their canonical fixtures", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "workflowDefDrift");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
  });

  it("fails with detail when defs have drifted from fixtures", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "workflowDefDrift");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.detail).toContain("drifted");
  });
});

describe("AC2b: all fleet heartbeats healthy (no 0m/disabled)", () => {
  it("passes when every agent heartbeat is within threshold", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "fleetHeartbeats");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
  });

  it("fails when any agent has 0m heartbeat or heartbeat is disabled", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "fleetHeartbeats");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/0m|disabled/i);
  });
});

describe("AC2c: done-gate GitHub verification live", () => {
  it("passes when the done-gate verify endpoint responds", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "doneGateVerification");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
  });

  it("fails when the done-gate verify endpoint is unreachable", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "doneGateVerification");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
  });
});

describe("AC2d: target repo clean (no stale .worktrees / phantom-red state)", () => {
  it("passes when target repo has no stale worktrees or phantom CI reds", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "targetRepoClean");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
  });

  it("fails when stale .worktrees or phantom CI reds are present", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: {
      ...healthyFixture(),
      targetRepoClean: { ok: false, detail: "Found 2 stale .worktrees (ai-2475, ai-2500); last CI run on main is RED", owner: "Kana" },
    }});
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "targetRepoClean");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/\.worktrees/i);
  });
});

describe("AC2e: required delegate agents reachable (token not revoked/expired)", () => {
  it("passes when all delegates have valid tokens", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "delegateAgentsReachable");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
  });

  it("fails when any delegate token is expired or revoked", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const check = result.report.checks.find((c: PreFlightCheck) => c.name === "delegateAgentsReachable");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/expired|revoked|token/i);
  });
});

// ── AC3: Failed pre-flight produces named-owner remediation list ──────────

describe("AC3: failed pre-flight produces named-owner remediation list", () => {
  it("includes a remediation list with named owners when checks fail", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    expect(result.report.remediation).toBeDefined();
    expect(Array.isArray(result.report.remediation)).toBe(true);
    expect(result.report.remediation.length).toBeGreaterThan(0);
    const firstItem = result.report.remediation[0];
    expect(firstItem.check).toBeDefined();
    expect(firstItem.owner).toBeDefined();
    expect(firstItem.remediation).toBeDefined();
  });

  it("every failed check has a named owner in remediation", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const failedChecks = result.report.checks.filter((c: PreFlightCheck) => !c.ok);
    const ownedItems = result.report.remediation.filter((r: { owner: string }) => r.owner);
    expect(ownedItems.length).toBe(failedChecks.length);
    failedChecks.forEach((check: PreFlightCheck) => {
      const match = result.report.remediation.find((r: { check: string }) => r.check === check.name);
      expect(match).toBeDefined();
      expect(match!.owner).toBeTruthy();
    });
  });

  it("remediation list is empty when all checks pass", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: healthyFixture() });
    expect(Array.isArray(result.report.remediation)).toBe(true);
    expect(result.report.remediation.length).toBe(0);
  });
});

// ── AC4: Break-glass override path ─────────────────────────────────────────

describe("AC4: break-glass override path (human launches anyway)", () => {
  it("pre-flight returns an override token when fan-out is blocked", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    // FAILING: module does not exist — the override token is an escape hatch
    expect(result.blockFanOut).toBe(true);
    expect(result.overrideToken).toBeDefined();
    expect(typeof result.overrideToken).toBe("string");
  });

  it("override token logs explicit human acknowledgment when used", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const overrideResult = await runPreFlight({
      checks: failedFixture(),
      overrideToken: result.overrideToken,
      overrideActor: "Matt (sprint-owner)",
    });
    // With a valid override token, the gate allows fan-out despite failures
    expect(overrideResult.ok).toBe(true);
    expect(overrideResult.blockFanOut).toBe(false);
    expect(overrideResult.overrideAcknowledgedAt).toBeDefined();
    expect(overrideResult.overrideActor).toBe("Matt (sprint-owner)");
  });

  it("invalid override token is rejected (fan-out still blocked)", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({
      checks: failedFixture(),
      overrideToken: "invalid-token",
      overrideActor: "Unauthorized User",
    });
    expect(result.blockFanOut).toBe(true);
  });

  it("override token is single-use (consumed after first approval)", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const token = result.overrideToken;

    // First use — should pass
    const firstUse = await runPreFlight({
      checks: failedFixture(),
      overrideToken: token,
      overrideActor: "Matt (sprint-owner)",
    });
    expect(firstUse.blockFanOut).toBe(false);

    // Second use with same token — should fail (already consumed)
    const secondUse = await runPreFlight({
      checks: failedFixture(),
      overrideToken: token,
      overrideActor: "Matt (sprint-owner)",
    });
    expect(secondUse.blockFanOut).toBe(true);
  });

  it("override logs the acknowledgment in the readiness report", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    const overrideResult = await runPreFlight({
      checks: failedFixture(),
      overrideToken: result.overrideToken,
      overrideActor: "Astrid (CPO)",
    });
    expect(overrideResult.report.overrideLogged).toBe(true);
    expect(overrideResult.report.overrideActor).toBe("Astrid (CPO)");
    expect(overrideResult.report.overrideAcknowledgedAt).toBeDefined();
  });

  it("pre-flight without override token reports fail-closed", async () => {
    resetPreFlightStatus();
    const result = await runPreFlight({ checks: failedFixture() });
    expect(result.blockFanOut).toBe(true);
    expect(result.overrideAcknowledgedAt).toBeUndefined();
  });
});

// ── AC5 + AC6 covered by inf-97-spawner-preflight-bootstrap.test.ts ──────

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("throws on empty checks object", async () => {
    resetPreFlightStatus();
    await expect(runPreFlight({ checks: {} })).rejects.toThrow();
  });

  it("handles a mix of pass and fail gracefully", async () => {
    resetPreFlightStatus();
    const mixed = {
      ...healthyFixture(),
      workflowDefDrift: { ok: false, detail: "dev-impl fixture out of sync", owner: "Kana" },
    };
    const result = await runPreFlight({ checks: mixed });
    expect(result.ok).toBe(false);
    expect(result.blockFanOut).toBe(true);
    expect(result.report.checks.length).toBe(5);
  });

  it("getPreFlightLiveness returns last result and status when available", async () => {
    resetPreFlightStatus();
    await runPreFlight({ checks: healthyFixture() });
    const liveness = getPreFlightLiveness();
    expect(liveness).toBeDefined();
    expect(typeof liveness.lastRunAt).toBe("string");
    expect(liveness.healthy).toBe(true);
  });

  it("resetPreFlightStatus clears cached state", async () => {
    resetPreFlightStatus();
    await runPreFlight({ checks: healthyFixture() });
    expect(getPreFlightLiveness().healthy).toBe(true);
    resetPreFlightStatus();
    expect(getPreFlightLiveness().healthy).toBeNull();
  });
});
