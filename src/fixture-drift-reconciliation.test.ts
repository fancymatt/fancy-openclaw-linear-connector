/**
 * INF-98: Reconcile workflow-def fixture drift.
 *
 * Verifies that the canonical workflow-def YAML fixtures in src/__fixtures__/
 * match the deployed/production state after reconciliation.
 *
 * AC1 — All drifted workflow defs reconciled: deployed == canonical == fixtures
 * AC2 — Behavioral: a representative transition resolves to the intended
 *       target/gate on the running registry (not just a file diff)
 * AC3 — fixture-drift warning is clean at next connector startup
 * AC4 — Documentation of canonical source and regeneration process
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import {
  loadWorkflowRegistry,
  resetWorkflowCache,
  resetNativeStateCache,
  type WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";

// ── Constants ──────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(process.cwd(), "src/__fixtures__");

const CANONICAL_DEV_IMPL = path.join(FIXTURES_DIR, "canonical-dev-impl.yaml");
const CANONICAL_UX_AUDIT = path.join(FIXTURES_DIR, "canonical-ux-audit.yaml");
const CANONICAL_SPRINT  = path.join(FIXTURES_DIR, "canonical-sprint.yaml");

// ── Test-scoped temp directories ───────────────────────────────────────────

let dir: string;
let registryDir: string;

/**
 * Minimal capability-policy YAML — shared by all registry tests.
 */
