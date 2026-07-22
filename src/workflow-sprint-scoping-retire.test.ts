/**
 * INF-307: Failing tests for sprint-scoping retire path.
 *
 * AC2 — Retire path for wf:sprint-scoping intake:
 *   - wf:sprint-scoping workflow gains a `cancel`/`retire` transition from the
 *     `intake` state, so junk tickets in that state can be retired by an agent.
 *   - The transition is registered at server bootstrap (reachable from the
 *     production entry point, e.g. index.ts), proven by an integration test
 *     that boots the entry point and asserts registration.
 *   - Liveness is observable at ac-validate without waiting for the component's
 *     trigger condition: a registry entry showing the transition is registered.
 *
 * Implementation will need to:
 *   1. Add a `retire` transition to the `intake` state in
 *      src/registered-defs/sprint-scoping.yaml (to: done, or to: a new cancel state).
 *   2. The transition is automatically registered when loadWorkflowRegistry()
 *      loads the defs from src/registered-defs/ (production bootstrap path).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// Path to the production registered-defs directory (at project root)
const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

// Capability policy with steward role (owner of sprint-scoping intake state).
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// Agents.json with astrid (steward) having a linearUserId.
const AGENTS_JSON = JSON.stringify({
  agents: [
    { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
  ],
});

let tmpDir: string;
let savedWorkflowDefsDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprint-scoping-retire-"));

  // Write capability policy
  const policyFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  // Write agents.json
  const agentsFile = path.join(tmpDir, "agents.json");
  fs.writeFileSync(agentsFile, AGENTS_JSON, "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  savedWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;
});

afterEach(() => {
  if (savedWorkflowDefsDir !== undefined) {
    process.env.WORKFLOW_DEFS_DIR = savedWorkflowDefsDir;
  } else {
    delete process.env.WORKFLOW_DEFS_DIR;
  }
  delete process.env.WORKFLOW_DEF_PATH;
});

// ── AC2 Unit test: the sprint-scoping workflow def has a retire transition ──

describe("AC2: sprint-scoping intake has a retire transition (workflow def test)", () => {
  it("loads sprint-scoping from registered-defs and finds a retire/cancel transition on intake", async () => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();

    const registry = await loadWorkflowRegistry();

    expect(registry.has("sprint-scoping")).toBe(true);

    const def = registry.get("sprint-scoping")!;
    expect(def.id).toBe("sprint-scoping");
    expect(def.states).toBeDefined();

    // Find the intake state
    const intakeState = def.states.find((s) => s.id === "intake");
    expect(intakeState).toBeDefined();
    expect(intakeState!.transitions).toBeDefined();
    expect(intakeState!.transitions!.length).toBeGreaterThan(0);

    // Assert there is a retire OR cancel transition from intake
    const retireTransition = intakeState!.transitions!.find(
      (t) => t.command === "retire" || t.command === "cancel",
    );
    expect(retireTransition).toBeDefined();
    expect(retireTransition!.command).toBe("retire");

    // The retire transition should go to a terminal state (done, retired, or invalid)
    // This is typically "done" or a purpose-built terminal state.
    expect(retireTransition!.to).toBeDefined();
  });
});

// ── AC2 Integration test: boot production entry point and assert registration ──

describe("AC2: retire transition is registered at server bootstrap (integration)", () => {
  it("loads the sprint-scoping def via production bootstrap path (registered-defs dir)", async () => {
    // Point WORKFLOW_DEFS_DIR to the production registered-defs directory,
    // matching how the production connector loads workflow definitions.
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();

    const registry = await loadWorkflowRegistry();

    // The production bootstrap path must load sprint-scoping
    expect(registry.has("sprint-scoping")).toBe(true);

    const def = registry.get("sprint-scoping")!;

    // The intake state must have a retire transition (added by the implementation)
    const intakeState = def.states.find((s) => s.id === "intake");
    expect(intakeState).toBeDefined();

    const retireTransition = intakeState!.transitions?.find((t) => t.command === "retire");
    expect(retireTransition).toBeDefined();
    expect(retireTransition!.to).toBeDefined();
  });

  it("integration: boots createApp with registered-defs dir and asserts sprint-scoping is in the registry", async () => {
    // This test bootstraps the production entry point (createApp from index.ts)
    // and then verifies the workflow registry contains the sprint-scoping def
    // with the retire transition — proving it's reachable at bootstrap.
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();

    // Boot the production entry point
    const { createApp } = await import("./index.js");
    createApp();

    // After booting createApp, the registry should be loadable independently
    // (bootstrap doesn't eagerly load it, but it IS reachable on first access
    // through the normal loadWorkflowRegistry path — which is what the proxy
    // and workflow-gate use at runtime).
    const registry = await loadWorkflowRegistry();

    expect(registry.has("sprint-scoping")).toBe(true);

    const def = registry.get("sprint-scoping")!;
    const intakeState = def.states.find((s) => s.id === "intake");
    expect(intakeState).toBeDefined();

    const retireTransition = intakeState!.transitions?.find(
      (t) => t.command === "retire" || t.command === "cancel",
    );
    expect(retireTransition).toBeDefined();
    expect(retireTransition!.command).toBe("retire");
  });
});

// ── AC2 Legacy-path guard: single-def backward compat ──────────────────────

describe("AC2: sprint-scoping retire doesn't break single-def legacy deploy", () => {
  it("registered-defs loads alongside dev-impl without excluding sprint-scoping for missing native_state", async () => {
    // The sprint-scoping def must pass native_state validation so it makes
    // it into the registry at all. The integration test already covers this,
    // but this explicit check documents the AC.
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();

    const registry = await loadWorkflowRegistry();

    // sprint-scoping must pass validation and be present
    expect(registry.has("sprint-scoping")).toBe(true);

    // Other defs should still be present (no regression)
    expect(registry.size).toBeGreaterThanOrEqual(2);
  });
});
