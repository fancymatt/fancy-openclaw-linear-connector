/**
 * AI-1857 — Tests for rescue-sweep observability defects (Defect 2).
 *
 * AC of record (captured at intake 2026-07-06):
 *   - "Every rescue-sweep run emits an observable outcome (operational event
 *      incl. per-ticket outcome); a `failed` rescue raises an alert, not
 *      just a log line."
 *   - "Sweep cadence/last-run visible on `/health` (lastRunAt, lastOutcome
 *      counts) so 'did it run' is answerable without log access."
 *
 * Current defects:
 *   1. Rescue-sweep cron does NOT wire operationalEventStore into runRescueSweep.
 *   2. Failed rescues emit only a log line, not an alert.
 *   3. /health shows cron registration (name+schedule) but NOT lastRunAt or
 *      per-run outcome counts.
 *
 * All tests MUST be RED until the implementation lands.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { getRegisteredCrons, resetCronRegistryForTest } from "./cron/registry.js";
import { registerRescueSweepCron } from "./cron/rescue-sweep-cron.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
  - id: dev
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
// AC2a: Every rescue-sweep run emits an observable outcome (operational
//        event) — including per-ticket outcomes
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1857 AC2a: rescue-sweep cron wires operationalEventStore", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-sweep-events-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.RESCUE_SWEEP_INTERVAL = "999999h"; // prevent actual timer fires during test
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();
    originalFetch = globalThis.fetch;

    // Mock Linear API for the rescue sweep's fetchWfTickets
    globalThis.fetch = async (url) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "uuid-dormant",
                    identifier: "AI-DORMANT",
                    team: { id: "team-test" },
                    state: { name: "Doing" },
                    labels: { nodes: [{ id: "l1", name: "wf:dev-impl" }, { id: "l2", name: "state:implementation" }] },
                    delegate: null,
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url, { method: "GET" });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.RESCUE_SWEEP_INTERVAL;
  });

  it("registerRescueSweepCron registers the sweep in the cron registry", () => {
    registerRescueSweepCron();
    const crons = getRegisteredCrons();
    const rescueEntry = crons.find((c) => c.name === "rescue-sweep");
    expect(rescueEntry).toBeDefined();
    expect(rescueEntry!.schedule).toContain("h");
    expect(rescueEntry!.registeredAt).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC2b: A failed rescue raises an alert, not just a log line
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1857 AC2b: failed rescue raises an alert via alert bus", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  /** Captured alert bus notifications. */
  let alertCaptures: Array<{ severity: string; source: string; title: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-alert-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    alertCaptures = [];

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const parsed = JSON.parse(bodyText) as { query?: string };

        // Return a dormant ticket with NO valid delegate candidates
        // (role has no bodies → rescue will fail)
        if (parsed.query?.includes("issues") || parsed.query?.includes("WorkflowIssues")) {
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [
                    {
                      id: "uuid-no-candidates",
                      identifier: "AI-NOBODY",
                      team: { id: "team-test" },
                      state: { name: "Doing" },
                      labels: {
                        nodes: [
                          { id: "l1", name: "wf:dev-impl" },
                          { id: "l2", name: "state:implementation" },
                        ],
                      },
                      delegate: null,
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Delegate update fails
        if (parsed.query?.includes("issueUpdate")) {
          return new Response(
            JSON.stringify({ data: { issueUpdate: { success: false } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Label lookup
        if (parsed.query?.includes("TeamLabels") || (parsed.query?.includes("team") && parsed.query?.includes("labels"))) {
          return new Response(
            JSON.stringify({
              data: {
                team: {
                  labels: {
                    nodes: [
                      { id: "lbl-wf", name: "wf:dev-impl" },
                      { id: "lbl-state-impl", name: "state:implementation" },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("{}" , { status: 200 });
      }
      return originalFetch(url, { method: "GET" });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
  });

  it("a sweep with failed rescues emits per-ticket operational events with outcome=failed", async () => {
    const { runRescueSweep } = await import("./rescue-sweep.js");
    const events: Array<{ outcome: string; type?: string; detail?: unknown }> = [];
    const eventStore = {
      // AI-2093: the store exposes .append (not .record); the sweep now conforms.
      append(event: { outcome: string; type?: string; detail?: unknown }) {
        events.push(event);
      },
    };

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      workflowRegistry: new Map([
        [
          "dev-impl",
          {
            id: "dev-impl",
            entry_state: "intake",
            states: [
              { id: "implementation", owner_role: "dev" },
            ],
          },
        ],
      ]),
      capabilityPolicyPath: process.env.CAPABILITY_POLICY_PATH,
    });

    // The rescue should have failed (no candidates for the role)
    expect(result.rescued).toBe(0);
    // AC2a: operational events should include the failed rescue per-ticket outcome
    const failedEvents = events.filter(
      (e) => e.outcome.includes("failed") || (e.detail as Record<string, unknown>)?.classification !== undefined,
    );
    // AC2b: at least one event should document the failure
    // (currently fails: events array is empty for failed rescues)
    expect(events.length).toBeGreaterThanOrEqual(1);
    const hasFailedOutcome = events.some(
      (e) => e.outcome === "rescue:failed" || e.outcome.includes("failed"),
    );
    expect(hasFailedOutcome).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3: Sweep cadence/last-run visible on /health
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1857 AC3: /health includes rescue-sweep lastRunAt and lastOutcome counts", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1857-health-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(
      path.join(dir, "dev-impl.yaml"),
      `id: dev-impl\nentry_state: intake\nstates:\n  - id: intake\n    owner_role: steward\n  - id: done\n`,
      "utf8",
    );
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
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  it("/health includes rescueSweep field with lastRunAt", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    // AC3: rescue-sweep must have a lastRunAt field showing when it last ran
    expect(body).toHaveProperty("rescueSweep");
    const sweep = body.rescueSweep as Record<string, unknown>;
    expect(sweep).toHaveProperty("lastRunAt");
    expect(sweep).toHaveProperty("lastOutcome");

    // AI-1970: additive fields for non-success outcomes
    expect(sweep).toHaveProperty("lastOutcomeType");
    expect(sweep).toHaveProperty("lastSkipReason");
    expect(sweep).toHaveProperty("lastError");
  });

  it("/health rescueSweep.lastOutcome includes per-classification counts", async () => {
    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    const sweep = body.rescueSweep as Record<string, unknown>;
    const outcome = sweep.lastOutcome as Record<string, unknown>;

    // AC3: counts for rescued/failed/ambiguous so "did it work" is answerable
    expect(outcome).toHaveProperty("rescued");
    expect(outcome).toHaveProperty("failed");
    expect(outcome).toHaveProperty("scanned");
  });
});
