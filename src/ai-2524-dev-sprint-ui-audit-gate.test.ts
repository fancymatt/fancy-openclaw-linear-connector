/**
 * AI-2524 — Dev-sprint integration: conditional ui-audit gate at milestone close.
 *
 * Failing (TDD) tests written BEFORE implementation. These encode the AC of
 * record captured at intake (2026-07-17, astrid-approved). The implementer
 * (igor) makes them pass; the test author does not implement.
 *
 * ── AC → test map ─────────────────────────────────────────────────────────
 *   AC1 dev-sprint.yaml post-validation state ... "post-validation state exists"
 *   AC1 conditional spawn_if:ui-impact ........... "conditional spawn_if on post-validation"
 *   AC1 ui-audit child_workflow ................. "child_workflow resolves to ui-audit"
 *   AC1 validation→post-validation edge ........ "validation→post-validation transition"
 *   AC1 post-validation→done edge ............... "post-validation→done transition"
 *   AC2 milestone-close template ................ "ms-close template comment includes visual audit"
 *   AC3 hard rule vault doc ..................... "hard rule documented in vault spec"
 */

import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import {
  resetWorkflowCache,
  loadWorkflowDefById,
  type WorkflowDef,
  type FanoutConfig,
} from "./workflow-gate.js";

// ── Constants ──────────────────────────────────────────────────────────────

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const DEV_SPRINT_PATH = path.join(REGISTERED_DEFS_DIR, "dev-sprint.yaml");
const UI_AUDIT_PATH = path.join(REGISTERED_DEFS_DIR, "ui-audit.yaml");

// ── Types the implementation should export ─────────────────────────────────
// AI-2523 (merged): SpawnIfConfig is now in the engine. The dev-sprint YAML
// uses it; these tests assert the YAML shape + engine loading accepts it.

// ═══════════════════════════════════════════════════════════════════════════
// AC1: dev-sprint.yaml post-validation state with conditional ui-audit spawn
// ═══════════════════════════════════════════════════════════════════════════

