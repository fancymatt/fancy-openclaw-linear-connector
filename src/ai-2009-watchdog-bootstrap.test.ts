/**
 * AI-2009 — Bootstrap wiring, /health liveness, and /admin ladder visibility
 * for the first-action watchdog. FAILING tests (TDD write-tests state).
 *
 * These cover the ACs that can only be proven by booting the production app
 * factory (createApp — the entry point index.ts uses) rather than a module-level
 * unit test:
 *
 *   AC6  The watchdog is registered at server bootstrap (reachable from the
 *        production entry point). Proven two ways, mirroring the accepted
 *        AI-1857 rescue-sweep-bootstrap pattern:
 *          (1) static: index.ts imports AND calls registerFirstActionWatchdogCron
 *              in the bootstrap block (catches the AI-1773/AI-1775 dead-code gap);
 *          (2) runtime: booting createApp + calling the registrar makes the
 *              watchdog appear in /health.crons — i.e. setInterval really ran.
 *   AC7  Watchdog liveness is observable at ac-validate without a breach: a
 *        /health field showing the watchdog is scheduled and armed.
 *   AC5  (admin half) Ladder state is visible in /admin per ticket.
 *
 * The watchdog module does not exist yet, so its symbols are pulled in via
 * dynamic import INSIDE the runtime tests. That keeps the static-source tests
 * failing on a clean assertion (index.ts lacks the wiring) rather than on a
 * module-resolution error, so the implementer gets a precise signal per AC.
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
import { getRegisteredCrons, resetCronRegistryForTest } from "./cron/registry.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

const CRON_NAME = "first-action-watchdog";
const ADMIN_SECRET = "ai-2009-admin-test";

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
// AC6 (1) — static: index.ts wires the watchdog registrar in the bootstrap block
// ════════════════════════════════════════════════════════════════════════════

describe("AC6 static: first-action watchdog is imported and called in index.ts", () => {
  it("imports registerFirstActionWatchdogCron from the watchdog module", () => {
    expect(
      INDEX_TS.includes('import { registerFirstActionWatchdogCron } from "./first-action-watchdog.js"'),
    ).toBe(true);
  });

  it("calls registerFirstActionWatchdogCron() in the bootstrap (isEntryPoint) block", () => {
    expect(INDEX_TS.includes("registerFirstActionWatchdogCron(")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC6 (2) — runtime: registrar produces a live /health.crons entry
// AC7      — /health exposes watchdog liveness (scheduled + armed)
// ════════════════════════════════════════════════════════════════════════════

describe("AC6/AC7 runtime: watchdog is observable via /health after bootstrap", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2009-boot-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicy(dir);
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

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
  });

  it("registerFirstActionWatchdogCron() adds a first-action-watchdog cron registry entry", async () => {
    const mod = await import("./first-action-watchdog.js");
    mod.registerFirstActionWatchdogCron({
      authToken: "Bearer test",
      workflowDefPath: path.join(dir, "defs"),
      listTickets: async () => [],
      notify: () => undefined,
      redispatch: async () => ({ admitted: true }),
      cadenceMs: 999_999 * 1000, // do not actually fire during the test
    } as never);

    // Registry (feeds /health.crons) must show the driver — proves setInterval ran,
    // not just that the module was imported.
    const cron = getRegisteredCrons().find((c) => c.name === CRON_NAME);
    expect(cron).toBeDefined();
    expect(cron!.schedule).toMatch(/\d+\s*(h|m|s|ms|d)/);

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    const crons = (res.body as { crons: Array<{ name: string }> }).crons;
    expect(crons.some((c) => c.name === CRON_NAME)).toBe(true);
  });

  it("/health exposes a firstActionWatchdog liveness field (scheduled/armed) without a breach", async () => {
    const state = await import("./first-action-watchdog-state.js");
    state.resetFirstActionWatchdogStateForTest();

    const mod = await import("./first-action-watchdog.js");
    mod.registerFirstActionWatchdogCron({
      authToken: "Bearer test",
      workflowDefPath: path.join(dir, "defs"),
      listTickets: async () => [],
      notify: () => undefined,
      redispatch: async () => ({ admitted: true }),
      cadenceMs: 999_999 * 1000,
    } as never);

    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    // Mirrors the rescueSweep liveness key: a dedicated top-level field.
    expect(body.firstActionWatchdog).toBeDefined();
    const live = body.firstActionWatchdog as Record<string, unknown>;
    // Scheduled/armed is observable at ac-validate without waiting for a deadline.
    expect(typeof live.scheduled).toBe("boolean");
    expect(live.scheduled).toBe(true);
    expect(typeof live.armedCount).toBe("number");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 (admin half) — ladder state visible in /admin per ticket
// ════════════════════════════════════════════════════════════════════════════

describe("AC5 admin: per-ticket first-action ladder state is exposed on the board API", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let mirror: EnrolledTicketsStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2009-admin-"));
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.WORKFLOW_DEFS_DIR = path.resolve(__dirname, "__fixtures__");
    resetWorkflowCache();
    app = createApp({
      enrolledTicketsDbPath: path.join(dir, "mirror.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    } as never);
    mirror = (app as unknown as { enrolledTicketsStore?: EnrolledTicketsStore }).enrolledTicketsStore!;
    expect(mirror).toBeDefined();
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("board ticket carries a first_action_ladder field reflecting the watchdog state", async () => {
    const state = await import("./first-action-watchdog-state.js");
    state.resetFirstActionWatchdogStateForTest();

    mirror.enroll({ ticketId: "AI-5001", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });

    // Simulate the watchdog having armed + fired a rung for this ticket by running
    // a sweep whose data plane returns exactly this ticket, past its deadline.
    // AI-2091 §4: the arming rule now clamps a cold ladder forward to `now` when
    // the delivery predates the sweep by more than the restart-safety horizon
    // (MAX_ARM_LOOKBACK_MS = 2h), so a delivered-at 25h stale no longer breaches
    // on the first sweep. Keep the delivery inside that horizon but past the 30m
    // deadline so this ticket still legitimately breaches and exposes a rung.
    const wd = await import("./first-action-watchdog.js");
    const sweepNow = Date.now() + 1_000 * 60 * 60 * 24;
    await wd.runFirstActionWatchdogSweep({
      authToken: "Bearer test",
      workflowDefPath: path.resolve(__dirname, "__fixtures__"),
      now: () => sweepNow,
      defaultDeadlineMs: 30 * 60_000,
      maxRungs: 3,
      capabilityPolicy: { bodies: [], containers: [], roles: [] },
      notify: () => undefined,
      redispatch: async () => ({ admitted: true }),
      listTickets: async () => [
        {
          ticket: "AI-5001",
          workflow: "dev-impl",
          state: "write-tests",
          delegate: "tdd",
          humanAssigned: false,
          labels: ["wf:dev-impl", "state:write-tests"],
          // 1h before the sweep: inside the 2h arm horizon, past the 30m deadline.
          dispatchDeliveredAtMs: sweepNow - 1_000 * 60 * 60,
          dispatchUpdatedAt: new Date().toISOString(),
          firstOwnerActionAtMs: null,
        },
      ],
    } as never);

    const res = await request(app.app).get("/admin/api/board").set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const ticket = (res.body.tickets as Array<{ ticket_id: string; first_action_ladder?: unknown }>)
      .find((t) => t.ticket_id === "AI-5001");
    expect(ticket).toBeDefined();
    // The ladder state (rungs fired / armed / unreachable) must be readable per ticket.
    expect(ticket!.first_action_ladder).toBeDefined();
    const ladder = ticket!.first_action_ladder as Record<string, unknown>;
    expect(typeof ladder.rungsFired).toBe("number");
    expect(ladder.rungsFired as number).toBeGreaterThanOrEqual(1);
  });
});
