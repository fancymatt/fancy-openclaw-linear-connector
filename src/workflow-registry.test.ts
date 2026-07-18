/**
 * AI-1530: Tests for multi-def workflow registry.
 *
 * Covers all 7 acceptance criteria:
 *   AC1 — registry loads all *.yaml defs from WORKFLOW_DEFS_DIR, keyed by def.id
 *   AC2 — native_state validation runs per-def; a bad def is surfaced and excluded, good defs load
 *   AC3 — gate dispatches by wf:<id> label from registry; unknown wf: stays pass-through
 *   AC4 — dev-impl enforcement unchanged (regression)
 *   AC5 — resetWorkflowCache() clears the whole registry
 *   AC6 — backwards-compat: only WORKFLOW_DEF_PATH set → single-def registry, no breakage
 *   AC7 — (registry load, dispatch, pass-through, per-def validation, dev-impl regression)
 *         covered by the suites below
 *
 * `loadWorkflowRegistry` is accessed via namespace import so a missing export
 * fails at assertion time (individual test) rather than at module load (which
 * would silently break the pre-existing workflow-gate tests too).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import * as WorkflowGate from "./workflow-gate.js";
import {
  checkWorkflowRules,
  resetWorkflowCache,
  validateNativeStateMappings,
  resetNativeStateCache,
  WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";

// Fixture paths (same constants used in workflow-gate.test.ts)
const CANONICAL_DEV_IMPL = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
const CANONICAL_UX_AUDIT = path.resolve(process.cwd(), "src/__fixtures__/canonical-ux-audit.yaml");
const CANONICAL_SPRINT = path.resolve(process.cwd(), "src/__fixtures__/canonical-sprint.yaml");

// Capability policy with all roles needed for multi-workflow tests.
// Includes dev, steward, code-review, deployment, ux-researcher, engine, sprint-owner bodies.
const REGISTRY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: code-review
    grants: [linear:transition]
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]
  - id: sprint-owner
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]
  - id: ux-researcher
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]
  - id: sprint-owner
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
  - id: maya
    container: ux-researcher
    fills_roles: [ux-researcher]
  - id: engine-1
    container: engine
    fills_roles: [engine]
  - id: soren
    container: sprint-owner
    fills_roles: [sprint-owner]
`;

let dir: string;
let registryDir: string;
let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-test-"));

  // Capability policy
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, REGISTRY_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  // Agents file (H-1 fail-closed requires linearUserId on singleton auto-delegate targets)
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-c", clientSecret: "c-s", accessToken: "c-t", refreshToken: "c-r" },
      { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-c", clientSecret: "h-s", accessToken: "h-t", refreshToken: "h-r" },
      { name: "maya", linearUserId: "maya-linear-uuid", clientId: "m-c", clientSecret: "m-s", accessToken: "m-t", refreshToken: "m-r" },
      { name: "engine-1", linearUserId: "engine1-linear-uuid", clientId: "e-c", clientSecret: "e-s", accessToken: "e-t", refreshToken: "e-r" },
      { name: "soren", linearUserId: "soren-linear-uuid", clientId: "so-c", clientSecret: "so-s", accessToken: "so-t", refreshToken: "so-r" },
    ],
  }, null, 2), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();

  // Registry directory with all three canonical workflow fixtures
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-defs-"));
  fs.writeFileSync(path.join(registryDir, "dev-impl.yaml"), fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");
  fs.writeFileSync(path.join(registryDir, "ux-audit.yaml"), fs.readFileSync(CANONICAL_UX_AUDIT, "utf8"), "utf8");
  fs.writeFileSync(path.join(registryDir, "sprint.yaml"), fs.readFileSync(CANONICAL_SPRINT, "utf8"), "utf8");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(registryDir, { recursive: true, force: true });
  delete process.env.WORKFLOW_DEFS_DIR;
});

beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  savedFetch = globalThis.fetch;
  delete process.env.WORKFLOW_DEFS_DIR;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  delete process.env.WORKFLOW_DEFS_DIR;
});

// ── Shared fetch mock (minimal label fetch, same shape as workflow-gate.test.ts) ────────────

function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
  const mockTeamStates = [
    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
    { id: "state-doing-uuid", name: "Doing", type: "started" },
    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
    { id: "state-managing-uuid", name: "Managing", type: "started" },
    { id: "state-done-uuid", name: "Done", type: "completed" },
    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
  ];
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: mockTeamStates } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (body.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // delegate + labels response
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labelNames.map((n) => ({ name: n })) },
            delegate: null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ── Convenience accessor for the not-yet-exported loadWorkflowRegistry ──────

type RegistryFn = () => Promise<Map<string, WorkflowDef>>;
function getLoadWorkflowRegistry(): RegistryFn {
  const fn = (WorkflowGate as Record<string, unknown>)["loadWorkflowRegistry"];
  if (typeof fn !== "function") {
    throw new Error(
      "loadWorkflowRegistry is not exported from workflow-gate. " +
      "The implementation must export this function (AC1).",
    );
  }
  return fn as RegistryFn;
}

// ── AC1: Registry loads all *.yaml defs from WORKFLOW_DEFS_DIR ───────────────

describe("AC1: registry load — all *.yaml defs from WORKFLOW_DEFS_DIR", () => {
  it("loadWorkflowRegistry is exported from workflow-gate", () => {
    // Fails until the implementation exports this function.
    expect(typeof (WorkflowGate as Record<string, unknown>)["loadWorkflowRegistry"]).toBe("function");
  });

  it("loads all three canonical defs; registry is keyed by def.id", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    const loadWorkflowRegistry = getLoadWorkflowRegistry();
    const registry = await loadWorkflowRegistry();

    expect(registry.size).toBe(3);
    expect(registry.has("dev-impl")).toBe(true);
    expect(registry.has("ux-audit")).toBe(true);
    expect(registry.has("sprint")).toBe(true);
    expect(registry.get("dev-impl")!.id).toBe("dev-impl");
    expect(registry.get("ux-audit")!.id).toBe("ux-audit");
    expect(registry.get("sprint")!.id).toBe("sprint");
  });

  it("ignores non-.yaml files in the directory", async () => {
    const mixedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mixed-"));
    try {
      fs.writeFileSync(path.join(mixedDir, "dev-impl.yaml"), fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");
      fs.writeFileSync(path.join(mixedDir, "README.md"), "# docs", "utf8");
      fs.writeFileSync(path.join(mixedDir, "config.json"), "{}", "utf8");
      fs.writeFileSync(path.join(mixedDir, "scratch.txt"), "tmp", "utf8");

      process.env.WORKFLOW_DEFS_DIR = mixedDir;
      const loadWorkflowRegistry = getLoadWorkflowRegistry();
      const registry = await loadWorkflowRegistry();

      expect(registry.size).toBe(1);
      expect(registry.has("dev-impl")).toBe(true);
    } finally {
      fs.rmSync(mixedDir, { recursive: true, force: true });
    }
  });
});

// ── AC2: Per-def native_state validation ─────────────────────────────────────

describe("AC2: per-def native_state validation", () => {
  it("a def with a missing native_state on a non-terminal state is excluded from the registry", async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bad-def-"));
    const BAD_DEF_YAML = `
id: bad-workflow
version: 1
break_glass:
  command: escape
states:
  - id: intake
    owner_role: steward
    kind: normal
    # native_state intentionally omitted — must fail validateNativeStateMappings
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;
    try {
      fs.writeFileSync(path.join(badDir, "bad-workflow.yaml"), BAD_DEF_YAML, "utf8");
      fs.writeFileSync(path.join(badDir, "dev-impl.yaml"), fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");

      process.env.WORKFLOW_DEFS_DIR = badDir;
      const loadWorkflowRegistry = getLoadWorkflowRegistry();
      const registry = await loadWorkflowRegistry();

      // The bad def must not appear in the registry.
      expect(registry.has("bad-workflow")).toBe(false);
      // The valid def must still be present.
      expect(registry.has("dev-impl")).toBe(true);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("a def with an unrecognised native_state value is excluded from the registry", async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bad-native-"));
    const INVALID_NATIVE_YAML = `
id: invalid-native
version: 1
break_glass:
  command: escape
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: not-a-real-semantic-state
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;
    try {
      fs.writeFileSync(path.join(badDir, "invalid-native.yaml"), INVALID_NATIVE_YAML, "utf8");
      fs.writeFileSync(path.join(badDir, "dev-impl.yaml"), fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");

      process.env.WORKFLOW_DEFS_DIR = badDir;
      const loadWorkflowRegistry = getLoadWorkflowRegistry();
      const registry = await loadWorkflowRegistry();

      expect(registry.has("invalid-native")).toBe(false);
      expect(registry.has("dev-impl")).toBe(true);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("all three canonical defs have no native_state validation errors", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    const loadWorkflowRegistry = getLoadWorkflowRegistry();
    const registry = await loadWorkflowRegistry();

    for (const [id, def] of registry) {
      const errors = validateNativeStateMappings(def);
      expect(errors).toHaveLength(0); // ${id} should have 0 native_state errors
    }
  });
});

// ── AC3: Gate dispatches by wf: label; unknown wf: remains pass-through ──────

describe("AC3: gate dispatches by wf: label from registry", () => {
  it("wf:ux-audit ticket with an illegal command is BLOCKED (not pass-through)", async () => {
    // Currently the gate passes through any wf: that doesn't match the single loaded def.
    // After the fix, it must look up ux-audit in the registry and enforce its state machine.
    // 'submit' does not exist in any ux-audit state — the gate must block it.
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);

    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "maya");

    // Current code returns null (pass-through); after fix must return an error string.
    expect(result).not.toBeNull();
    expect(result).toContain("not a legal command");
  });

  it("wf:sprint ticket with an illegal command is BLOCKED (not pass-through)", async () => {
    // 'approve' is not a transition from sprint's ux-shaping state.
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:ux-shaping"]);

    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "maya");

    expect(result).not.toBeNull();
    expect(result).toContain("not a legal command");
  });

  it("wf:ux-audit — 'complete-audit' from 'auditing' is a LEGAL transition (allowed)", async () => {
    // After the fix: the gate resolves the ux-audit def and enforces its state machine.
    // 'complete-audit' is the only valid transition from 'auditing'.
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);

    // maya is the ux-researcher body (owner of the auditing state)
    const result = await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "maya");

    expect(result).toBeNull();
  });

  it("wf:sprint — 'spawn' from 'spawning' is a LEGAL transition (allowed)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:spawning"]);

    const result = await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "engine-1");

    expect(result).toBeNull();
  });

  it("ticket with unknown wf: label remains pass-through (AC3 preservation)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:totally-unknown-workflow", "state:something"]);

    const result = await checkWorkflowRules("any-command", "issue-uuid", "Bearer tok", "charles");

    // An unknown wf: must remain null (pass-through) regardless of registry contents.
    expect(result).toBeNull();
  });

  it("ad-hoc ticket (no wf: label) rejects transition verbs (INF-35)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);

    const result = await checkWorkflowRules("anything", "issue-uuid", "Bearer tok", "charles");

    expect(result).not.toBeNull();
    expect(result).toEqual(expect.stringContaining("only valid on workflow tickets"));
  });

  it("ad-hoc ticket (no wf: label) allows safe verbs through (INF-35)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);

    const result = await checkWorkflowRules("note", "issue-uuid", "Bearer tok", "charles");

    expect(result).toBeNull();
  });
});

// ── AC4: dev-impl enforcement unchanged (regression) ─────────────────────────

describe("AC4: dev-impl regression — registry-based gate identical to single-def gate", () => {
  it("dev-impl canonical fixture loads cleanly from registry with no validation errors", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    const loadWorkflowRegistry = getLoadWorkflowRegistry();
    const registry = await loadWorkflowRegistry();

    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();
    expect(devImpl!.id).toBe("dev-impl");
    const errors = validateNativeStateMappings(devImpl!);
    expect(errors).toHaveLength(0);
  });

  it("dev-impl: 'accept' from 'intake' is allowed (steward body)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);

    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid");

    expect(result).toBeNull();
  });

  it("dev-impl: 'submit' from 'intake' is blocked (intake has no submit transition)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);

    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");

    expect(result).not.toBeNull();
    expect(result).toContain("not a legal command");
  });

  it("dev-impl: 'submit' from 'implementation' is allowed (dev body)", async () => {
    // assign: required on the transition but with only one reviewer body in policy it auto-routes.
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    // AI-1731: submit now has requires_comment — pass hasComment=true to test legality, not the comment gate
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", null, undefined, null, false, false, true);

    // With a single reviewer body (reviewer), assign mode=required + not-implementer
    // might block unless a target is provided. Key regression: the gate DOES NOT pass-through.
    // It should enforce and produce either null (allowed) or a specific enforcement message.
    // The enforcement must originate from the dev-impl def, not be a blanket pass-through.
    // We verify the gate reached enforcement logic (non-null = blocked for the right reason,
    // null = allowed — both are OK here; what's NOT OK is a null from wrong reason).
    // For this specific case (charles submitting, reviewer is the only code-review body and
    // not-implementer passes), the gate should allow after checking the constraint.
    // If the reviewer role has multiple bodies the gate requires an explicit target.
    // In REGISTRY_POLICY_YAML reviewer is the sole code-review body → auto-routes → allowed.
    expect(result).toBeNull();
  });

  it("dev-impl: 'escape' break-glass is always allowed from any state", async () => {
    const states = ["intake", "implementation", "code-review", "deployment", "done"];
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    for (const state of states) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid");
      expect(result).toBeNull(); // escape must be allowed from ${state}
    }
  });
});

// ── AC5: resetWorkflowCache() clears the whole registry ──────────────────────

describe("AC5: resetWorkflowCache clears the whole registry", () => {
  it("registry is cached after first load; resetWorkflowCache forces reload from disk", async () => {
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-live-reload-"));
    try {
      fs.writeFileSync(path.join(liveDir, "dev-impl.yaml"), fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");
      process.env.WORKFLOW_DEFS_DIR = liveDir;

      const loadWorkflowRegistry = getLoadWorkflowRegistry();

      // First load — only dev-impl present.
      const r1 = await loadWorkflowRegistry();
      expect(r1.size).toBe(1);
      expect(r1.has("dev-impl")).toBe(true);

      // Add ux-audit to the live directory (simulating vault edit).
      fs.writeFileSync(path.join(liveDir, "ux-audit.yaml"), fs.readFileSync(CANONICAL_UX_AUDIT, "utf8"), "utf8");

      // Without resetting the cache, the registry is stale.
      const r2 = await loadWorkflowRegistry();
      expect(r2.size).toBe(1); // still seeing the cached version

      // After resetWorkflowCache(), a fresh disk scan picks up the new file.
      resetWorkflowCache();
      const r3 = await loadWorkflowRegistry();
      expect(r3.size).toBe(2);
      expect(r3.has("ux-audit")).toBe(true);
    } finally {
      fs.rmSync(liveDir, { recursive: true, force: true });
    }
  });

  it("resetWorkflowCache() clears registry across multiple defs (not just one)", async () => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    const loadWorkflowRegistry = getLoadWorkflowRegistry();

    const r1 = await loadWorkflowRegistry();
    expect(r1.size).toBe(3);

    // Reset + reload — should produce an equivalent registry.
    resetWorkflowCache();
    const r2 = await loadWorkflowRegistry();
    expect(r2.size).toBe(3);
    expect(r2.has("dev-impl")).toBe(true);
    expect(r2.has("ux-audit")).toBe(true);
    expect(r2.has("sprint")).toBe(true);
  });
});

// ── AC6: Backwards-compat — single WORKFLOW_DEF_PATH, no WORKFLOW_DEFS_DIR ──

describe("AC6: backwards-compat — WORKFLOW_DEF_PATH only (no WORKFLOW_DEFS_DIR)", () => {
  it("loads single def as a 1-entry registry when WORKFLOW_DEFS_DIR is not set", async () => {
    // Simulates the current deployment: only WORKFLOW_DEF_PATH is configured.
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-single-compat-"));
    const singleFile = path.join(singleDir, "dev-impl.yaml");
    fs.writeFileSync(singleFile, fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");

    const savedPath = process.env.WORKFLOW_DEF_PATH;
    try {
      delete process.env.WORKFLOW_DEFS_DIR; // must not be set
      process.env.WORKFLOW_DEF_PATH = singleFile;

      const loadWorkflowRegistry = getLoadWorkflowRegistry();
      const registry = await loadWorkflowRegistry();

      expect(registry.size).toBe(1);
      expect(registry.has("dev-impl")).toBe(true);
    } finally {
      fs.rmSync(singleDir, { recursive: true, force: true });
      process.env.WORKFLOW_DEF_PATH = savedPath;
    }
  });

  it("WORKFLOW_DEF_PATH-only deploy still enforces dev-impl — no regression", async () => {
    // End-to-end compat: existing deploy continues to work with just WORKFLOW_DEF_PATH.
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-compat-gate-"));
    const singleFile = path.join(singleDir, "dev-impl.yaml");
    fs.writeFileSync(singleFile, fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");

    const savedPath = process.env.WORKFLOW_DEF_PATH;
    try {
      delete process.env.WORKFLOW_DEFS_DIR;
      process.env.WORKFLOW_DEF_PATH = singleFile;

      // Illegal command on dev-impl ticket must still be blocked.
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
      const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
      expect(result).not.toBeNull();
    } finally {
      fs.rmSync(singleDir, { recursive: true, force: true });
      process.env.WORKFLOW_DEF_PATH = savedPath;
    }
  });
});
