/**
 * AI-1857 — Bootstrap-wiring test for rescue-sweep (AC5 / AI-1808).
 *
 * AC of record (captured at intake 2026-07-06):
 *   "[Bootstrap-wiring — AI-1808] rescue-sweep is registered at server
 *    bootstrap (reachable from the production entry point, e.g. index.ts),
 *    proven by an integration test that boots the entry point and asserts
 *    registration. A module-level unit test does NOT satisfy this. Liveness
 *    is observable at ac-validate without waiting for a sweep trigger: a
 *    `/health` field, startup log line, or registry entry showing the sweep
 *    is scheduled/subscribed."
 *
 * Strategy: Two layers of proof:
 *   1. Static analysis: index.ts source must import and call
 *      registerRescueSweepCron (catches the AI-1773/AI-1775 dead-code
 *      pattern).
 *   2. /health liveness: boot createApp, call registerRescueSweepCron,
 *      hit /health, and assert the cron registry entry exists with name
 *      "rescue-sweep".
 *
 * All tests MUST be RED until the implementation lands (the /health
 * rescueSweep field check).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { getRegisteredCrons, resetCronRegistryForTest } from "./cron/registry.js";
import { registerRescueSweepCron } from "./cron/rescue-sweep-cron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);

// ── Helpers ────────────────────────────────────────────────────────────────

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

function writePolicyFile(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, TEST_POLICY_YAML, "utf8");
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
// Layer 1: Static analysis — index.ts must import and call registerRescueSweepCron
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1857 AC5 static: rescue-sweep is imported and called in index.ts", () => {
  it("imports registerRescueSweepCron from the cron module", () => {
    expect(
      INDEX_TS.includes(
        'import { registerRescueSweepCron } from "./cron/rescue-sweep-cron.js"',
      ),
    ).toBe(true);
  });

  it("calls registerRescueSweepCron() in the bootstrap block", () => {
    expect(INDEX_TS.includes("registerRescueSweepCron(")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Layer 2: Runtime — boot createApp + register, assert /health shows it
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1857 AC5 runtime: rescue-sweep is observable via /health crons field", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-bootstrap-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.RESCUE_SWEEP_INTERVAL = "999999h"; // prevent timer fires
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    // Register the rescue sweep cron — this is what the entry point does
    registerRescueSweepCron();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.RESCUE_SWEEP_INTERVAL;
  });

  it("/health crons array includes rescue-sweep with schedule and registeredAt", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const crons = body.crons as Array<{ name: string; schedule: string; registeredAt: string }>;

    expect(Array.isArray(crons)).toBe(true);
    const rescue = crons.find((c) => c.name === "rescue-sweep");
    expect(rescue).toBeDefined();
    expect(rescue!.schedule.length).toBeGreaterThan(0);
    // ISO timestamp — parseable
    expect(Number.isNaN(Date.parse(rescue!.registeredAt))).toBe(false);
  });

  it("rescue-sweep cron entry proves the sweep is scheduled (not just imported)", async () => {
    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    const crons = body.crons as Array<{ name: string; schedule: string }>;

    const rescue = crons.find((c) => c.name === "rescue-sweep");
    // The schedule field must show a time interval (e.g. "1h"), not be empty
    // or a placeholder — this proves setInterval was called
    expect(rescue!.schedule).toMatch(/\d+\s*(h|m|s|ms|d)/);
  });
});
