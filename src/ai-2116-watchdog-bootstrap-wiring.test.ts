/**
 * AI-2116 AC8/AC9 — Bootstrap wiring and /health liveness for the dispatch
 * watchdog retry-hardening and precondition-guard features.
 *
 * FAILING tests (TDD write-tests state). RED until the new DispatchWatchdog
 * options are wired through createApp() and surfaced at /health.
 *
 * AC mapping:
 *   AC8 — The dispatch watchdog component's hardening/precondition features are
 *         registered at server bootstrap (reachable from the production entry
 *         point, proven by static wiring assertion + runtime /health field).
 *   AC9 — Liveness is observable at ac-validate without waiting for the
 *         component's trigger condition: a /health field, startup log line, or
 *         registry entry showing the component is scheduled/subscribed.
 *
 * Follows the AI-2009 bootstrap-wiring test pattern (static assertion on index.ts
 * + runtime assertion via createApp + /health).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
roles:
  - id: steward
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [{ name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" }],
    }),
    "utf8",
  );
  return file;
}

function writePolicy(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, TEST_POLICY_YAML, "utf8");
  return file;
}

// ════════════════════════════════════════════════════════════════════════════
// AC8 (static) — dispatch watchdog retry/precondition wiring in index.ts
// ════════════════════════════════════════════════════════════════════════════

describe("AC8 static: dispatch watchdog hardening is wired in index.ts", () => {
  it("DispatchWatchdog constructor receives exponentialBackoffMs option", () => {
    // The `createApp` call in index.ts must pass the backoff configuration to
    // the DispatchWatchdog constructor. Without this, the watchdog uses the
    // default fixed-interval cycle.
    expect(INDEX_TS.includes("exponentialBackoffMs")).toBe(true);
  });

  it("DispatchWatchdog constructor receives linearResolveCheck dependency", () => {
    // The resolve-check guard must be wired at the production entry point.
    // A linearResolveCheck function must be passed to the watchdog so it can
    // verify ticket existence before re-dispatching.
    expect(INDEX_TS.includes("linearResolveCheck")).toBe(true);
  });

  it("DispatchWatchdog constructor receives delegateCheck dependency", () => {
    // The delegate-match guard must be wired at the production entry point.
    expect(INDEX_TS.includes("delegateCheck")).toBe(true);
  });

  it("DispatchWatchdog constructor receives workflowStateCheck dependency", () => {
    // The workflow-state precondition must be wired at the production entry point.
    expect(INDEX_TS.includes("workflowStateCheck")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC8 (runtime) + AC9 — /health exposes watchdog liveness
// ════════════════════════════════════════════════════════════════════════════

describe("AC8 runtime + AC9: dispatch watchdog liveness at /health", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2116-boot-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicy(dir);
    process.env.ADMIN_SECRET = "ai-2116-test";
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.ADMIN_SECRET;
  });

  it("/health exposes a dispatchWatchdog liveness field showing scheduled state", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    // Must have a top-level field (like firstActionWatchdog, rescueSweep, etc.)
    // showing the conventional component liveness pattern.
    expect(body.dispatchWatchdog).toBeDefined();
    const live = body.dispatchWatchdog as Record<string, unknown>;
    // scheduled: the watchdog setInterval is active
    expect(typeof live.scheduled).toBe("boolean");
    expect(live.scheduled).toBe(true);
    // config: shows the configured backoff and guards so ac-validate can confirm
    // the hardening features are armed without waiting for a re-dispatch cycle.
    expect(live.config).toBeDefined();
    const config = live.config as Record<string, unknown>;
    expect(typeof config.exponentialBackoffMs).toBe("number");
    expect(config.exponentialBackoffMs).toBeGreaterThan(0);
    expect(typeof config.maxResignals).toBe("number");
    expect(config.maxResignals).toBeGreaterThan(0);
    // Precondition guards must show as active
    expect(config.preconditionGuards).toBeDefined();
    const guards = config.preconditionGuards as Record<string, boolean>;
    expect(guards.resolveCheck).toBe(true);
    expect(guards.delegateMatch).toBe(true);
    expect(guards.workflowState).toBe(true);
  });

  it("watchdog liveness field includes cycle statistics", async () => {
    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    const live = body.dispatchWatchdog as Record<string, unknown>;

    // Must expose accumulators so the dashboard can show watchdog health:
    // total cycles run, last cycle result, error count
    expect(typeof live.totalCycles).toBe("number");
    expect(live.totalCycles).toBeGreaterThanOrEqual(0);
  });
});
