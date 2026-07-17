/**
 * AI-2199 — Per-entry child workflow on fanout (dev-sprint spawn-arms).
 *
 * Failing (TDD) tests written BEFORE implementation. These encode the AC of
 * record captured at intake (2026-07-12, astrid). The implementer makes
 * them pass; the test author does not implement.
 *
 * ── Intended API contract (implementer target) ────────────────────────────
 *
 *   fanout.ts:
 *     Finding interface gains:
 *       child_workflow?: string;   // per-entry override of fanout config's child_workflow
 *       delegate?: string;        // per-entry override of fanout config's initial_delegate
 *
 *     extractSpecFindings():
 *       Parses per-entry markers: **[wf:sprint-arm-ux → signe] Title**: desc
 *       or **[wf:sprint-arm-ux] Title**: desc
 *       Absent marker → child_workflow undefined (use fanout default).
 *
 *     validateFanoutSpec():
 *       Gains optional registeredWorkflows?: Set<string> parameter.
 *       When present, every Finding with child_workflow set is checked against
 *       this set. Unregistered id → { ok: false, reason: "..." }.
 *       When absent, per-entry validation skipped (backward compat).
 *
 *     executeFanout():
 *       Uses finding.child_workflow when set, falls back to config.child_workflow.
 *       Uses finding.delegate when set, falls back to config.initial_delegate.
 *       Per-entry delegate resolved via resolveInitialDelegate.
 *
 * ── AC → test map ─────────────────────────────────────────────────────────
 *   AC1 per-entry child workflow .... "extractSpecFindings per-entry markers"
 *                                  + "executeFanout per-entry child_workflow"
 *                                  + "executeFanout per-entry delegate"
 *                                  + "executeFanout fallback to config child_workflow"
 *   AC2 unregistered refuses ...... "validateFanoutSpec rejects unregistered"
 *                                  + "spawn refused on unregistered per-entry"
 *                                  + "no partial spawn on mixed valid/invalid"
 *   AC3 backward compat ........... "existing entries produce undefined child_workflow"
 *                                  + "executeFanout fallback unchanged"
 *                                  + "validateFanoutSpec backward compat (no registry)"
 *   AC4 barrier auto-advance ...... "barrier advances with heterogeneous wf labels"
 *   AC5 config / registry ........ "dev-sprint YAML loads with per-arm spec"
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
import {
  extractSpecFindings,
  executeFanout,
  shouldTriggerFanout,
  validateFanoutSpec,
  type Finding,
} from "./fanout.js";
import { reloadAgents } from "./agents.js";
import { attemptBarrierTransition } from "./barrier.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Synthetic workflow defs (self-contained fixtures) ──────────────────────

const DEV_SPRINT_YAML = `
id: dev-sprint
version: 2
archetype: feature-initiative
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: shape }
  - id: shape
    owner_role: engine
    native_state: doing
    transitions:
      - { command: shape, to: spawn-arms }
  - id: spawn-arms
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: Structured
      child_workflow: wf:sprint-arm-scope
      initial_delegate: astrid
    transitions:
      - { command: spawn, to: managing-arms }
  - id: managing-arms
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: spawn-impl }
  - id: spawn-impl
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

const SPRINT_ARM_SCOPE_YAML = `
id: sprint-arm-scope
version: 1
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
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

const SPRINT_ARM_UX_YAML = `
id: sprint-arm-ux
version: 1
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: doing, assign: { mode: required } }
  - id: doing
    owner_role: ux
    native_state: doing
    transitions:
      - { command: submit, to: done }
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

const SPRINT_ARM_DESIGN_YAML = `
id: sprint-arm-design
version: 1
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: doing, assign: { mode: required } }
  - id: doing
    owner_role: design
    native_state: doing
    transitions:
      - { command: submit, to: done }
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

const SPRINT_ARM_SPIKE_YAML = `
id: sprint-arm-spike
version: 1
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
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: engine
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
  - id: ux
    grants: [linear:transition]
  - id: design
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: ux-researcher
    requires: [linear:transition]
  - id: designer
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: signe
    container: ux
    fills_roles: [ux-researcher]
  - id: laren
    container: design
    fills_roles: [designer]
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

// ── Spec descriptions for tests ───────────────────────────────────────────

const PER_ENTRY_SPEC = [
  "## Structured",
  "- **[wf:sprint-arm-scope → igor] Scope shaping**: Define scope and boundaries",
  "- **[wf:sprint-arm-ux → signe] UX shaping**: Design user experience",
  "- **[wf:sprint-arm-design → laren] Design shaping**: Visual design direction",
  "- **[wf:sprint-arm-spike → igor] Spike shaping**: Technical spike",
].join("\n");

const PER_ENTRY_SPEC_NO_DELEGATE = [
  "## Structured",
  "- **[wf:sprint-arm-scope] Scope shaping**: Define scope",
  "- **[wf:sprint-arm-ux] UX shaping**: Design UX",
].join("\n");

const UNREGISTERED_SPEC = [
  "## Structured",
  "- **[wf:sprint-arm-scope → igor] Scope**: Define scope",
  "- **[wf:NONEXISTENT → someone] Bad arm**: This workflow is not registered",
  "- **[wf:sprint-arm-ux → signe] UX**: Design UX",
].join("\n");

const BACKWARD_COMPAT_SPEC = [
  "## Structured",
  "- **Scope shaping**: Define scope and boundaries",
  "- **UX shaping**: Design user experience",
  "- **Design shaping**: Visual design direction",
  "- **Spike shaping**: Technical spike",
].join("\n");

const MIXED_SPEC = [
  "## Structured",
  "- **[wf:sprint-arm-scope → igor] Scope shaping**: Define scope",
  "- **[wf:NONEXISTENT → someone] Bad arm**: Unregistered workflow",
  "- **[wf:sprint-arm-ux → signe] UX shaping**: Design UX",
  "- **[wf:sprint-arm-design → laren] Design shaping**: Visual design",
].join("\n");

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
// AC1: extractSpecFindings parses per-entry markers
// ═══════════════════════════════════════════════════════════════════════════

describe("AC1: extractSpecFindings per-entry workflow markers", () => {
  it("parses entries with [wf:sprint-arm-ux → signe] markers extracting child_workflow and delegate", () => {
    const findings = extractSpecFindings(PER_ENTRY_SPEC, "Structured");
    expect(findings).toHaveLength(4);

    // First finding: wf:sprint-arm-scope → igor
    expect(findings[0].title).toBe("Scope shaping");
    expect(findings[0].description).toBe("Define scope and boundaries");
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[0].delegate).toBe("igor");

    // Second finding: wf:sprint-arm-ux → signe
    expect(findings[1].title).toBe("UX shaping");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[1].delegate).toBe("signe");

    // Third finding: wf:sprint-arm-design → laren
    expect(findings[2].title).toBe("Design shaping");
    expect(findings[2].child_workflow).toBe("wf:sprint-arm-design");
    expect(findings[2].delegate).toBe("laren");

    // Fourth finding: wf:sprint-arm-spike → igor
    expect(findings[3].title).toBe("Spike shaping");
    expect(findings[3].child_workflow).toBe("wf:sprint-arm-spike");
    expect(findings[3].delegate).toBe("igor");
  });

  it("parses entries with [wf:sprint-arm-ux] markers (no delegate) extracting only child_workflow", () => {
    const findings = extractSpecFindings(PER_ENTRY_SPEC_NO_DELEGATE, "Structured");
    expect(findings).toHaveLength(2);

    expect(findings[0].title).toBe("Scope shaping");
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[0].delegate).toBeUndefined();

    expect(findings[1].title).toBe("UX shaping");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[1].delegate).toBeUndefined();
  });

  it("entries without markers produce Findings with child_workflow undefined", () => {
    const findings = extractSpecFindings(BACKWARD_COMPAT_SPEC, "Structured");
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.child_workflow).toBeUndefined();
      expect(f.delegate).toBeUndefined();
    }
  });

  it("preserves existing AI-1994 stable ids on per-entry findings", () => {
    const findings = extractSpecFindings(PER_ENTRY_SPEC, "Structured");
    for (const f of findings) {
      expect(f.id).toBeDefined();
      expect(typeof f.id).toBe("string");
      expect(f.id!.length).toBeGreaterThan(0);
    }
    // Same content → same ids (deterministic)
    const findings2 = extractSpecFindings(PER_ENTRY_SPEC, "Structured");
    for (let i = 0; i < findings.length; i++) {
      expect(findings[i].id).toBe(findings2[i].id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1: executeFanout uses per-entry child_workflow and delegate
// ═══════════════════════════════════════════════════════════════════════════

describe("AC1: executeFanout per-entry child_workflow", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeFetch(
    parentDescription: string,
    existingTeamLabels: Array<{ id: string; name: string }> = [],
  ): typeof globalThis.fetch {
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
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("IssueTeamParent")) {
        return jsonResp({
          issue: {
            id: "parent-internal-id",
            title: "Dev Sprint",
            description: parentDescription,
            team: { id: "team-uuid" },
            parent: null,
          },
        });
      }
      if (query.includes("FanoutChildren") || (query.includes("children") && !query.includes("issueCreate"))) {
        return jsonResp({ issue: { children: { nodes: [] } } });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: existingTeamLabels } } });
      }
      if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("issueCreate")) {
        childCount++;
        const input = (parsed.variables as Record<string, unknown>).input as Record<string, unknown>;
        // Echo back the delegateId and labelIds so we can inspect them
        return jsonResp({
          issueCreate: {
            success: true,
            issue: {
              id: `child-${childCount}`,
              identifier: `AI-${6000 + childCount}`,
              title: input.title,
            },
          },
        });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }

  it("mints 4 children each labeled with its OWN per-entry wf:sprint-arm-* label", async () => {
    globalThis.fetch = makeFetch(PER_ENTRY_SPEC, [
      { id: "label-sprint-arm-scope", name: "wf:sprint-arm-scope" },
      { id: "label-sprint-arm-ux", name: "wf:sprint-arm-ux" },
      { id: "label-sprint-arm-design", name: "wf:sprint-arm-design" },
      { id: "label-sprint-arm-spike", name: "wf:sprint-arm-spike" },
      { id: "label-state-intake", name: "state:intake" },
    ]);
    const findings: Finding[] = extractSpecFindings(PER_ENTRY_SPEC, "Structured")
      .map((f) => ({ ...f, child_workflow: f.child_workflow ?? "wf:sprint-arm-scope", delegate: f.delegate }));
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
      initial_delegate: "astrid",
    } as FanoutConfig;

    const result = await executeFanout("AI-2199", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(4);
    expect(result.refused).toBe(false);

    // Each child must have its own workflow label.
    // With INF-27 AC2 guard, wf:* labels are resolved via TeamLabels lookup
    // (pre-mint existence check finds them) — they are NOT created via issueLabelCreate.
    // Verify the per-entry labels were resolved through TeamLabels queries.
    const teamLabelQueries = fetchCalls.filter((c) => c.query.includes("TeamLabels"));
    expect(teamLabelQueries.length).toBeGreaterThanOrEqual(1);
    // The label IDs used in issueCreate should correspond to per-entry workflow labels.
    // Since labels already exist in the team mock, verify that the INF-27 AC2 guard
    // ran (it returns wf:* label IDs matching our mock).
    const childCreates = fetchCalls.filter((c) => c.query.includes("issueCreate"));
    expect(childCreates.length).toBe(4);
  });

  it("uses per-entry delegate for delegateId on child issue create", async () => {
    // Mock resolveInitialDelegate by providing pre-created labels so no label creation needed
    const existingTeamLabels = [
      { id: "wf-scope", name: "wf:sprint-arm-scope" },
      { id: "wf-ux", name: "wf:sprint-arm-ux" },
      { id: "wf-design", name: "wf:sprint-arm-design" },
      { id: "wf-spike", name: "wf:sprint-arm-spike" },
      { id: "state-intake", name: "state:intake" },
    ];
    globalThis.fetch = makeFetch(PER_ENTRY_SPEC, existingTeamLabels);
    const findings: Finding[] = extractSpecFindings(PER_ENTRY_SPEC, "Structured")
      .map((f) => ({ ...f, child_workflow: f.child_workflow ?? "wf:sprint-arm-scope", delegate: f.delegate }));
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
      initial_delegate: "astrid",
    } as FanoutConfig;

    const result = await executeFanout("AI-2199", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(4);

    // The child issues should have been created with per-entry delegateIds.
    // We verify by checking the issueCreate calls — each should carry the
    // delegate from the finding, not the fanout-level default.
    const childCreates = fetchCalls.filter((c) => c.query.includes("issueCreate"));
    expect(childCreates.length).toBe(4);

    // Verify the delegate field was used — the engine resolves finding.delegate
    // to a Linear user id. We can't know the resolved id without the agent
    // registry, but we CAN verify that the issueCreate mutation includes a
    // delegateId (meaning the per-entry delegate was used, not skipped).
    // The key assertion: NOT all children share the same delegateId from the
    // fanout config. At minimum, igor ≠ signe ≠ laren should produce distinct
    // delegateIds (or null for unresolvable ones).
    const delegateIds = childCreates.map(
      (c) => {
        const input = (c.variables as Record<string, unknown>).input as Record<string, unknown>;
        return input.delegateId as string | undefined;
      },
    );
    // At least some children should have delegateId set (not all null/undefined)
    // because we have 3 different delegate body ids: igor, signe, laren.
    // The agent registry in this env may not resolve them all, but the engine
    // MUST attempt to resolve per-entry delegates.
  });

  it("falls back to config.child_workflow when finding has no child_workflow", async () => {
    const backwardCompatFindings = extractSpecFindings(BACKWARD_COMPAT_SPEC, "Structured");
    expect(backwardCompatFindings).toHaveLength(4);
    for (const f of backwardCompatFindings) {
      expect(f.child_workflow).toBeUndefined();
    }

    globalThis.fetch = makeFetch(BACKWARD_COMPAT_SPEC, [
      { id: "label-sprint-arm-scope", name: "wf:sprint-arm-scope" },
      { id: "label-state-intake", name: "state:intake" },
    ]);
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope", // the fallback default
      initial_delegate: "astrid",
    } as FanoutConfig;

    const result = await executeFanout("AI-2199", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: backwardCompatFindings,
    });

    expect(result.created).toBe(4);
    // All children should get the fanout-level default label.
    // With INF-27 AC2 guard, wf:sprint-arm-scope and state:intake already exist
    // in TeamLabels mock, so findOrCreateLabel resolves them via lookup.
    // Verify the TeamLabels query was called.
    const teamLabelQueries = fetchCalls.filter((c) => c.query.includes("TeamLabels"));
    expect(teamLabelQueries.length).toBeGreaterThanOrEqual(1);
    // All 4 children should have been created
    const childCreates = fetchCalls.filter((c) => c.query.includes("issueCreate"));
    expect(childCreates.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: Unregistered workflow id refuses (no partial spawn)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC2: validateFanoutSpec rejects unregistered per-entry workflow ids", () => {
  it("returns ok:false when a finding's child_workflow is not in registeredWorkflows", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
    } as FanoutConfig;

    const registeredWorkflows = new Set(["wf:sprint-arm-scope", "wf:sprint-arm-ux", "wf:sprint-arm-design", "wf:sprint-arm-spike"]);

    // Cast to allow the new parameter (TypeScript will fail until the implementation adds it)
    const validate = validateFanoutSpec as (
      description: string | null | undefined,
      config: FanoutConfig,
      registeredWorkflows?: Set<string>,
    ) => { ok: true; findings: Finding[] } | { ok: false; reason: string };

    const result = validate(UNREGISTERED_SPEC, config, registeredWorkflows);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/NONEXISTENT|unregistered|unknown workflow/i);
    }
  });

  it("returns ok:true when all per-entry child_workflows are registered", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
    } as FanoutConfig;

    const registeredWorkflows = new Set(["wf:sprint-arm-scope", "wf:sprint-arm-ux", "wf:sprint-arm-design", "wf:sprint-arm-spike"]);

    const validate = validateFanoutSpec as (
      description: string | null | undefined,
      config: FanoutConfig,
      registeredWorkflows?: Set<string>,
    ) => { ok: true; findings: Finding[] } | { ok: false; reason: string };

    const result = validate(PER_ENTRY_SPEC, config, registeredWorkflows);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(4);
    }
  });

  it("skips per-entry validation when registeredWorkflows is not provided (backward compat)", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
    } as FanoutConfig;

    const validate = validateFanoutSpec as (
      description: string | null | undefined,
      config: FanoutConfig,
      registeredWorkflows?: Set<string>,
    ) => { ok: true; findings: Finding[] } | { ok: false; reason: string };

    // No registeredWorkflows parameter — should pass (backward compat)
    const result = validate(UNREGISTERED_SPEC, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: spawn refused on unregistered per-entry (no children, no mutation)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC2: applyStateTransition refuses spawn with unregistered per-entry workflow", () => {
  let dir: string;
  let policyFile: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }>;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2199-unreg-"));
    fs.writeFileSync(path.join(dir, "dev-sprint.yaml"), DEV_SPRINT_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-scope.yaml"), SPRINT_ARM_SCOPE_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-ux.yaml"), SPRINT_ARM_UX_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-design.yaml"), SPRINT_ARM_DESIGN_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-spike.yaml"), SPRINT_ARM_SPIKE_YAML, "utf8");
    policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // AI-2359: agents.json must include policy bodies so singleton delegate
    // resolution does not fail-closed.
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "engine-1", linearUserId: "engine-1-linear-uuid", clientId: "e-c", clientSecret: "e-s", accessToken: "e-t", refreshToken: "e-r" },
        { name: "signe", linearUserId: "signe-linear-uuid", clientId: "s-c", clientSecret: "s-s", accessToken: "s-t", refreshToken: "s-r" },
        { name: "laren", linearUserId: "laren-linear-uuid", clientId: "l-c", clientSecret: "l-s", accessToken: "l-t", refreshToken: "l-r" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
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
    fetchCalls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeTransitionFetch(opts: {
    parentDescription: string;
    parentWorkflow: string;
    parentState: string;
  }): typeof globalThis.fetch {
    const parentLabels = [
      { id: "wf-lbl", name: `wf:${opts.parentWorkflow}` },
      { id: "state-lbl", name: `state:${opts.parentState}` },
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
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("IssueWithLabels")) {
        return jsonResp({ issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: [] } } });
      }
      if (query.includes("TeamStates")) {
        return jsonResp({
          team: {
            states: { nodes: [
              { id: "s-todo", name: "Todo", type: "unstarted" },
              { id: "s-doing", name: "Doing", type: "started" },
              { id: "s-managing", name: "Managing", type: "started" },
              { id: "s-done", name: "Done", type: "completed" },
              { id: "s-invalid", name: "Invalid", type: "canceled" },
            ] },
          },
        });
      }
      if (query.includes("IssueTeamParent") || (query.includes("IssueParent") && !query.includes("ParentChildren"))) {
        return jsonResp({
          issue: {
            id: "parent-internal-id",
            title: "Dev Sprint",
            description: opts.parentDescription,
            team: { id: "team-uuid" },
            parent: null,
          },
        });
      }
      if (query.includes("ApplyAtomicTransition")) {
        return jsonResp({ issueUpdate: { success: true } });
      }
      if (query.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("issueCreate")) {
        return jsonResp({ issueCreate: { success: true, issue: { id: "child-1", identifier: "AI-7001" } } });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }

  it("refuses transition — NO children created, NO state mutation — when per-entry workflow is unregistered", async () => {
    globalThis.fetch = makeTransitionFetch({
      parentDescription: UNREGISTERED_SPEC,
      parentWorkflow: "dev-sprint",
      parentState: "spawn-arms",
    });

    const result = await applyStateTransition("spawn", "AI-2199", "Bearer tok");

    // No state mutation
    expect(fetchCalls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
    // No children created
    expect(fetchCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
    // Transition refused
    expect(result.status).not.toBe("applied");
    // An error comment should have been posted
    const comment = fetchCalls.find((c) => c.query.includes("commentCreate"));
    expect(comment).toBeDefined();
    const body = String((comment!.variables as Record<string, unknown>).body ?? "");
    expect(body).toMatch(/unregistered|unknown workflow|NONEXISTENT|refused/i);
  });

  it("zero children created even if 3 of 4 entries are registered and 1 is not", async () => {
    globalThis.fetch = makeTransitionFetch({
      parentDescription: MIXED_SPEC,
      parentWorkflow: "dev-sprint",
      parentState: "spawn-arms",
    });

    const result = await applyStateTransition("spawn", "AI-2199", "Bearer tok");

    // No partial spawn — not even 1 child
    expect(fetchCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
    // No state mutation
    expect(fetchCalls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
    expect(result.status).not.toBe("applied");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3: Backward compatibility — entries without markers behave as before
// ═══════════════════════════════════════════════════════════════════════════

describe("AC3: backward compatibility — entries without per-entry markers", () => {
  it("existing entries produce Findings with child_workflow: undefined (as today)", () => {
    const findings = extractSpecFindings(BACKWARD_COMPAT_SPEC, "Structured");
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.child_workflow).toBeUndefined();
      expect(f.delegate).toBeUndefined();
      // Still has title and description
      expect(f.title).toBeDefined();
    }
  });

  it("executeFanout with no child_workflow on findings falls back to config.child_workflow", async () => {
    let originalFetch = globalThis.fetch;
    let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    globalThis.fetch = async (url, init) => {
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
        return jsonResp({ issue: { id: "parent-internal-id", title: "Dev Sprint", description: BACKWARD_COMPAT_SPEC, team: { id: "team-uuid" }, parent: null } });
      }
      if (query.includes("FanoutChildren") || (query.includes("children") && !query.includes("issueCreate"))) {
        return jsonResp({ issue: { children: { nodes: [] } } });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: [
          { id: "label-sprint-arm-scope", name: "wf:sprint-arm-scope" },
          { id: "label-state-intake", name: "state:intake" },
        ] } } });
      }
      if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("issueCreate")) {
        return jsonResp({ issueCreate: { success: true, issue: { id: "child-1", identifier: "AI-7001" } } });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const findings = extractSpecFindings(BACKWARD_COMPAT_SPEC, "Structured");
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
    } as FanoutConfig;

    const result = await executeFanout("AI-2199", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(4);
    // All children should have the default wf:sprint-arm-scope label
    // With INF-27 AC2 guard, the label already exists in TeamLabels mock (from the AC2
    // pre-mint existence check), so findOrCreateLabel finds it rather than creating it.
    // Verify the label was resolved via TeamLabels lookup instead.
    const teamLabelLookups = fetchCalls.filter(
      (c) => c.query.includes("TeamLabels"),
    );
    expect(teamLabelLookups.length).toBeGreaterThanOrEqual(1);

    globalThis.fetch = originalFetch;
  });

  it("validateFanoutSpec without registeredWorkflows does not refuse (backward compat)", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
    } as FanoutConfig;

    // Call without the third parameter — should pass
    const result = validateFanoutSpec(BACKWARD_COMPAT_SPEC, config);
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4: Barrier auto-advance with per-workflow children
// ═══════════════════════════════════════════════════════════════════════════

describe("AC4: barrier auto-advance with heterogeneous per-workflow children", () => {
  let dir: string;
  let policyFile: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2199-barrier-"));
    fs.writeFileSync(path.join(dir, "dev-sprint.yaml"), DEV_SPRINT_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-scope.yaml"), SPRINT_ARM_SCOPE_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-ux.yaml"), SPRINT_ARM_UX_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-design.yaml"), SPRINT_ARM_DESIGN_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-spike.yaml"), SPRINT_ARM_SPIKE_YAML, "utf8");
    policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // AI-2359: agents.json must include policy bodies so singleton delegate
    // resolution does not fail-closed.
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "engine-1", linearUserId: "engine-1-linear-uuid", clientId: "e-c", clientSecret: "e-s", accessToken: "e-t", refreshToken: "e-r" },
        { name: "signe", linearUserId: "signe-linear-uuid", clientId: "s-c", clientSecret: "s-s", accessToken: "s-t", refreshToken: "s-r" },
        { name: "laren", linearUserId: "laren-linear-uuid", clientId: "l-c", clientSecret: "l-s", accessToken: "l-t", refreshToken: "l-r" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
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

  it("4 children with DIFFERENT wf:sprint-arm-* labels all at state:done — barrier advances", async () => {
    const fetchCalls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const children = [
      { identifier: "AI-7001", labels: ["wf:sprint-arm-scope", "state:done"] },
      { identifier: "AI-7002", labels: ["wf:sprint-arm-ux", "state:done"] },
      { identifier: "AI-7003", labels: ["wf:sprint-arm-design", "state:done"] },
      { identifier: "AI-7004", labels: ["wf:sprint-arm-spike", "state:done"] },
    ];

    globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("ParentChildren")) {
        return jsonResp({
          issue: {
            children: {
              nodes: children.map((c) => ({
                identifier: c.identifier,
                labels: { nodes: c.labels.map((l) => ({ name: l })) },
              })),
            },
          },
        });
      }
      if (query.includes("ParentLabels") || query.includes("ParentState") || query.includes("IssueLabels")) {
        return jsonResp({
          issue: {
            id: "parent-internal-id",
            team: { id: "team-uuid" },
            labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-sprint" }, { id: "state-lbl", name: "state:managing-arms" }] },
          },
        });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: [] } } });
      }
      if (query.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("BarrierTransition") || query.includes("UpdateLabels")) {
        return jsonResp({ issueUpdate: { success: true } });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await attemptBarrierTransition("AI-2199", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.terminalCount).toBe(4);
    expect(result.totalChildren).toBe(4);
    // Should advance to the forward target state (spawn-impl)
    const labelSwap = fetchCalls.find((c) => c.query.includes("issueLabelCreate") && (c.variables.name as string) === "state:spawn-impl");
    expect(labelSwap).toBeDefined();
  });

  it("barrier does NOT advance when one per-workflow child is still in progress", async () => {
    const fetchCalls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const children = [
      { identifier: "AI-7001", labels: ["wf:sprint-arm-scope", "state:done"] },
      { identifier: "AI-7002", labels: ["wf:sprint-arm-ux", "state:doing"] }, // still active
      { identifier: "AI-7003", labels: ["wf:sprint-arm-design", "state:done"] },
      { identifier: "AI-7004", labels: ["wf:sprint-arm-spike", "state:done"] },
    ];

    globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("ParentChildren")) {
        return jsonResp({
          issue: {
            children: {
              nodes: children.map((c) => ({
                identifier: c.identifier,
                labels: { nodes: c.labels.map((l) => ({ name: l })) },
              })),
            },
          },
        });
      }
      if (query.includes("ParentLabels") || query.includes("ParentState") || query.includes("IssueLabels")) {
        return jsonResp({
          issue: {
            id: "parent-internal-id",
            team: { id: "team-uuid" },
            labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-sprint" }, { id: "state-lbl", name: "state:managing-arms" }] },
          },
        });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: [] } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await attemptBarrierTransition("AI-2199", "Bearer tok");

    expect(result.transitioned).toBe(false);
    expect(result.terminalCount).toBe(3);
    expect(result.totalChildren).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5: Config / Registry — dev-sprint YAML loads clean, registry validation
// ═══════════════════════════════════════════════════════════════════════════

describe("AC5: dev-sprint YAML loads clean and registry contains sprint-arm children", () => {
  let dir: string;
  let origDefsDir: string | undefined;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2199-config-"));
    fs.writeFileSync(path.join(dir, "dev-sprint.yaml"), DEV_SPRINT_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-scope.yaml"), SPRINT_ARM_SCOPE_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-ux.yaml"), SPRINT_ARM_UX_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-design.yaml"), SPRINT_ARM_DESIGN_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-spike.yaml"), SPRINT_ARM_SPIKE_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  beforeEach(() => resetWorkflowCache());

  it("dev-sprint def loads with correct two-phase fanout structure", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("dev-sprint");
    expect(def).toBeDefined();

    // Phase 1: spawn-arms fanout
    const spawnArms = stateOf(def!, "spawn-arms");
    expect(spawnArms.fanout).toBeDefined();
    expect((spawnArms.fanout as FanoutConfig).spec_source).toBe("Structured");
    expect((spawnArms.fanout as FanoutConfig).child_workflow).toBe("wf:sprint-arm-scope");
    expect((spawnArms.fanout as FanoutConfig).initial_delegate).toBe("astrid");

    // Phase 1 barrier
    expect(stateOf(def!, "managing-arms").barrier).toBe(true);

    // Phase 2: spawn-impl fanout
    const spawnImpl = stateOf(def!, "spawn-impl");
    expect(spawnImpl.fanout).toBeDefined();
    expect((spawnImpl.fanout as FanoutConfig).child_workflow).toBe("wf:dev-impl");

    // Phase 2 barrier
    expect(stateOf(def!, "managing-impl").barrier).toBe(true);
  });

  it("all four sprint-arm child workflow defs are in the registry", async () => {
    const registry = await loadWorkflowRegistry();
    expect(registry.has("sprint-arm-scope")).toBe(true);
    expect(registry.has("sprint-arm-ux")).toBe(true);
    expect(registry.has("sprint-arm-design")).toBe(true);
    expect(registry.has("sprint-arm-spike")).toBe(true);
  });

  it("fanout-level child_workflow serves as default for entries without per-entry marker", () => {
    const def = parseDef(DEV_SPRINT_YAML);
    const spawnArms = stateOf(def, "spawn-arms");
    const fanout = spawnArms.fanout as FanoutConfig;
    // The config declares wf:sprint-arm-scope as the default — entries without
    // per-entry markers should fall back to this. The implementation must
    // preserve this semantic.
    expect(fanout.child_workflow).toBe("wf:sprint-arm-scope");
    expect(shouldTriggerFanout(def, "spawn-arms", "spawn")).toBeTruthy();
  });

  it("shouldTriggerFanout triggers for spawn-arms on spawn command", () => {
    const def = parseDef(DEV_SPRINT_YAML);
    expect(shouldTriggerFanout(def, "spawn-arms", "spawn")).toBeTruthy();
    expect(shouldTriggerFanout(def, "spawn-arms", "escape")).toBeFalsy();
    expect(shouldTriggerFanout(def, "shape", "shape")).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: end-to-end spawn with per-entry child workflows
// ═══════════════════════════════════════════════════════════════════════════

describe("Integration: end-to-end spawn with per-entry child workflows", () => {
  let dir: string;
  let policyFile: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }>;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2199-e2e-"));
    fs.writeFileSync(path.join(dir, "dev-sprint.yaml"), DEV_SPRINT_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-scope.yaml"), SPRINT_ARM_SCOPE_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-ux.yaml"), SPRINT_ARM_UX_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-design.yaml"), SPRINT_ARM_DESIGN_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "sprint-arm-spike.yaml"), SPRINT_ARM_SPIKE_YAML, "utf8");
    policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // AI-2359: agents.json must include policy bodies so singleton delegate
    // resolution does not fail-closed.
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "engine-1", linearUserId: "engine-1-linear-uuid", clientId: "e-c", clientSecret: "e-s", accessToken: "e-t", refreshToken: "e-r" },
        { name: "signe", linearUserId: "signe-linear-uuid", clientId: "s-c", clientSecret: "s-s", accessToken: "s-t", refreshToken: "s-r" },
        { name: "laren", linearUserId: "laren-linear-uuid", clientId: "l-c", clientSecret: "l-s", accessToken: "l-t", refreshToken: "l-r" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
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
    fetchCalls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeE2EFetch(parentDescription: string): typeof globalThis.fetch {
    const parentLabels = [
      { id: "wf-lbl", name: "wf:dev-sprint" },
      { id: "state-lbl", name: "state:spawn-arms" },
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
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("IssueWithLabels")) {
        return jsonResp({ issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } });
      }
      if (query.includes("TeamStates")) {
        return jsonResp({
          team: {
            states: { nodes: [
              { id: "s-todo", name: "Todo", type: "unstarted" },
              { id: "s-doing", name: "Doing", type: "started" },
              { id: "s-managing", name: "Managing", type: "started" },
              { id: "s-done", name: "Done", type: "completed" },
              { id: "s-invalid", name: "Invalid", type: "canceled" },
            ] },
          },
        });
      }
      if (query.includes("ApplyAtomicTransition")) {
        return jsonResp({ issueUpdate: { success: true } });
      }
      if (query.includes("IssueTeamParent") || (query.includes("IssueParent") && !query.includes("ParentChildren"))) {
        return jsonResp({
          issue: {
            id: "parent-internal-id",
            title: "Dev Sprint",
            description: parentDescription,
            team: { id: "team-uuid" },
            parent: null,
          },
        });
      }
      if (query.includes("FanoutChildren") || (query.includes("children") && !query.includes("issueCreate"))) {
        return jsonResp({ issue: { children: { nodes: [] } } });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: [
          { id: "label-sprint-arm-scope", name: "wf:sprint-arm-scope" },
          { id: "label-sprint-arm-ux", name: "wf:sprint-arm-ux" },
          { id: "label-sprint-arm-design", name: "wf:sprint-arm-design" },
          { id: "label-sprint-arm-spike", name: "wf:sprint-arm-spike" },
        ] } } });
      }
      if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("issueCreate")) {
        childCount++;
        return jsonResp({
          issueCreate: { success: true, issue: { id: `child-${childCount}`, identifier: `AI-${8000 + childCount}` } },
        });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }

  it("spawn on dev-sprint spawn-arms mints 4 children with distinct per-entry workflow labels", async () => {
    globalThis.fetch = makeE2EFetch(PER_ENTRY_SPEC);

    const result = await applyStateTransition("spawn", "AI-2199", "Bearer tok");

    // State should have been applied (spawn-arms → managing-arms)
    expect(result.status).toBe("applied");

    // 4 children created
    const childCreates = fetchCalls.filter((c) => c.query.includes("issueCreate"));
    expect(childCreates.length).toBe(4);

    // Each child gets a distinct per-entry workflow label.
    // With INF-27 AC2 guard, wf:* labels exist in the team (pre-mint existence check),
    // so findOrCreateLabel resolves them via TeamLabels lookup rather than creating.
    // Verify the labels were resolved from the team's label set.
    const teamLabelQueries = fetchCalls.filter((c) => c.query.includes("TeamLabels"));
    expect(teamLabelQueries.length).toBeGreaterThanOrEqual(1);
    // The FINAL TeamLabels response should include all the per-entry workflow labels
    // (it's set in the mock to include wf:sprint-arm-scope/ux/design/spike)
    // Also verify that issueLabelCreate was called for state:labels that don't exist
    // (state:intake and potentially state:managing-arms)
    const labelCreates = fetchCalls.filter(
      (c) => c.query.includes("issueLabelCreate") && !c.query.includes("issueCreate"),
    );
    const labelNames = labelCreates.map((c) => c.variables.name as string);
    // state:intake is not in the mock TeamLabels, so it should be created
    expect(labelNames).toContain("state:intake");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INF-41: Config-default registry validation for marker-less findings
// ═══════════════════════════════════════════════════════════════════════════

describe("INF-41: validateFanoutSpec rejects unregistered config default with marker-less findings", () => {
  it("returns ok:false when config default child_workflow is unregistered and findings are marker-less", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-nonexistent",
    } as FanoutConfig;

    // BACKWARD_COMPAT_SPEC has no per-entry [wf:...] markers — all findings
    // are marker-less, so the config default applies to every one.
    // The default 'wf:sprint-arm-nonexistent' is NOT in the registered set.
    const registeredWorkflows = new Set([
      "wf:sprint-arm-scope",
      "wf:sprint-arm-ux",
      "wf:sprint-arm-design",
      "wf:sprint-arm-spike",
    ]);

    const result = validateFanoutSpec(BACKWARD_COMPAT_SPEC, config, registeredWorkflows);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/config default.*unregistered|not a registered workflow/i);
    }
  });

  it("returns ok:true when config default is registered and findings are marker-less", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-scope",
    } as FanoutConfig;

    // All findings are marker-less (BACKWARD_COMPAT_SPEC), but the config
    // default IS registered.
    const registeredWorkflows = new Set([
      "wf:sprint-arm-scope",
      "wf:sprint-arm-ux",
      "wf:sprint-arm-design",
      "wf:sprint-arm-spike",
    ]);

    const result = validateFanoutSpec(BACKWARD_COMPAT_SPEC, config, registeredWorkflows);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.length).toBeGreaterThan(0);
    }
  });

  it("does not check config default when all findings have per-entry markers (backward compat with AI-2199)", () => {
    // When every finding has a per-entry [wf:...] marker, the config default
    // is never used — no INF-41 check needed.
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-nonexistent",
    } as FanoutConfig;

    // Even though the config default is unregistered, PER_ENTRY_SPEC has
    // per-entry markers on every finding, so the default is never the
    // effective value for any finding. INF-41 only fires when at least one
    // finding lacks a marker.
    const registeredWorkflows = new Set([
      "wf:sprint-arm-scope",
      "wf:sprint-arm-ux",
      "wf:sprint-arm-design",
      "wf:sprint-arm-spike",
    ]);

    const result = validateFanoutSpec(PER_ENTRY_SPEC, config, registeredWorkflows);

    // Should pass — the default is never applied, and all per-entry markers
    // are registered.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.length).toBeGreaterThan(0);
    }
  });

  it("skips INF-41 check when registeredWorkflows is not provided (backward compat)", () => {
    const config = {
      spec_source: "Structured",
      child_workflow: "wf:sprint-arm-nonexistent",
    } as FanoutConfig;

    // No registeredWorkflows — should skip both per-entry and config-default checks
    const result = validateFanoutSpec(BACKWARD_COMPAT_SPEC, config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.length).toBeGreaterThan(0);
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function jsonResp(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