describe("AC1: dev-sprint.yaml post-validation state", () => {
  let devSprint: WorkflowDef;

  beforeAll(() => {
    const raw = fs.readFileSync(DEV_SPRINT_PATH, "utf8");
    devSprint = yamlLoad(raw) as WorkflowDef;
  });

  it("dev-sprint.yaml is parseable and has the expected id", () => {
    expect(devSprint).toBeDefined();
    expect(devSprint.id).toBe("dev-sprint");
    expect(devSprint.version).toBeDefined();
  });

  // ── state existence ──────────────────────────────────────────────────

  it("includes a post-validation state between validation and done", () => {
    const stateIds = devSprint.states.map((s) => s.id);
    expect(stateIds).toContain("validation");
    expect(stateIds).toContain("post-validation");
    expect(stateIds).toContain("done");

    const valIndex = stateIds.indexOf("validation");
    const pvIndex = stateIds.indexOf("post-validation");
    const doneIndex = stateIds.indexOf("done");

    // post-validation sits between validation and done
    expect(pvIndex).toBeGreaterThan(valIndex);
    expect(pvIndex).toBeLessThan(doneIndex);
  });

  // ── validation→post-validation transition ────────────────────────────

  it("validation state transitions to post-validation on approve", () => {
    const validation = devSprint.states.find((s) => s.id === "validation");
    expect(validation).toBeDefined();
    expect(validation!.transitions).toBeDefined();

    // The `approve` command in validation should route to `post-validation`
    // instead of directly to `done`.
    const approveTransition = validation!.transitions!.find(
      (t) => t.command === "approve",
    );
    expect(approveTransition).toBeDefined();
    expect(approveTransition!.to).toBe("post-validation");
  });

  // ── post-validation state shape ──────────────────────────────────────

  it("post-validation state is owned by steward (gate evaluator)", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    expect(pvState).toBeDefined();
    expect(pvState!.owner_role).toBe("steward");
  });

  it("post-validation state is a normal (non-barrier, non-terminal) state", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    expect(pvState!.barrier).not.toBe(true);
    expect(pvState!.kind).not.toBe("terminal");
  });

  it("post-validation state has a native_state set to a valid engagement value", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    expect(pvState!.native_state).toBeTruthy();
    // The connector cycles this; but it should be a known projection
    expect(["todo", "doing", "thinking"]).toContain(pvState!.native_state);
  });

  // ── fanout + spawn_if ────────────────────────────────────────────────

  it("post-validation state declares a fanout block", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    expect(pvState!.fanout).toBeDefined();
  });

  it("post-validation fanout child_workflow is wf:ui-audit", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    const fanout = pvState!.fanout as FanoutConfig;
    expect(fanout.child_workflow).toBe("wf:ui-audit");
  });

  it("post-validation fanout uses findings-based spec_source for cardinality", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    const fanout = pvState!.fanout as FanoutConfig;
    expect(fanout.spec_source).toBeTruthy();
    expect(typeof fanout.spec_source).toBe("string");
  });

  it("post-validation fanout includes spawn_if: { label_present: 'ui-impact' }", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    const fanout = pvState!.fanout as FanoutConfig;
    expect(fanout.spawn_if).toBeDefined();
    expect(fanout.spawn_if!.label_present).toBe("ui-impact");
  });

  it("post-validation fanout spawn_if scope is closed_children (default, ok if absent)", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    const fanout = pvState!.fanout as FanoutConfig;
    if (fanout.spawn_if!.scope !== undefined) {
      expect(fanout.spawn_if!.scope).toBe("closed_children");
    }
  });

  // ── post-validation→done transition ──────────────────────────────────

  it("post-validation state transitions to done via continue", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    const continueTransition = pvState!.transitions!.find(
      (t) => t.command === "continue" && t.to === "done",
    );
    expect(continueTransition).toBeDefined();
  });

  it("post-validation continue→done does NOT require human signoff (AI handles gate)", () => {
    const pvState = devSprint.states.find((s) => s.id === "post-validation");
    const continueTransition = pvState!.transitions!.find(
      (t) => t.command === "continue" && t.to === "done",
    );
    // The sign-off is already captured at the validation→approve step.
    // The post-validation gate is mechanical (check labels, spawn or skip).
    expect(continueTransition).toBeDefined();
    expect((continueTransition as Record<string, unknown>).requires_human_signoff_above_stakes).not.toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1b: dev-sprint.yaml loads through the engine without validation errors
// ═══════════════════════════════════════════════════════════════════════════

describe("AC1b: dev-sprint.yaml engine loading with post-validation state", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("loadWorkflowDefById('dev-sprint') succeeds and returns the updated def", async () => {
    const def = await loadWorkflowDefById("dev-sprint");
    expect(def).not.toBeNull();
    expect(def!.id).toBe("dev-sprint");

    // Verify the post-validation state loaded from the YAML
    const pvState = def!.states.find((s) => s.id === "post-validation");
    expect(pvState).toBeDefined();

    // Verify the fanout config parsed correctly (spawn_if included)
    const fanout = pvState!.fanout as FanoutConfig;
    expect(fanout.spawn_if).toBeDefined();
    expect(fanout.spawn_if!.label_present).toBe("ui-impact");
    expect(fanout.child_workflow).toBe("wf:ui-audit");
  });

  it("dev-sprint def version is bumped (or annotated) for this change", () => {
    // The dev-sprint def header says v2 as of 2026-07-16.
    // Adding a new state = structural change → version bump or last-updated comment.
    // Re-read from file to check the raw YAML metadata
    const raw = fs.readFileSync(DEV_SPRINT_PATH, "utf8");
    const parsed = yamlLoad(raw) as WorkflowDef;

    // The version must be > 2 since that was the v2 spec deployed for INF-40
    expect(parsed.version).toBeGreaterThan(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1c: validation state approve→post-validation (no longer direct to done)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC1c: validation state approves to post-validation, not directly to done", () => {
  let devSprint: WorkflowDef;

  beforeAll(() => {
    const raw = fs.readFileSync(DEV_SPRINT_PATH, "utf8");
    devSprint = yamlLoad(raw) as WorkflowDef;
  });

  it("validation state still exists (no states removed)", () => {
    const stateIds = devSprint.states.map((s) => s.id);
    expect(stateIds).toContain("validation");
  });

  it("validation state has exactly one approve transition (to post-validation)", () => {
    const validation = devSprint.states.find((s) => s.id === "validation");
    const approveTransitions = validation!.transitions!.filter(
      (t) => t.command === "approve",
    );
    expect(approveTransitions.length).toBe(1);
    expect(approveTransitions[0].to).toBe("post-validation");
  });

  it("validation state still has the reject transition to ac-definition (intact)", () => {
    const validation = devSprint.states.find((s) => s.id === "validation");
    const rejectTransition = validation!.transitions!.find(
      (t) => t.command === "reject",
    );
    expect(rejectTransition).toBeDefined();
    expect(rejectTransition!.to).toBe("ac-definition");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2: Milestone close verification template includes visual audit section
// ═══════════════════════════════════════════════════════════════════════════

describe("AC2: milestone close verification template visual audit section", () => {
  // The milestone close template is emitted as a comment by the connector when
  // a sprint reaches post-validation. The implementer should add a structured
  // comment template that includes the visual audit breakpoint table and the
  // sign-off checkbox.

  it("the sprint workflow marks the comment location where the ms-close template includes the visual audit section", () => {
    // The implementer must add a comment template section or a comment factory
    // that produces the visual audit checklist. This test reads the comment
    // template source to verify the visual audit section exists.
    //
    // Expected location: the dev-sprint workflow's post-validation state handler
    // or a dedicated comment template file. For now, we test that the YAML has
    // a `milestone_close_template` or `close_comment` annotation on the
    // post-validation state.
    const raw = fs.readFileSync(DEV_SPRINT_PATH, "utf8");
    expect(raw).toMatch(/visual audit|Visual Audit|visual-audit|VISUAL_AUDIT/i);
  });

  // ── Integration test: describe the contract the implementer fulfills ──
  // These are pointer tests: they describe the OUTPUT the implementer must
  // produce. The specific implementation (comment template string, template
  // file, YAML annotation) is up to the implementer.

  it("the milestone-close template checks that a visual audit section exists in the comment output", () => {
    // At runtime, the sprint steward produces a milestone-close verification
    // comment. This test verifies that the codebase contains a template
    // producing:
    //
    //   ### Visual Audit
    //
    //   | Breakpoint | Screens Audited | Verdict | Reviewer |
    //   |-----------|-----------------|---------|----------|
    //   | Desktop (>=1280px) | N | ✓ pass / ✗ fail | [name] |
    //   | Tablet (768px) | N | ✓ pass / ✗ fail | [name] |
    //   | Mobile (375px) | N | ✓ pass / ✗ fail | [name] |
    //
    //   Visual audit ticket: [UI-AUDIT-XXX](link)
    //
    // We search production source files (NOT test files) for the template.
    const srcDir = path.resolve(process.cwd(), "src");
    const allSrcFiles: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name));
        } else if (
          entry.isFile() &&
          /\.(ts|js|yaml|yml)$/.test(entry.name) &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".test.js")
        ) {
          allSrcFiles.push(path.join(dir, entry.name));
        }
      }
    }
    walk(srcDir);

    // Search for the visual audit table template in production source files
    const auditFiles = allSrcFiles.filter((f) => {
      const content = fs.readFileSync(f, "utf8");
      return (
        content.includes("Visual Audit") &&
        content.includes("Breakpoint") &&
        content.includes("Desktop")
      );
    });

    expect(auditFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("the milestone-close template includes a sign-off checkbox for visual audit", () => {
    const srcDir = path.resolve(process.cwd(), "src");
    const allSrcFiles: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name));
        } else if (
          entry.isFile() &&
          /\.(ts|js|yaml|yml)$/.test(entry.name) &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".test.js")
        ) {
          allSrcFiles.push(path.join(dir, entry.name));
        }
      }
    }
    walk(srcDir);

    // Look for sign-off checkbox text matching the spec:
    //   - [ ] Visual audit passed (or waived: no ui-impact tickets in sprint)
    const signoffFiles = allSrcFiles.filter((f) => {
      const content = fs.readFileSync(f, "utf8");
      return content.includes("Visual audit passed") || content.includes("visual audit passed");
    });

    expect(signoffFiles.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3: The hard rule is documented in the sprint workflow spec (vault doc)
// ═══════════════════════════════════════════════════════════════════════════
//
// CI safety: these tests check a vault-mounted spec doc. The vault is only
// available in the dev container / on the host — never on CI runners. We
// detect vault availability at module load time and skip the entire describe
// block when vault is absent, so CI is not blocked by environment fixtures.

const possibleVaultPaths = [
  // Direct vault mount (dev container)
  "/home/node/obsidian-vault/life-os/project-management/workflows/dev-sprint/dev-sprint-workflow-spec.md",
  // Host path fallback
  "/home/fancymatt/obsidian-vault/life-os/project-management/workflows/dev-sprint/dev-sprint-workflow-spec.md",
  // Alternative possible paths
  "/home/node/obsidian-vault/life-os/project-management/workflows/dev-sprint-workflow-spec.md",
  "/home/fancymatt/obsidian-vault/life-os/project-management/workflows/dev-sprint-workflow-spec.md",
];

const VAULT_SPEC_AVAILABLE = possibleVaultPaths.some((p) => fs.existsSync(p));

const vaultDescribe = VAULT_SPEC_AVAILABLE ? describe : describe.skip;

vaultDescribe("AC3: hard rule documented in vault sprint workflow spec", () => {
  // The canonical vault spec is at:
  //   life-os/project-management/workflows/dev-sprint/dev-sprint-workflow-spec.md
  // This is mounted read-only in the dev container at:
  //   /home/node/obsidian-vault/life-os/project-management/workflows/dev-sprint/dev-sprint-workflow-spec.md
  //

  let vaultSpecPath: string | null = null;
  let vaultSpecContent: string | null = null;

  beforeAll(() => {
    for (const p of possibleVaultPaths) {
      if (fs.existsSync(p)) {
        vaultSpecPath = p;
        vaultSpecContent = fs.readFileSync(p, "utf8");
        break;
      }
    }
  });

  it("the vault sprint workflow spec file exists", () => {
    expect(vaultSpecPath).not.toBeNull();
    expect(vaultSpecContent).not.toBeNull();
  });

  it("the spec contains the ui-audit gate hard rule (spec §5)", () => {
    expect(vaultSpecContent).toBeTruthy();

    // §5 hard rule content from the spec:
    // "A user-facing sprint does not close on code review alone. Visual
    //  rendering must be verified at multiple breakpoints. The ui-audit
    //  ticket's verdict is a gate input to milestone close."
    const hardRulePhrases = [
      "does not close on code review alone",
      "Visual rendering must be verified",
      "multiple breakpoints",
      "ui-audit ticket's verdict",
      "gate input to milestone close",
    ];

    for (const phrase of hardRulePhrases) {
      expect(vaultSpecContent!).toMatch(
        new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      );
    }
  });

  it("the spec references the ui-impact label as the trigger for the gate", () => {
    expect(vaultSpecContent!).toMatch(/ui-impact/i);
  });

  it("the spec version is updated to reflect the ui-audit gate addition", () => {
    // Check that the spec has been updated with a v3 or later marker, or
    // a last-updated date after 2026-07-16 (when v2 was deployed)
    expect(vaultSpecContent!).toMatch(/v3|2026-07-1[7-9]|2026-07-2[0-9]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: Full spine — all registered defs still load with the change
// ═══════════════════════════════════════════════════════════════════════════

describe("Integration: all registered defs load correctly with updated dev-sprint", () => {
  beforeAll(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  it("all registered defs still load without errors", async () => {
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    expect(registry.has("dev-sprint")).toBe(true);
    expect(registry.has("ui-audit")).toBe(true);
    expect(registry.has("dev-impl")).toBe(true);
    expect(registry.has("sprint-spawner")).toBe(true);
  });

  it("the ui-audit def still loads correctly (no regression)", async () => {
    const uiAudit = await loadWorkflowDefById("ui-audit");
    expect(uiAudit).not.toBeNull();
    expect(uiAudit!.id).toBe("ui-audit");
    expect(uiAudit!.states.find((s) => s.id === "intake")).toBeDefined();
    expect(uiAudit!.states.find((s) => s.id === "done")).toBeDefined();
  });
});