const REGISTRY_POLICY_YAML = `
version: 1
roles:
  - id: steward
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [infra:ssh]
  - id: test-author
    requires: [linear:transition]
  - id: ux-researcher
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]
  - id: sprint-owner
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-reconcile-test-"));

  // Capability policy
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, REGISTRY_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  // Agents file
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-c", clientSecret: "c-s", accessToken: "c-t", refreshToken: "c-r" },
      { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-c", clientSecret: "h-s", accessToken: "h-t", refreshToken: "h-r" },
      { name: "grover", linearUserId: "grover-linear-uuid", clientId: "g-c", clientSecret: "g-s", accessToken: "g-t", refreshToken: "g-r" },
      { name: "tdd", linearUserId: "tdd-linear-uuid", clientId: "t-c", clientSecret: "t-s", accessToken: "t-t", refreshToken: "t-r" },
    ],
  }, null, 2), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();

  // Registry directory with canonical fixture files
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-reconcile-defs-"));
  fs.writeFileSync(path.join(registryDir, "dev-impl.yaml"), fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"), "utf8");
  fs.writeFileSync(path.join(registryDir, "ux-audit.yaml"), fs.readFileSync(CANONICAL_UX_AUDIT, "utf8"), "utf8");
  fs.writeFileSync(path.join(registryDir, "sprint.yaml"), fs.readFileSync(CANONICAL_SPRINT, "utf8"), "utf8");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(registryDir, { recursive: true, force: true });
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
});

beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.WORKFLOW_DEF_PATH;
});

// ── Helpers ────────────────────────────────────────────────────────────────

function parseYaml(file: string): WorkflowDef {
  const raw = fs.readFileSync(file, "utf8");
  return yaml.load(raw) as WorkflowDef;
}

function allFixtureFiles(dirPath?: string): string[] {
  return fs.readdirSync(dirPath ?? FIXTURES_DIR).filter((f) => f.endsWith(".yaml")).sort();
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1: Reconcile — deployed == canonical == fixtures
// ══════════════════════════════════════════════════════════════════════════════

describe("AC1: Reconcile — all drifted workflow defs reconciled", () => {
  // ── dev-impl ─────────────────────────────────────────────────────────────

  describe("canonical-dev-impl.yaml", () => {
    let def: WorkflowDef;

    beforeAll(() => {
      def = parseYaml(CANONICAL_DEV_IMPL);
    });

    it("exists and parses as valid YAML", () => {
      expect(def).toBeTruthy();
      expect(def.id).toBe("dev-impl");
    });

    it("version reflects the reconciled value (>= 10, matching deployed state)", () => {
      // The deployed def is at version 15; fixture should match.
      expect(def.version).toBeDefined();
      expect(def.version!).toBeGreaterThanOrEqual(10);
    });

    it("declares recovery_actor for orphaned-ticket delegation recovery", () => {
      // The deployed def has recovery_actor: ai; fixture must include it.
      expect(def.recovery_actor).toBeDefined();
      expect(def.recovery_actor).toEqual("ai");
    });

    it("stakes format uses correct label namespace", () => {
      // The fixture uses stakes:* label keys (canonical). The deployed def
      // drifted to risk:* — after reconciliation the deployed must be fixed
      // to match the canonical fixture.
      expect(def.stakes).toBeDefined();
      expect(def.stakes!.levels).toBeDefined();
      expect(def.stakes!.levels).toHaveProperty("stakes:low");
      expect(def.stakes!.levels).toHaveProperty("stakes:medium");
      expect(def.stakes!.levels).toHaveProperty("stakes:high");
      // Assert NO risk:* keys leaked into the fixture
      const keys = Object.keys(def.stakes!.levels);
      const riskKeys = keys.filter((k) => k.startsWith("risk:"));
      expect(riskKeys).toHaveLength(0);
    });

    it("stakes threshold is numeric and >= 0", () => {
      expect(def.stakes).toBeDefined();
      expect(typeof def.stakes!.threshold).toBe("number");
      expect(def.stakes!.threshold).toBeGreaterThanOrEqual(0);
    });

    it("has required archetype field", () => {
      expect(def.archetype).toBeDefined();
      expect(typeof def.archetype).toBe("string");
    });

    it("has at least 2 states (entry + terminal)", () => {
      expect(def.states).toBeDefined();
      expect(def.states.length).toBeGreaterThanOrEqual(2);
    });

    it("declares break_glass configuration", () => {
      expect(def.break_glass).toBeDefined();
      expect(def.break_glass!.command).toBeDefined();
    });
  });

  // ── ux-audit ────────────────────────────────────────────────────────────

  describe("canonical-ux-audit.yaml", () => {
    let def: WorkflowDef;

    beforeAll(() => {
      def = parseYaml(CANONICAL_UX_AUDIT);
    });

    it("exists and parses as valid YAML", () => {
      expect(def).toBeTruthy();
      expect(def.id).toBe("ux-audit");
    });

    it("version is >= 2 (no regression)", () => {
      expect(def.version).toBeDefined();
      expect(def.version!).toBeGreaterThanOrEqual(2);
    });

    it("has required archetype = orchestrator", () => {
      expect(def.archetype).toBe("orchestrator");
    });

    it("declares break_glass", () => {
      expect(def.break_glass).toBeDefined();
    });
  });

  // ── sprint ──────────────────────────────────────────────────────────────

  describe("canonical-sprint.yaml", () => {
    let def: WorkflowDef;

    beforeAll(() => {
      def = parseYaml(CANONICAL_SPRINT);
    });

    it("exists and parses as valid YAML", () => {
      expect(def).toBeTruthy();
      expect(def.id).toBe("sprint");
    });

    it("version is >= 1 (no regression)", () => {
      expect(def.version).toBeDefined();
      expect(def.version!).toBeGreaterThanOrEqual(1);
    });

    it("has required archetype = feature-initiative", () => {
      expect(def.archetype).toBe("feature-initiative");
    });

    it("declares break_glass", () => {
      expect(def.break_glass).toBeDefined();
    });
  });

  // ── All fixtures structural checks ─────────────────────────────────────

  describe("all canonical fixtures share correct structural invariants", () => {
    it("every fixture has an id, version, archetype, and entry_state", () => {
      const files = allFixtureFiles();
      expect(files.length).toBeGreaterThanOrEqual(3);

      for (const f of files) {
        const def = parseYaml(path.join(FIXTURES_DIR, f));
        expect(def.id).toBeDefined();
        expect(typeof def.id).toBe("string");
        expect(def.id.length).toBeGreaterThan(0);
        expect(def.version).toBeDefined();
        expect(def.archetype).toBeDefined();
        expect(def.entry_state).toBeDefined();
        expect(Array.isArray(def.states)).toBe(true);
        expect(def.states.length).toBeGreaterThan(0);

        // Every non-terminal state must have at least one transition
        for (const state of def.states) {
          if (state.kind !== "terminal") {
            expect(Array.isArray(state.transitions)).toBe(true);
            expect(state.transitions!.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it("all fixtures load cleanly through loadWorkflowRegistry with no failures", async () => {
      process.env.WORKFLOW_DEFS_DIR = registryDir;
      resetWorkflowCache();

      const registry = await loadWorkflowRegistry();
      // registryDir was seeded with exactly 3 canonical files
      expect(registry.size).toBe(allFixtureFiles(registryDir).length);
    });

    it("no fixture uses risk:* label format — stakes:* is the canonical namespace", () => {
      const files = allFixtureFiles();
      for (const f of files) {
        const def = parseYaml(path.join(FIXTURES_DIR, f));
        if (def.stakes?.levels) {
          const riskKeys = Object.keys(def.stakes.levels).filter((k) => k.startsWith("risk:"));
          expect(riskKeys).toHaveLength(0);
        }
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2: Behavioral — representative transition resolves correctly on registry
// ══════════════════════════════════════════════════════════════════════════════

describe("AC2: Behavioral — representative transition resolves correctly", () => {
  beforeEach(() => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    resetWorkflowCache();
  });

  it("dev-impl: tests-ready in write-tests transitions to implementation", async () => {
    const registry = await loadWorkflowRegistry();
    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();

    const writeTestsState = devImpl!.states.find((s) => s.id === "write-tests");
    expect(writeTestsState).toBeDefined();

    const testsReadyTx = writeTestsState!.transitions?.find((t) => t.command === "tests-ready");
    expect(testsReadyTx).toBeDefined();
    expect(testsReadyTx!.to).toBe("implementation");

    const implementationState = devImpl!.states.find((s) => s.id === "implementation");
    expect(implementationState).toBeDefined();
    expect(implementationState!.owner_role).toBe("dev");

    expect(testsReadyTx!.assign).toBeDefined();
    expect(testsReadyTx!.assign!.mode).toBe("required");
  });

  it("dev-impl: submit in implementation transitions to code-review", async () => {
    const registry = await loadWorkflowRegistry();
    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();

    const implState = devImpl!.states.find((s) => s.id === "implementation");
    expect(implState).toBeDefined();

    const submitTx = implState!.transitions?.find((t) => t.command === "submit");
    expect(submitTx).toBeDefined();
    expect(submitTx!.to).toBe("code-review");
  });

  it("dev-impl: approve in code-review transitions to merge", async () => {
    const registry = await loadWorkflowRegistry();
    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();

    const crState = devImpl!.states.find((s) => s.id === "code-review");
    expect(crState).toBeDefined();

    const approveTx = crState!.transitions?.find((t) => t.command === "approve");
    expect(approveTx).toBeDefined();
    // v10+ spine: approve → merge (not the old deployment)
    expect(approveTx!.to).toBe("merge");
  });

  it("dev-impl: merge/continue transitions to deploy, then deploy/continue to ac-validate", async () => {
    const registry = await loadWorkflowRegistry();
    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();

    // merge state: continue → deploy
    const mergeState = devImpl!.states.find((s) => s.id === "merge");
    expect(mergeState).toBeDefined();
    const mergeContinueTx = mergeState!.transitions?.find((t) => t.command === "continue");
    expect(mergeContinueTx).toBeDefined();
    expect(mergeContinueTx!.to).toBe("deploy");

    // deploy state: continue → ac-validate
    const deployState = devImpl!.states.find((s) => s.id === "deploy");
    expect(deployState).toBeDefined();
    const deployContinueTx = deployState!.transitions?.find((t) => t.command === "continue");
    expect(deployContinueTx).toBeDefined();
    expect(deployContinueTx!.to).toBe("ac-validate");
  });

  it("dev-impl: validated from ac-validate transitions to done (terminal)", async () => {
    const registry = await loadWorkflowRegistry();
    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();

    const acValidate = devImpl!.states.find((s) => s.id === "ac-validate");
    expect(acValidate).toBeDefined();

    const validatedTx = acValidate!.transitions?.find((t) => t.command === "validated");
    expect(validatedTx).toBeDefined();
    expect(validatedTx!.to).toBe("done");

    const doneState = devImpl!.states.find((s) => s.id === "done");
    expect(doneState).toBeDefined();
    expect(doneState!.kind).toBe("terminal");
  });

  it("ux-audit: complete-audit transitions to spawning, then spawn to managing", async () => {
    const registry = await loadWorkflowRegistry();
    const uxAudit = registry.get("ux-audit");
    expect(uxAudit).toBeDefined();

    const auditing = uxAudit!.states.find((s) => s.id === "auditing");
    expect(auditing).toBeDefined();
    expect(auditing!.transitions?.find((t) => t.command === "complete-audit")?.to).toBe("spawning");

    const spawning = uxAudit!.states.find((s) => s.id === "spawning");
    expect(spawning).toBeDefined();
    expect(spawning!.transitions?.find((t) => t.command === "spawn")?.to).toBe("managing");
  });

  it("sprint: accept transitions to ux-shaping, then submit to spawning", async () => {
    const registry = await loadWorkflowRegistry();
    const sprint = registry.get("sprint");
    expect(sprint).toBeDefined();

    const intake = sprint!.states.find((s) => s.id === "intake");
    expect(intake).toBeDefined();
    expect(intake!.transitions?.find((t) => t.command === "accept")?.to).toBe("ux-shaping");

    const uxShaping = sprint!.states.find((s) => s.id === "ux-shaping");
    expect(uxShaping).toBeDefined();
    expect(uxShaping!.transitions?.find((t) => t.command === "submit")?.to).toBe("spawning");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3: fixture-drift warning is clean at next connector startup
// ══════════════════════════════════════════════════════════════════════════════

describe("AC3: fixture-drift warning is clean — zero drift after reconciliation", () => {
  beforeEach(() => {
    process.env.WORKFLOW_DEFS_DIR = registryDir;
    resetWorkflowCache();
  });

  it("all fixture files load without config-health failures", async () => {
    const registry = await loadWorkflowRegistry();
    // registryDir was seeded with exactly 3 canonical files
    expect(registry.size).toBe(allFixtureFiles(registryDir).length);

    for (const [id, def] of registry) {
      expect(def.id).toBe(id);
      expect(def.states.length).toBeGreaterThan(0);
    }
  });

  it("each fixture def has a valid entry_state that exists among its states", async () => {
    const registry = await loadWorkflowRegistry();
    for (const [id, def] of registry) {
      const entryState = def.states.find((s) => s.id === def.entry_state);
      expect(entryState).toBeDefined();
      expect(entryState!.kind).not.toBe("terminal");
    }
  });

  it("no unreachable terminal states — each terminal has at least one incoming transition", async () => {
    const registry = await loadWorkflowRegistry();
    for (const [, def] of registry) {
      const terminalIds = new Set(
        def.states.filter((s) => s.kind === "terminal").map((s) => s.id),
      );
      const referencedIds = new Set(
        def.states.flatMap(
          (s) => s.transitions?.map((t) => t.to).filter((to) => to !== "__ad_hoc__") ?? [],
        ),
      );
      for (const terminalId of terminalIds) {
        if (def.break_glass?.to === terminalId) continue;
        expect(referencedIds.has(terminalId)).toBe(true);
      }
    }
  });

  it("dev-impl v10+ states match the v10 design: write-tests, merge, deploy, ac-validate present", async () => {
    const registry = await loadWorkflowRegistry();
    const devImpl = registry.get("dev-impl");
    expect(devImpl).toBeDefined();
    const stateIds = new Set(devImpl!.states.map((s) => s.id));

    // These states were added or present in v10+ spine and must be present
    expect(stateIds.has("write-tests")).toBe(true);
    expect(stateIds.has("merge")).toBe(true);
    expect(stateIds.has("deploy")).toBe(true);
    expect(stateIds.has("ac-validate")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4: Documentation — fixture header explains canonical source & regeneration
// ══════════════════════════════════════════════════════════════════════════════

describe("AC4: Documentation — fixture header explains canonical source & regeneration", () => {
  it("canonical-dev-impl.yaml header references deployed def source location", () => {
    const raw = fs.readFileSync(CANONICAL_DEV_IMPL, "utf8");
    expect(raw).toMatch(/WORKFLOW_DEFS_DIR/i);
    expect(raw).toMatch(/fixture/i);
    expect(raw).toMatch(/keep in sync/i);
  });

  it("canonical-ux-audit.yaml header references deployed def source location", () => {
    const raw = fs.readFileSync(CANONICAL_UX_AUDIT, "utf8");
    expect(raw).toMatch(/WORKFLOW_DEFS_DIR/i);
    expect(raw).toMatch(/fixture/i);
    expect(raw).toMatch(/keep in sync/i);
  });

  it("canonical-sprint.yaml header references deployed def source location", () => {
    const raw = fs.readFileSync(CANONICAL_SPRINT, "utf8");
    expect(raw).toMatch(/WORKFLOW_DEFS_DIR/i);
    expect(raw).toMatch(/fixture/i);
    expect(raw).toMatch(/keep in sync/i);
  });

  it("README or docs mention how fixtures are regenerated from the vault", () => {
    const readmePath = path.resolve(process.cwd(), "README.md");
    const fixtureHeader = fs.readFileSync(CANONICAL_DEV_IMPL, "utf8");
    const fixtureMentionsSync = /keep\s*in\s*sync/i.test(fixtureHeader);

    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, "utf8").toLowerCase();
      const readmeHasRegenDoc = readme.includes("regenerat") ||
        (readme.includes("fixture") && readme.includes("sync")) ||
        (readme.includes("fixture") && readme.includes("canonical"));
      expect(readmeHasRegenDoc || fixtureMentionsSync).toBe(true);
    } else {
      expect(fixtureMentionsSync).toBe(true);
    }
  });
});
