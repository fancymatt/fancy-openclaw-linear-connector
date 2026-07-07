/**
 * AI-1914 — AC6: bootstrap wiring + load-time liveness (standard AI-1808 criterion).
 *
 * The def-load migration runner (AC1) must be REGISTERED at server bootstrap —
 * reachable from the production entry point (src/index.ts) — and its liveness
 * must be observable at ac-validate without waiting for a def change: a /health
 * field showing the migration check ran on load, including a migrated-ticket
 * count (0 allowed).
 *
 * Two guards, mirroring the AI-1775 pattern:
 *   1. A source-level wiring assertion on index.ts (a module-level unit test does
 *      NOT satisfy AC6 — the runner must actually be called from the entry point).
 *   2. An integration test that boots createApp() and asserts /health exposes the
 *      migration liveness field.
 *
 * Contract (implementer conforms): index.ts imports and calls
 * `registerDefStateMigrationRunner` from "./def-state-migration.js"; /health
 * exposes `workflowMigrations` with a numeric `migratedCount`.
 *
 * RED until the runner is wired and the /health field is added.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

// ── AC6 part 1: wiring is present in the entry point ──────────────────────────

describe("AC6: def-state migration runner is wired in index.ts", () => {
  it("imports registerDefStateMigrationRunner from the migration module", () => {
    expect(
      INDEX_TS.includes(
        'import { registerDefStateMigrationRunner } from "./def-state-migration.js"',
      ) || /registerDefStateMigrationRunner\s*}\s*from\s*"\.\/def-state-migration\.js"/.test(INDEX_TS),
    ).toBe(true);
  });

  it("calls registerDefStateMigrationRunner from the entry point", () => {
    expect(INDEX_TS.includes("registerDefStateMigrationRunner(")).toBe(true);
  });
});

// ── AC6 part 2: /health exposes migration liveness (0 allowed) ────────────────

describe("AC6: /health exposes workflow-migration liveness after boot", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>["app"];
  let appState: ReturnType<typeof createApp>;
  let savedFetch: typeof globalThis.fetch;

  const DEF_YAML = `
id: dev-impl
version: 14
entry_state: intake
migrations:
  deployment: ac-validate
break_glass:
  command: escape
  to: escape
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: ac-validate
    owner_role: steward
    native_state: doing
    transitions:
      - command: validated
        to: done
  - id: done
    native_state: done
    transitions: []
  - id: escape
    native_state: invalid
    transitions: []
`;

  const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
roles:
  - id: steward
    requires: [workflow:break-glass]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1914-wiring-"));

    fs.writeFileSync(path.join(dir, "dev-impl.yaml"), DEF_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    delete process.env.WORKFLOW_DEFS_DIR;

    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");

    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({ agents: [{ name: "ai", linearUserId: "user-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" }] }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_API_KEY = "test-key";
    process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ai1914";
    process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ai1914";

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();

    savedFetch = globalThis.fetch;
    // The boot-time migration sweep enumerates wf:* tickets — return none so the
    // check runs cleanly and reports a migrated count of 0.
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return savedFetch(url as never, init);
    }) as typeof globalThis.fetch;

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    app = appState.app;
  });

  afterAll(() => {
    globalThis.fetch = savedFetch;
    try {
      appState.bag.close();
      appState.sessionTracker.close();
      appState.agentQueue.close();
      appState.operationalEventStore.close();
      appState.watchdog.stop();
      appState.noActivityDetector.stop();
      appState.managingPoller.stop();
    } catch { /* best-effort teardown */ }
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_CONNECTOR_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  it("createApp() boots (entry point reachable)", () => {
    expect(app).toBeDefined();
  });

  it("/health responds 200 ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/health exposes a 'workflowMigrations' liveness field (AC6: check ran on load)", async () => {
    const res = await request(app).get("/health");
    expect(res.body).toHaveProperty("workflowMigrations");
  });

  it("/health workflowMigrations reports a numeric migrated-ticket count (0 allowed)", async () => {
    const res = await request(app).get("/health");
    const wm = res.body.workflowMigrations as { migratedCount?: unknown } | undefined;
    expect(wm).toBeDefined();
    expect(typeof wm!.migratedCount).toBe("number");
    expect(wm!.migratedCount as number).toBeGreaterThanOrEqual(0);
  });
});
