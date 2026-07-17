/**
 * INF-42 — Workflow def conformance: registered-defs invariant validation.
 *
 * Failing (TDD) tests written BEFORE implementation. These encode the AC of
 * record captured at intake (2026-07-17, astrid-approved topology). The
 * implementer (igor) makes them pass; the test author does not implement.
 *
 * ── Topology (Astrid-approved 2026-07-17) ─────────────────────────────────
 *   (c) + partial (a): validator ships in-repo, reads from src/registered-defs/
 *   in CI and WORKFLOW_DEFS_DIR on the host. Deploy gate = diff check.
 *
 * ── AC → test map ─────────────────────────────────────────────────────────
 *   AC1 registered-defs dir exist ........ "registered-defs directory exists"
 *   AC2 engine-loader validation .......... "all defs load through the engine"
 *   AC3 barrier:true invariant ........... "barrier invariant per state"
 *   AC4 fanout before barrier invariant .. "fanout before barrier invariant"
 *   AC5 waiver mechanism ................. "invariant_skip waiver mechanism"
 *   AC6 inline fixture tests ............. "external fixture tests"
 *   AC7 child_workflow resolution ........ "fanout.child_workflow resolution"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  resetWorkflowCache,
  loadWorkflowRegistry,
  loadWorkflowDefById,
  type WorkflowDef,
  type WorkflowState,
  type FanoutConfig,
} from "./workflow-gate.js";

// ── Constants ──────────────────────────────────────────────────────────────

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const FIXTURES_DEFS_DIR = path.resolve(process.cwd(), "src/__fixtures__");

// ── Helper: validator API contract ─────────────────────────────────────────
//
// These tests drive a WORKFLOW CONFORMANCE VALIDATOR that does NOT yet exist.
// The intended API is:
//
//   src/workflow-conformance.ts (SHALL be created by implementer):
//
//     export interface ConformanceResult {
//       defId: string;
//       file: string;
//       valid: boolean;
//       errors: ConformanceError[];
//     }
//
//     export interface ConformanceError {
//       invariant: string;
//       message: string;
//       state?: string;
//     }
//
//     ACCEPTED_WAIVER_KEYS: readonly string[];
//
//     export function validateWorkflowDef(def: WorkflowDef, file?: string): ConformanceResult;
//
//     export function validateAllRegisteredDefs(dir?: string): ConformanceResult[];
//
//   For now, the tests assert expected behavior by calling these functions.
//   The implementer must create src/workflow-conformance.ts with the above
//   exports before these tests can compile and pass.
//
// ── Invariants ─────────────────────────────────────────────────────────────
//   1. barrier: true must be declared on states whose transitions lead into a
//      barrier. (The engine reads barrier: true directly from the state def,
//      never deriving from native_state: managing.)
//   2. Every path leading into a barrier: true state must be preceded by a
//      fanout: on the immediate predecessor.
//   3. Accepted waiver keys: "barrier-before-managing", "fanout-before-barrier".
//   4. Unrecognized waiver keys cause a hard validation failure.
//   5. fanout.child_workflow must resolve to a registered def.

import {
  validateWorkflowDef,
  validateAllRegisteredDefs,
  ACCEPTED_WAIVER_KEYS,
  type ConformanceResult,
  type ConformanceError,
} from "./workflow-conformance.js";

// ═══════════════════════════════════════════════════════════════════════════
// AC1: Registered-defs snapshot exists in-repo
// ═══════════════════════════════════════════════════════════════════════════

describe("AC1: registered-defs snapshot exists in-repo", () => {
  it("src/registered-defs/ directory exists and contains YAML files", () => {
    expect(fs.existsSync(REGISTERED_DEFS_DIR)).toBe(true);
    const entries = fs.readdirSync(REGISTERED_DEFS_DIR);
    expect(entries.length).toBeGreaterThan(0);
    const yamls = entries.filter((f) => f.endsWith(".yaml"));
    expect(yamls.length).toBeGreaterThan(0);
  });

  it("every file in src/registered-defs/ is a parseable YAML workflow def", () => {
    const entries = fs.readdirSync(REGISTERED_DEFS_DIR).filter((f) => f.endsWith(".yaml"));
    for (const file of entries) {
      const fullPath = path.join(REGISTERED_DEFS_DIR, file);
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = yamlLoad(raw);
      expect(parsed).toBeTruthy();
      expect(typeof parsed).toBe("object");
      expect((parsed as Record<string, unknown>).id).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: All registered defs load through the engine loader
// ═══════════════════════════════════════════════════════════════════════════

describe("AC2: all registered defs load through the engine loader", () => {
  let origDefsDir: string | undefined;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("loadWorkflowRegistry loads every def in src/registered-defs/", async () => {
    const registry = await loadWorkflowRegistry();
    expect(registry.size).toBeGreaterThan(0);

    const entries = fs.readdirSync(REGISTERED_DEFS_DIR).filter((f) => f.endsWith(".yaml"));
    for (const file of entries) {
      const fullPath = path.join(REGISTERED_DEFS_DIR, file);
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = yamlLoad(raw) as { id: string };
      expect(registry.has(parsed.id)).toBe(true);
    }
  });

  it("each loaded def passes schema validation — no throw on load", async () => {
    // loadWorkflowRegistry already validates each def (native_state, fanout/barrier).
    // If any def fails, the registry throws — so a successful load == schema passed.
    const registry = await loadWorkflowRegistry();
    for (const [id, def] of registry) {
      expect(def).toBeDefined();
      expect(def.id).toBe(id);
      expect(Array.isArray(def.states)).toBe(true);
      expect(def.states.length).toBeGreaterThan(0);
    }
  });

  it("loadWorkflowDefById finds each registered def by its id", async () => {
    const registry = await loadWorkflowRegistry();
    for (const id of registry.keys()) {
      const def = await loadWorkflowDefById(id);
      expect(def).not.toBeNull();
      expect(def!.id).toBe(id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3: Structural invariant — barrier states declare barrier: true
// ═══════════════════════════════════════════════════════════════════════════

describe("AC3: barrier invariant — barrier states declare barrier: true", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("validateWorkflowDef passes on defs with correct barrier:true declarations", async () => {
    const registry = await loadWorkflowRegistry();
    for (const [id, def] of registry) {
      const result = validateWorkflowDef(def);
      // Barrier-relevant errors should not appear for canonical defs
      const barrierErrors = result.errors.filter(
        (e) => e.invariant === "barrier-before-managing",
      );
      // The def may have a waiver; only fail if errors exist AND no waiver covers them
      const hasWaiver = Array.isArray((def as Record<string, unknown>).invariant_skip) &&
        ((def as Record<string, unknown>).invariant_skip as string[]).includes("barrier-before-managing");
      if (!hasWaiver) {
        expect(barrierErrors).toHaveLength(0);
      }
    }
  });

  it("detects missing barrier:true on a state that should have it", () => {
    // This is the core invariant: a def where a state whose transitions
    // target a next state that should be a barrier but is NOT declared.
    //
    // The validator checks: for every state in every registered def,
    // barrier: true must be explicitly declared where the engine expects it
    // (the engine reads `state.barrier === true`, never `native_state: managing`).
    const def: WorkflowDef = {
      id: "ac3-missing-barrier",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "spawning" }],
        },
        {
          id: "spawning",
          owner_role: "engine",
          fanout: { spec_source: "findings", child_workflow: "wf:dev-impl" },
          transitions: [{ command: "spawn", to: "managing" }],
        },
        {
          id: "managing",
          owner_role: "engine",
          // MISSING: barrier: true — this is the defect
          transitions: [{ command: "complete", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const barrierErrors = result.errors.filter(
      (e) => e.invariant === "barrier-before-managing",
    );
    expect(barrierErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });

  it("detects barrier:true = false explicitly (not just missing)", () => {
    // Same defect expressed as explicit false instead of absent
    const def: WorkflowDef = {
      id: "ac3-barrier-false",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "spawning" }],
        },
        {
          id: "spawning",
          owner_role: "engine",
          fanout: { spec_source: "findings", child_workflow: "wf:dev-impl" },
          transitions: [{ command: "spawn", to: "managing" }],
        },
        {
          id: "managing",
          owner_role: "engine",
          barrier: false, // Explicit false — still a defect
          transitions: [{ command: "complete", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const barrierErrors = result.errors.filter(
      (e) => e.invariant === "barrier-before-managing",
    );
    expect(barrierErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4: Structural invariant — fanout before barrier
// ═══════════════════════════════════════════════════════════════════════════

describe("AC4: fanout before barrier invariant", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("validateWorkflowDef passes on defs with correct fanout-before-barrier", async () => {
    const registry = await loadWorkflowRegistry();
    for (const [id, def] of registry) {
      const result = validateWorkflowDef(def);
      const fanoutErrors = result.errors.filter(
        (e) => e.invariant === "fanout-before-barrier",
      );
      const hasWaiver = Array.isArray((def as Record<string, unknown>).invariant_skip) &&
        ((def as Record<string, unknown>).invariant_skip as string[]).includes("fanout-before-barrier");
      if (!hasWaiver) {
        expect(fanoutErrors).toHaveLength(0);
      }
    }
  });

  it("detects missing fanout before barrier state without waiver", () => {
    // A def where a barrier state is reachable from a non-fanout predecessor
    const def: WorkflowDef = {
      id: "ac4-missing-fanout",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "managing" }],
        },
        {
          id: "managing",
          owner_role: "engine",
          barrier: true,
          // MISSING: any path into managing has a fanout — intake has none
          transitions: [{ command: "complete", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const fanoutErrors = result.errors.filter(
      (e) => e.invariant === "fanout-before-barrier",
    );
    expect(fanoutErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });

  it("detects multiple paths to barrier where one lacks fanout", () => {
    // Barrier reachable from two predecessors; only one has a fanout
    const def: WorkflowDef = {
      id: "ac4-partial-fanout",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [
            { command: "accept", to: "spawning" },
            { command: "direct", to: "managing" }, // No fanout before managing
          ],
        },
        {
          id: "spawning",
          owner_role: "engine",
          fanout: { spec_source: "findings", child_workflow: "wf:dev-impl" },
          transitions: [{ command: "spawn", to: "managing" }],
        },
        {
          id: "managing",
          owner_role: "engine",
          barrier: true,
          transitions: [{ command: "complete", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const fanoutErrors = result.errors.filter(
      (e) => e.invariant === "fanout-before-barrier",
    );
    expect(fanoutErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5: Waiver mechanism — invariant_skip in def schema
// ═══════════════════════════════════════════════════════════════════════════

describe("AC5: invariant_skip waiver mechanism", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("ACCEPTED_WAIVER_KEYS contains the known waiver keys", () => {
    expect(ACCEPTED_WAIVER_KEYS).toContain("barrier-before-managing");
    expect(ACCEPTED_WAIVER_KEYS).toContain("fanout-before-barrier");
  });

  it("waived fanout-before-barrier passes validation despite missing fanout", () => {
    const def: WorkflowDef = {
      id: "ac5-waived-fanout",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      // @ts-expect-error — invariant_skip is a recognized top-level key
      invariant_skip: ["fanout-before-barrier"],
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "managing" }],
        },
        {
          id: "managing",
          owner_role: "engine",
          barrier: true,
          // No fanout predecessor — but the invariant_skip waives this check
          transitions: [{ command: "complete", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const fanoutErrors = result.errors.filter(
      (e) => e.invariant === "fanout-before-barrier",
    );
    expect(fanoutErrors).toHaveLength(0);
    // Other invariants should still pass (or at least not fail from this waiver)
    expect(result.valid).toBe(true);
  });

  it("waived barrier-before-managing suppresses that invariant only", () => {
    const def: WorkflowDef = {
      id: "ac5-waived-barrier",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      // @ts-expect-error — invariant_skip is a recognized top-level key
      invariant_skip: ["barrier-before-managing"],
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "managing" }],
        },
        {
          id: "managing",
          owner_role: "engine",
          // barrier: true missing, but waived
          transitions: [{ command: "complete", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const barrierErrors = result.errors.filter(
      (e) => e.invariant === "barrier-before-managing",
    );
    expect(barrierErrors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it("unrecognized waiver key causes hard validation failure", () => {
    const def: WorkflowDef = {
      id: "ac5-unknown-waiver",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      // @ts-expect-error — invariant_skip type may not include typos
      invariant_skip: ["nonexistent-invariant", "also-not-real"],
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const waiverErrors = result.errors.filter(
      (e) => e.invariant === "invariant_skip",
    );
    expect(waiverErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
    // The error should name the unrecognized keys
    const allMessages = result.errors.map((e) => e.message).join(" ");
    expect(allMessages).toMatch(/nonexistent-invariant/);
    expect(allMessages).toMatch(/also-not-real/);
  });

  it("unrecognized waiver key alongside valid keys still fails", () => {
    // Valid waiver + typo should still fail — no silent third category
    const def: WorkflowDef = {
      id: "ac5-mixed-waiver",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      // @ts-expect-error — one valid key, one unrecognized
      invariant_skip: ["fanout-before-barrier", "typo-waiver"],
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def);
    const waiverErrors = result.errors.filter(
      (e) => e.invariant === "invariant_skip",
    );
    expect(waiverErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6: External fixture tests exercise the validator (fast, CI-safe)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC6: external fixture tests (fast, CI-safe)", () => {
  // ── Helper: write a temp fixture to disk ────────────────────────────────
  function writeDef(dir: string, filename: string, yamlContent: string): string {
    const full = path.join(dir, filename);
    fs.writeFileSync(full, yamlContent, "utf8");
    return full;
  }

  function makeWorkflowYaml(id: string, extraStates: Record<string, unknown>[]): string {
    const states = extraStates.length > 0
      ? extraStates.map((s) => {
          const lines = [`  - id: ${s.id}`];
          if (s.owner_role) lines.push(`    owner_role: ${s.owner_role}`);
          if (s.kind) lines.push(`    kind: ${s.kind}`);
          if (s.native_state) lines.push(`    native_state: ${s.native_state}`);
          if (s.barrier !== undefined) lines.push(`    barrier: ${s.barrier}`);
          if (s.fanout) {
            lines.push(`    fanout:`);
            lines.push(`      spec_source: ${(s.fanout as Record<string, unknown>).spec_source}`);
            lines.push(`      child_workflow: ${(s.fanout as Record<string, unknown>).child_workflow}`);
          }
          if (s.transitions) {
            lines.push(`    transitions:`);
            for (const t of s.transitions as Array<Record<string, unknown>>) {
              const parts = [`      - command: ${t.command}`];
              if (t.to) parts.push(`        to: ${t.to}`);
              lines.push(parts.join("\n"));
            }
          }
          return lines.join("\n");
        })
      : [];

    return [
      `id: ${id}`,
      "version: 1",
      `archetype: orchestrator`,
      `entry_state: ${extraStates[0]?.id ?? "intake"}`,
      "break_glass:",
      "  command: escape",
      "  to: escape",
      "  owner_role: steward",
      "states:",
      ...states,
    ].join("\n");
  }

  let tmpDir: string;
  let origDefsDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-42-ac6-"));
    process.env.WORKFLOW_DEFS_DIR = tmpDir;
    resetWorkflowCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("valid def passes all invariants", () => {
    const yaml = makeWorkflowYaml("ac6-valid", [
      {
        id: "intake",
        owner_role: "steward",
        transitions: [{ command: "accept", to: "spawning" }],
      },
      {
        id: "spawning",
        owner_role: "engine",
        fanout: { spec_source: "findings", child_workflow: "wf:dev-impl" },
        transitions: [{ command: "spawn", to: "managing" }],
      },
      {
        id: "managing",
        owner_role: "engine",
        barrier: true,
        transitions: [{ command: "complete", to: "done" }],
      },
      { id: "done", kind: "terminal" },
    ]);

    const parsed = yamlLoad(yaml) as WorkflowDef;
    const result = validateWorkflowDef(parsed);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("def with waived invariant passes validation", () => {
    const yaml = [
      "id: ac6-waived",
      "version: 1",
      "archetype: orchestrator",
      "entry_state: intake",
      "invariant_skip:",
      "  - fanout-before-barrier",
      "break_glass:",
      "  command: escape",
      "  to: escape",
      "  owner_role: steward",
      "states:",
      "  - id: intake",
      "    owner_role: steward",
      "    transitions:",
      "      - command: accept",
      "        to: managing",
      "  - id: managing",
      "    owner_role: engine",
      "    barrier: true",
      "    transitions:",
      "      - command: complete",
      "        to: done",
      "  - id: done",
      "    kind: terminal",
    ].join("\n");

    const parsed = yamlLoad(yaml) as WorkflowDef;
    const result = validateWorkflowDef(parsed);
    // The fanout-before-barrier is waived, so the def should be valid
    expect(result.valid).toBe(true);
  });

  it("unrecognized waiver key causes hard failure", () => {
    const yaml = [
      "id: ac6-bad-waiver",
      "version: 1",
      "archetype: orchestrator",
      "entry_state: intake",
      "invariant_skip:",
      "  - not-a-real-invariant",
      "break_glass:",
      "  command: escape",
      "  to: escape",
      "  owner_role: steward",
      "states:",
      "  - id: intake",
      "    owner_role: steward",
      "    transitions:",
      "      - command: accept",
      "        to: done",
      "  - id: done",
      "    kind: terminal",
    ].join("\n");

    const parsed = yamlLoad(yaml) as WorkflowDef;
    const result = validateWorkflowDef(parsed);
    expect(result.valid).toBe(false);
    const waiverErrors = result.errors.filter((e) => e.invariant === "invariant_skip");
    expect(waiverErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("missing barrier:true on a barrier state causes hard failure", () => {
    const yaml = [
      "id: ac6-no-barrier",
      "version: 1",
      "archetype: orchestrator",
      "entry_state: intake",
      "break_glass:",
      "  command: escape",
      "  to: escape",
      "  owner_role: steward",
      "states:",
      "  - id: intake",
      "    owner_role: steward",
      "    transitions:",
      "      - command: accept",
      "        to: spawning",
      "  - id: spawning",
      "    owner_role: engine",
      "    fanout:",
      "      spec_source: findings",
      "      child_workflow: wf:dev-impl",
      "    transitions:",
      "      - command: spawn",
      "        to: managing",
      "  - id: managing",
      "    owner_role: engine",
      // NOTE: no barrier: true — this IS the defect
      "    transitions:",
      "      - command: complete",
      "        to: done",
      "  - id: done",
      "    kind: terminal",
    ].join("\n");

    const parsed = yamlLoad(yaml) as WorkflowDef;
    const result = validateWorkflowDef(parsed);
    expect(result.valid).toBe(false);
    const barrierErrors = result.errors.filter((e) => e.invariant === "barrier-before-managing");
    expect(barrierErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("missing fanout before barrier without waiver causes hard failure", () => {
    const yaml = [
      "id: ac6-no-fanout",
      "version: 1",
      "archetype: orchestrator",
      "entry_state: intake",
      "break_glass:",
      "  command: escape",
      "  to: escape",
      "  owner_role: steward",
      "states:",
      "  - id: intake",
      "    owner_role: steward",
      "    transitions:",
      "      - command: accept",
      "        to: managing",
      "  - id: managing",
      "    owner_role: engine",
      "    barrier: true",
      // intake → managing has no fanout — this is the defect
      "    transitions:",
      "      - command: complete",
      "        to: done",
      "  - id: done",
      "    kind: terminal",
    ].join("\n");

    const parsed = yamlLoad(yaml) as WorkflowDef;
    const result = validateWorkflowDef(parsed);
    expect(result.valid).toBe(false);
    const fanoutErrors = result.errors.filter((e) => e.invariant === "fanout-before-barrier");
    expect(fanoutErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("nonexistent registered-defs directory produces graceful error, not crash", () => {
    // Temporarily switch to a nonexistent directory
    const badDir = path.join(os.tmpdir(), "nonexistent-registered-defs-" + Date.now());
    const prevDir = process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEFS_DIR = badDir;
    resetWorkflowCache();

    // The registry should throw on unreadable dir, but validateAllRegisteredDefs
    // should handle this gracefully
    const results = validateAllRegisteredDefs(badDir);
    // Either empty results or a reported error — never a crash
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results.some((r) => !r.valid)).toBe(true);
      // Some error should reference the directory
      const allMessages = results.map((r) => r.errors.map((e) => e.message).join(" ")).join(" ");
      expect(allMessages.length).toBeGreaterThan(0);
    }

    // Restore
    process.env.WORKFLOW_DEFS_DIR = prevDir;
    resetWorkflowCache();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7: fanout.child_workflow resolution (companion engine ticket)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC7: fanout.child_workflow resolution", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("validateWorkflowDef checks that fanout.child_workflow resolves to a registered def", async () => {
    const registry = await loadWorkflowRegistry();
    const registeredIds = new Set(registry.keys());

    for (const [id, def] of registry) {
      const result = validateWorkflowDef(def, id);
      const childWfErrors = result.errors.filter(
        (e) => e.invariant === "child-workflow-resolution",
      );
      expect(childWfErrors).toHaveLength(0);
    }
  });

  it("detects fanout.child_workflow that does not resolve to a registered def", () => {
    // A def referencing a workflow that doesn't exist in the registry
    const def: WorkflowDef = {
      id: "ac7-unresolved-child",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "spawning" }],
        },
        {
          id: "spawning",
          owner_role: "engine",
          fanout: { spec_source: "findings", child_workflow: "wf:nonexistent-workflow" },
          transitions: [{ command: "spawn", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def, "ac7-unresolved-child");
    const childWfErrors = result.errors.filter(
      (e) => e.invariant === "child-workflow-resolution",
    );
    expect(childWfErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });

  it("non-wf prefixed child_workflow is rejected (wf: prefix required)", () => {
    const def: WorkflowDef = {
      id: "ac7-non-wf-prefix",
      version: 1,
      archetype: "orchestrator",
      entry_state: "intake",
      states: [
        {
          id: "intake",
          owner_role: "steward",
          transitions: [{ command: "accept", to: "spawning" }],
        },
        {
          id: "spawning",
          owner_role: "engine",
          // child_workflow missing wf: prefix — this is the existing fanout config rule
          fanout: { spec_source: "findings", child_workflow: "dev-impl" },
          transitions: [{ command: "spawn", to: "done" }],
        },
        { id: "done", kind: "terminal" },
      ],
    };

    const result = validateWorkflowDef(def, "ac7-non-wf-prefix");
    const childWfErrors = result.errors.filter(
      (e) => e.invariant === "child-workflow-resolution",
    );
    // Should fail because the prefix is required by the fanout config validation
    // in loadDefFromFile. Our validator also catches this.
    expect(childWfErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: validateAllRegisteredDefs on live registered-defs directory
// ═══════════════════════════════════════════════════════════════════════════

describe("validateAllRegisteredDefs — full directory sweep", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("all registered defs pass validation", () => {
    const results = validateAllRegisteredDefs(REGISTERED_DEFS_DIR);
    expect(results.length).toBeGreaterThan(0);
    const invalid = results.filter((r) => !r.valid);
    if (invalid.length > 0) {
      const summary = invalid
        .map((r) => `${r.defId} (${r.file}): ${r.errors.map((e) => e.message).join("; ")}`)
        .join("\n");
      expect(invalid).toHaveLength(0);
    }
  });
});
