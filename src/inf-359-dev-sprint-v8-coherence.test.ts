/**
 * INF-359 - dev-sprint v8 sprint coherence.
 *
 * Failing tests written before implementation. AC map:
 * - AC1: product-definition refuses without a capability statement.
 * - AC2: ac-definition rejects unclassified implementation entries.
 * - AC3: spawn-impl auto-creates integration-verify children blocked by components.
 * - AC4: validation requires demonstration-walk evidence.
 * - AC5: INF-42 conformance stays green for registered defs.
 * - E2E: the sprint spine cannot reach done without capability statement +
 *   passed demonstration walk gates.
 */

import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, expect, it } from "@jest/globals";
import { validateAllRegisteredDefs } from "./workflow-conformance.js";
import { validateFanoutSpec } from "./fanout.js";
import type { FanoutConfig, WorkflowDef, WorkflowState, WorkflowTransition } from "./workflow-gate.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const DEV_SPRINT_PATH = path.join(REGISTERED_DEFS_DIR, "dev-sprint.yaml");

type V8Transition = WorkflowTransition & {
  requires_capability_statement?: boolean;
  requires_demonstration_walk?: boolean;
};

type V8FanoutConfig = FanoutConfig & {
  classification_required?: boolean;
  classification_field?: string;
  allowed_classifications?: string[];
  standalone_share_nudge_above?: number;
  integration_verify?: {
    child_workflow: string;
    per_capability: boolean;
    blocked_by: string;
  };
};

function loadDevSprint(): WorkflowDef {
  return yamlLoad(fs.readFileSync(DEV_SPRINT_PATH, "utf8")) as WorkflowDef;
}

function state(def: WorkflowDef, id: string): WorkflowState {
  const found = def.states.find((s) => s.id === id);
  expect(found).toBeDefined();
  return found!;
}

function transition(def: WorkflowDef, stateId: string, command: string): V8Transition {
  const found = state(def, stateId).transitions?.find((t) => t.command === command);
  expect(found).toBeDefined();
  return found as V8Transition;
}

describe("INF-359 AC1: product-definition capability statement gate", () => {
  it("product-definition continue declares a capability-statement refusal gate", () => {
    const def = loadDevSprint();
    const tx = transition(def, "product-definition", "continue");

    expect(tx.requires_capability_statement).toBe(true);
  });
});

describe("INF-359 AC2: ac-definition implementation spec classification", () => {
  const classifiedSpec = `
## Findings

- **API enforcement**: classification: traces-to-capability; capability: sprint coherence; add engine gate.
- **Documentation cleanup**: classification: declared-standalone; update operator docs.
`;

  const unclassifiedSpec = `
## Findings

- **API enforcement**: add engine gate.
- **Documentation cleanup**: update operator docs.
`;

  it("spawn-impl fanout requires classification metadata on each entry", () => {
    const def = loadDevSprint();
    const fanout = state(def, "spawn-impl").fanout as V8FanoutConfig;

    expect(fanout.classification_required).toBe(true);
    expect(fanout.classification_field).toBe("classification");
    expect(fanout.allowed_classifications).toEqual([
      "traces-to-capability",
      "declared-standalone",
    ]);
    expect(typeof fanout.standalone_share_nudge_above).toBe("number");
  });

  it("validateFanoutSpec rejects unclassified impl entries before child creation", () => {
    const config = {
      spec_source: "Findings",
      child_workflow: "wf:dev-impl",
      classification_required: true,
      classification_field: "classification",
      allowed_classifications: ["traces-to-capability", "declared-standalone"],
    } as V8FanoutConfig;

    const rejected = validateFanoutSpec(unclassifiedSpec, config);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toMatch(/classification|unclassified/i);
    }

    const accepted = validateFanoutSpec(classifiedSpec, config);
    expect(accepted.ok).toBe(true);
  });
});

describe("INF-359 AC3: integration-verify children for capabilities", () => {
  it("registered defs include an integration-verify workflow target", () => {
    expect(fs.existsSync(path.join(REGISTERED_DEFS_DIR, "integration-verify.yaml"))).toBe(true);
  });

  it("spawn-impl declares one integration-verify child per capability blocked by component tickets", () => {
    const def = loadDevSprint();
    const fanout = state(def, "spawn-impl").fanout as V8FanoutConfig;

    expect(fanout.integration_verify).toEqual({
      child_workflow: "wf:integration-verify",
      per_capability: true,
      blocked_by: "capability-components",
    });
  });
});

describe("INF-359 AC4: validation demonstration-walk evidence gate", () => {
  it("validation approve requires a passed demonstration walk, not only Done children", () => {
    const def = loadDevSprint();
    const tx = transition(def, "validation", "approve");

    expect(tx.requires_demonstration_walk).toBe(true);
  });
});

describe("INF-359 AC5: registered dev-sprint definitions remain INF-42 conformant", () => {
  it("validateAllRegisteredDefs is green for the registered-defs directory", () => {
    const results = validateAllRegisteredDefs(REGISTERED_DEFS_DIR);
    const failures = results.filter((r) => !r.valid);

    expect(failures).toEqual([]);
  });
});

describe("INF-359 E2E: sprint spine cannot close without v8 coherence gates", () => {
  it("the registered dev-sprint path has both required close blockers before done", () => {
    const def = loadDevSprint();
    const productContinue = transition(def, "product-definition", "continue");
    const validationApprove = transition(def, "validation", "approve");
    const stateIds = def.states.map((s) => s.id);

    expect(stateIds).toEqual(expect.arrayContaining([
      "product-definition",
      "spawn-impl",
      "validation",
      "done",
    ]));
    expect(productContinue.requires_capability_statement).toBe(true);
    expect(validationApprove.requires_demonstration_walk).toBe(true);
  });
});
