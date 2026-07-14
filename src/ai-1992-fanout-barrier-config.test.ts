/**
 * AI-1992 — Engine: declarative fanout + barrier configuration in workflow YAML.
 *
 * Failing (TDD) tests written BEFORE implementation. These encode the AC of
 * record captured at intake (2026-07-09, astrid). The implementer (igor) makes
 * them pass; the test author does not implement.
 *
 * ── Intended API contract (implementer target) ────────────────────────────
 * These tests drive the following surface. Names/locations are the contract:
 *
 *   workflow-gate.ts:
 *     export interface FanoutConfig {
 *       spec_source: string;        // structured section of the parent description
 *       child_workflow: string;     // wf:* label ONLY (validated at load + spawn)
 *       initial_delegate?: string;  // optional body id to delegate each child to
 *       block_siblings?: boolean;   // create sibling blocking relations at spawn
 *     }
 *     interface WorkflowState { ...; fanout?: FanoutConfig; barrier?: boolean }
 *     // loadDefFromFile / loadWorkflowRegistry validate:
 *     //   - fanout.child_workflow must match /^wf:.+/  → else def excluded (fail-closed)
 *     //   - barrier must be boolean
 *
 *   fanout.ts:
 *     // Config-driven trigger — replaces the hardcoded ux-audit/sprint allowlist.
 *     export function shouldTriggerFanout(
 *       def: WorkflowDef, currentState: string, intent: string,
 *     ): FanoutConfig | boolean | null;   // truthy when the state fans out
 *     // Child workflow label + spec source come from config, not hardcoded.
 *     export async function executeFanout(
 *       parentIssueId: string, authToken: string, config: FanoutConfig,
 *       options?: { caps?: unknown; skipPreview?: boolean; findingsOverride?: Finding[] },
 *     ): Promise<FanoutResult>;          // refuses (created:0, refused:true) on non-wf child
 *
 *   barrier.ts:
 *     // BARRIER_WORKFLOWS set removed; barrier-ness driven by state.barrier === true,
 *     // for ANY workflow id (not a hardcoded allowlist). attemptBarrierTransition
 *     // advances the parent's CURRENT barrier state via that state's forward
 *     // transition target (not a hardcoded "managing" → "review"/"validating").
 *
 * ── AC → test map ─────────────────────────────────────────────────────────
 *   AC1 fanout block schema ............. "config parsing" + "fanout schema fields"
 *   AC2 allowlist/label removed, migrate  "shouldTriggerFanout config-driven" +
 *                                          "migration: ux-audit/sprint fanout"
 *   AC3 barrier:true, set removed, migrate "barrier config" + "migration: barrier"
 *   AC4 multi-phase (two fanout states) .. "two-phase synthetic def end to end"
 *   AC5 malformed/empty spec refuses ..... "malformed spawn spec refuses transition"
 *   AC6 dev-impl/task unchanged .......... "defs without fanout/barrier load unchanged"
 *   AC7 wf-only child-type enforcement ... "wf-only child type (load)" +
 *                                          "wf-only child type (spawn time)"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  applyStateTransition,
  resetWorkflowCache,
  loadWorkflowRegistry,
  type WorkflowDef,
  type WorkflowState,
  type FanoutConfig,
} from "./workflow-gate.js";
import { shouldTriggerFanout, executeFanout, type Finding } from "./fanout.js";
import { attemptBarrierTransition } from "./barrier.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// ── Synthetic workflow defs (self-contained fixtures) ──────────────────────

/** Valid single-phase fanout + barrier workflow. */
const SYNTHETIC_FANOUT_YAML = `
id: synthetic-fanout
version: 1
archetype: orchestrator
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: spawning, assign: { mode: required } }
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:dev-impl
      initial_delegate: igor
      block_siblings: true
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

/** Two fanout states + two barriers: spawn phase 1 → barrier → spawn phase 2 → barrier. */
const SYNTHETIC_TWO_PHASE_YAML = `
id: synthetic-two-phase
version: 1
archetype: feature-initiative
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: arming, assign: { mode: required } }
  - id: arming
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:sprint-arm
    transitions:
      - { command: spawn, to: managing-arm }
  - id: managing-arm
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: impl }
  - id: impl
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:dev-impl
    transitions:
      - { command: spawn, to: managing-impl }
  - id: managing-impl
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

/** Invalid: fanout child_workflow is not a wf:* label → must be rejected at load. */
const SYNTHETIC_BAD_CHILD_YAML = `
id: synthetic-bad-child
version: 1
archetype: orchestrator
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: spawning, assign: { mode: required } }
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: dev-impl
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

/** Plain task-like def: NO fanout, NO barrier. Must load and behave unchanged. */
const SYNTHETIC_TASK_YAML = `
id: synthetic-task
version: 1
archetype: task
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: doing, assign: { mode: required } }
  - id: doing
    owner_role: dev
    native_state: doing
    transitions:
      - { command: submit, to: done }
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]
  - id: sprint-owner
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: engine-1
    container: engine
    fills_roles: [engine]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const FIXTURES_DIR = path.resolve(process.cwd(), "src/__fixtures__");

/** Parse a synthetic def string into a WorkflowDef (bypasses the loader). */
function parseDef(source: string): WorkflowDef {
  return yaml.load(source) as WorkflowDef;
}

function stateOf(def: WorkflowDef, id: string): WorkflowState {
  const s = def.states.find((st) => st.id === id);
  if (!s) throw new Error(`no state '${id}' in def '${def.id}'`);
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 / AC6 / AC7(load): config parsing (valid + invalid) via the registry
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 config parsing — fanout/barrier YAML via loadWorkflowRegistry", () => {
  let dir: string;
  let origDefsDir: string | undefined;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1992-parse-"));
    fs.writeFileSync(path.join(dir, "synthetic-fanout.yaml"), SYNTHETIC_FANOUT_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "synthetic-bad-child.yaml"), SYNTHETIC_BAD_CHILD_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "synthetic-task.yaml"), SYNTHETIC_TASK_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  beforeEach(() => resetWorkflowCache());

  it("AC1: a valid fanout+barrier def loads and exposes the parsed fanout config", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("synthetic-fanout");
    expect(def).toBeDefined();

    const spawning = stateOf(def!, "spawning");
    const fanout = spawning.fanout as FanoutConfig | undefined;
    expect(fanout).toBeDefined();
    expect(fanout!.spec_source).toBe("findings");
    expect(fanout!.child_workflow).toBe("wf:dev-impl");
    expect(fanout!.initial_delegate).toBe("igor");
    expect(fanout!.block_siblings).toBe(true);
    // Parsed config must be actionable by the engine — not just passively carried.
    expect(shouldTriggerFanout(def!, "spawning", "spawn")).toBeTruthy();
  });

  it("AC3: a managing state can declare barrier: true in YAML", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("synthetic-fanout");
    expect(stateOf(def!, "managing").barrier).toBe(true);
  });

  it("AC7 (load): a fanout whose child_workflow is not wf:* is rejected — def excluded from registry", async () => {
    const registry = await loadWorkflowRegistry();
    // Fail-closed: the malformed def must NOT be served (no partial/loose acceptance).
    expect(registry.has("synthetic-bad-child")).toBe(false);
    // Sibling valid defs still load (one bad def fails only itself).
    expect(registry.has("synthetic-fanout")).toBe(true);
  });

  it("AC6: a def with no fanout/barrier fields loads unchanged", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("synthetic-task");
    expect(def).toBeDefined();
    for (const st of def!.states) {
      expect(st.fanout).toBeUndefined();
      expect(st.barrier).toBeFalsy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1: fanout schema — all four fields are surfaced on the parsed state
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 fanout schema fields", () => {
  it("AC1: fanout block carries spec_source, wf:* child_workflow, initial_delegate, block_siblings", () => {
    const def = parseDef(SYNTHETIC_FANOUT_YAML);
    const fanout = stateOf(def, "spawning").fanout as FanoutConfig;
    expect(fanout.spec_source).toBe("findings");
    expect(fanout.child_workflow).toMatch(/^wf:/);
    expect(fanout.initial_delegate).toBe("igor");
    expect(fanout.block_siblings).toBe(true);
    // Fail-first: the block must be engine-actionable, not merely carried through
    // by js-yaml passthrough. The config-driven trigger keys on it.
    expect(shouldTriggerFanout(def, "spawning", "spawn")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: shouldTriggerFanout is config-driven (allowlist removed)
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 shouldTriggerFanout — config-driven, no hardcoded allowlist", () => {
  const def = parseDef(SYNTHETIC_FANOUT_YAML);

  it("AC2: triggers for a state that declares a fanout block on its spawn command", () => {
    expect(shouldTriggerFanout(def, "spawning", "spawn")).toBeTruthy();
  });

  it("AC2: does NOT trigger for a state with no fanout block", () => {
    expect(shouldTriggerFanout(def, "intake", "accept")).toBeFalsy();
  });

  it("AC2: does NOT trigger on the break-glass command out of a fanout state", () => {
    expect(shouldTriggerFanout(def, "spawning", "escape")).toBeFalsy();
  });

  it("AC2: fires for a workflow id that was NEVER in the old allowlist (behavior is config-only)", () => {
    // 'synthetic-fanout' is not 'ux-audit'/'sprint'; the removed allowlist would
    // have returned false. Config-driven engine keys on the state's fanout block.
    expect(shouldTriggerFanout(def, "spawning", "spawn")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 (spawn time): wf-only child-type enforcement inside executeFanout
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 executeFanout — child workflow type comes from config, wf:* enforced", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeFetch(description: string): typeof globalThis.fetch {
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("IssueTeamParent")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-internal-id",
                title: "Parent",
                description,
                team: { id: "team-uuid" },
                parent: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("TeamLabels")) {
        return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (query.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("issueCreate")) {
        return new Response(
          JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "c1", identifier: "AI-4001" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "cm" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    };
  }

  it("AC7 (spawn time): refuses to spawn when child_workflow is not a wf:* label", async () => {
    globalThis.fetch = makeFetch("## Findings\n- **A**: a\n- **B**: b\n");
    const badConfig = { spec_source: "findings", child_workflow: "dev-impl" } as FanoutConfig;

    const result = await executeFanout("AI-1992", "Bearer tok", badConfig, { skipPreview: true });

    expect(result.refused).toBe(true);
    expect(result.created).toBe(0);
    // Never partially spawns on a spec it cannot fully validate.
    expect(fetchCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("AC2: uses the configured wf:* child_workflow label for minted children (not hardcoded wf:dev-impl)", async () => {
    globalThis.fetch = makeFetch("## Findings\n- **A**: a\n");
    const config = { spec_source: "findings", child_workflow: "wf:custom-child" } as FanoutConfig;

    const result = await executeFanout("AI-1992", "Bearer tok", config, { skipPreview: true });

    expect(result.created).toBeGreaterThanOrEqual(1);
    const madeCustomLabel = fetchCalls.some(
      (c) => c.query.includes("issueLabelCreate") && c.variables.name === "wf:custom-child",
    );
    expect(madeCustomLabel).toBe(true);
    // Must NOT fall back to the old hardcoded child label.
    const madeHardcoded = fetchCalls.some(
      (c) => c.query.includes("issueLabelCreate") && c.variables.name === "wf:dev-impl",
    );
    expect(madeHardcoded).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 / AC3: migration — existing ux-audit & sprint defs move to YAML config
// (asserts the committed canonical fixtures gain the config, identical behavior)
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 migration — canonical ux-audit/sprint defs are config-driven", () => {
  function loadFixture(name: string): WorkflowDef {
    return yaml.load(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as WorkflowDef;
  }

  it("AC2: ux-audit spawning state declares fanout with child_workflow wf:dev-impl", () => {
    const def = loadFixture("canonical-ux-audit.yaml");
    const fanout = stateOf(def, "spawning").fanout as FanoutConfig | undefined;
    expect(fanout).toBeDefined();
    expect(fanout!.child_workflow).toBe("wf:dev-impl");
  });

  it("AC3: ux-audit managing state declares barrier: true", () => {
    const def = loadFixture("canonical-ux-audit.yaml");
    expect(stateOf(def, "managing").barrier).toBe(true);
  });

  it("AC2: sprint spawning state declares fanout with a wf:* child_workflow", () => {
    const def = loadFixture("canonical-sprint.yaml");
    const fanout = stateOf(def, "spawning").fanout as FanoutConfig | undefined;
    expect(fanout).toBeDefined();
    expect(fanout!.child_workflow).toMatch(/^wf:/);
  });

  it("AC3: sprint managing state declares barrier: true", () => {
    const def = loadFixture("canonical-sprint.yaml");
    expect(stateOf(def, "managing").barrier).toBe(true);
  });

  it("AC6: dev-impl def has no fanout or barrier config (unchanged)", () => {
    const def = loadFixture("canonical-dev-impl.yaml");
    for (const st of def.states) {
      expect(st.fanout).toBeUndefined();
      expect(st.barrier).toBeFalsy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration harness (applyStateTransition + attemptBarrierTransition)
// ═══════════════════════════════════════════════════════════════════════════

/** Full Linear-API mock covering a config-driven fanout state transition. */
function makeFanoutIntegrationFetch(opts: {
  workflowId: string;
  currentState: string;
  parentDescription: string;
  record: Array<{ query: string; variables: Record<string, unknown> }>;
}): typeof globalThis.fetch {
  const parentLabels = [
    { id: "wf-lbl", name: `wf:${opts.workflowId}` },
    { id: "state-lbl", name: `state:${opts.currentState}` },
  ];
  let childCount = 0;

  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    opts.record.push({ query, variables: parsed.variables ?? {} });

    if (query.includes("IssueWithLabels")) {
      return json({ issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } });
    }
    if (query.includes("TeamStates")) {
      return json({
        team: {
          states: {
            nodes: [
              { id: "s-todo", name: "Todo", type: "unstarted" },
              { id: "s-doing", name: "Doing", type: "started" },
              { id: "s-thinking", name: "Thinking", type: "started" },
              { id: "s-managing", name: "Managing", type: "started" },
              { id: "s-done", name: "Done", type: "completed" },
              { id: "s-invalid", name: "Invalid", type: "canceled" },
            ],
          },
        },
      });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ issueUpdate: { success: true } });
    }
    if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
      return json({ issue: { parent: null } });
    }
    if (query.includes("IssueTeamParent")) {
      return json({
        issue: {
          id: "parent-internal-id",
          title: "Parent",
          description: opts.parentDescription,
          team: { id: "team-uuid" },
          parent: null,
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({ team: { labels: { nodes: [] } } });
    }
    if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
      const name = (parsed.variables as Record<string, unknown>).name as string;
      return json({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
    }
    if (query.includes("issueCreate")) {
      childCount++;
      return json({ issueCreate: { success: true, issue: { id: `child-${childCount}`, identifier: `AI-${5000 + childCount}` } } });
    }
    if (query.includes("commentCreate")) {
      return json({ commentCreate: { success: true, comment: { id: "cm" } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };
}

/** Barrier-path mock: parent in a barrier state with all children terminal. */
function makeBarrierFetch(opts: {
  workflowId: string;
  currentState: string;
  record: Array<{ query: string; variables: Record<string, unknown> }>;
  children?: Array<{ identifier: string; labels: string[] }>;
}): typeof globalThis.fetch {
  const parentLabels = [
    { id: "wf-lbl", name: `wf:${opts.workflowId}` },
    { id: "state-lbl", name: `state:${opts.currentState}` },
  ];
  const children = opts.children ?? [
    { identifier: "AI-6001", labels: ["wf:dev-impl", "state:done"] },
    { identifier: "AI-6002", labels: ["wf:dev-impl", "state:done"] },
  ];
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    opts.record.push({ query, variables: parsed.variables ?? {} });

    if (query.includes("ParentChildren")) {
      return json({
        issue: {
          children: {
            nodes: children.map((c) => ({ identifier: c.identifier, labels: { nodes: c.labels.map((l) => ({ name: l })) } })),
          },
        },
      });
    }
    if (query.includes("ParentLabels") || query.includes("ParentState") || query.includes("IssueLabels")) {
      return json({ issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } });
    }
    if (query.includes("TeamLabels")) {
      return json({ team: { labels: { nodes: [] } } });
    }
    if (query.includes("issueLabelCreate")) {
      const name = (parsed.variables as Record<string, unknown>).name as string;
      return json({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
    }
    if (query.includes("BarrierTransition") || query.includes("UpdateLabels")) {
      return json({ issueUpdate: { success: true } });
    }
    if (query.includes("commentCreate")) {
      return json({ commentCreate: { success: true, comment: { id: "cm" } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ═══════════════════════════════════════════════════════════════════════════
// AC5: a malformed/empty spawn spec refuses the transition (no partial spawn)
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 malformed/empty spawn spec refuses the transition", () => {
  let dir: string;
  let policyFile: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1992-refuse-"));
    fs.writeFileSync(path.join(dir, "synthetic-fanout.yaml"), SYNTHETIC_FANOUT_YAML, "utf8");
    policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    // Agents with linearUserId for singleton delegate resolution (AI-2359 fail-closed)
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "engine-1", linearUserId: "engine1-linear-uuid", clientId: "e1-client", clientSecret: "e1-secret", accessToken: "e1-token", refreshToken: "e1-refresh" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-client", clientSecret: "i-secret", accessToken: "i-token", refreshToken: "i-refresh" },
      ],
    }, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    if (origPolicy !== undefined) process.env.CAPABILITY_POLICY_PATH = origPolicy;
    else delete process.env.CAPABILITY_POLICY_PATH;
    resetWorkflowCache();
    resetPolicyCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("AC5: empty spawn spec → transition NOT applied, NO children created, actionable error comment", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    // Description has no parseable spec section → the spec source is empty.
    globalThis.fetch = makeFanoutIntegrationFetch({
      workflowId: "synthetic-fanout",
      currentState: "spawning",
      parentDescription: "Just a description with no findings section at all.",
      record,
    });

    const result = await applyStateTransition("spawn", "AI-1992", "Bearer tok");

    // The engine never guesses or partially spawns on a spec it cannot validate.
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    // Refuses the transition itself — no atomic state mutation was written.
    expect(record.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
    expect(result.status).not.toBe("applied");
    // Posts an actionable error comment on the ticket.
    const comment = record.find((c) => c.query.includes("commentCreate"));
    expect(comment).toBeDefined();
    const body = String((comment!.variables as Record<string, unknown>).body ?? "");
    expect(body).toMatch(/spec|fanout|spawn|finding|refus|empty|invalid/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4: two-phase synthetic def end to end — spawn 1 → barrier → spawn 2 → barrier
// ═══════════════════════════════════════════════════════════════════════════

describe("AI-1992 two-phase synthetic def — end to end", () => {
  let dir: string;
  let policyFile: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  const FINDINGS = "## Findings\n- **A**: alpha\n- **B**: beta\n";

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1992-2phase-"));
    fs.writeFileSync(path.join(dir, "synthetic-two-phase.yaml"), SYNTHETIC_TWO_PHASE_YAML, "utf8");
    policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    // Agents with linearUserId for singleton delegate resolution (AI-2359 fail-closed)
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "engine-1", linearUserId: "engine1-linear-uuid", clientId: "e1-client", clientSecret: "e1-secret", accessToken: "e1-token", refreshToken: "e1-refresh" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-client", clientSecret: "i-secret", accessToken: "i-token", refreshToken: "i-refresh" },
      ],
    }, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    if (origPolicy !== undefined) process.env.CAPABILITY_POLICY_PATH = origPolicy;
    else delete process.env.CAPABILITY_POLICY_PATH;
    resetWorkflowCache();
    resetPolicyCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("AC4: the def has two distinct fanout states and two barrier states", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("synthetic-two-phase");
    expect(def).toBeDefined();

    const fanoutStates = def!.states.filter((s) => s.fanout);
    expect(fanoutStates.map((s) => s.id).sort()).toEqual(["arming", "impl"]);
    // Each phase spawns a DIFFERENT child workflow type.
    expect((stateOf(def!, "arming").fanout as FanoutConfig).child_workflow).toBe("wf:sprint-arm");
    expect((stateOf(def!, "impl").fanout as FanoutConfig).child_workflow).toBe("wf:dev-impl");

    const barrierStates = def!.states.filter((s) => s.barrier).map((s) => s.id).sort();
    expect(barrierStates).toEqual(["managing-arm", "managing-impl"]);

    // Fail-first: both fanout states must be engine-actionable (config-driven
    // trigger), not merely carried through by js-yaml. Barrier states must not
    // themselves fan out.
    expect(shouldTriggerFanout(def!, "arming", "spawn")).toBeTruthy();
    expect(shouldTriggerFanout(def!, "impl", "spawn")).toBeTruthy();
    expect(shouldTriggerFanout(def!, "managing-arm", "complete")).toBeFalsy();
  });

  it("AC4 phase 1 (spawn): arming fans out children with the wf:sprint-arm child workflow", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeFanoutIntegrationFetch({
      workflowId: "synthetic-two-phase",
      currentState: "arming",
      parentDescription: FINDINGS,
      record,
    });

    await applyStateTransition("spawn", "AI-1992", "Bearer tok");

    expect(record.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
    const childCreates = record.filter((c) => c.query.includes("issueCreate"));
    expect(childCreates.length).toBeGreaterThanOrEqual(2);
    // Children are minted under the phase-1 child workflow label.
    expect(record.some((c) => c.query.includes("issueLabelCreate") && c.variables.name === "wf:sprint-arm")).toBe(true);
  });

  it("AC4 barrier 1: all phase-1 children terminal advances managing-arm → impl (config-driven, non-hardcoded workflow)", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeBarrierFetch({
      workflowId: "synthetic-two-phase",
      currentState: "managing-arm",
      record,
    });

    const result = await attemptBarrierTransition("AI-1992", "Bearer tok");

    expect(result.transitioned).toBe(true);
    // Advances to THIS barrier state's forward target — impl — not a hardcoded review/validating.
    expect(record.some((c) => c.query.includes("issueLabelCreate") && c.variables.name === "state:impl")).toBe(true);
  });

  it("AC4 phase 2 (spawn): impl fans out children with the wf:dev-impl child workflow", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeFanoutIntegrationFetch({
      workflowId: "synthetic-two-phase",
      currentState: "impl",
      parentDescription: FINDINGS,
      record,
    });

    await applyStateTransition("spawn", "AI-1992", "Bearer tok");

    expect(record.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
    const childCreates = record.filter((c) => c.query.includes("issueCreate"));
    expect(childCreates.length).toBeGreaterThanOrEqual(2);
    expect(record.some((c) => c.query.includes("issueLabelCreate") && c.variables.name === "wf:dev-impl")).toBe(true);
  });

  it("AC4 barrier 2: all phase-2 children terminal advances managing-impl → done", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeBarrierFetch({
      workflowId: "synthetic-two-phase",
      currentState: "managing-impl",
      record,
    });

    const result = await attemptBarrierTransition("AI-1992", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(record.some((c) => c.query.includes("issueLabelCreate") && c.variables.name === "state:done")).toBe(true);
  });
});
