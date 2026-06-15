/**
 * AI-1544 / G-13 — Rejection messages must name the correct legal command set.
 *
 * G-9 (AI-1543) verified that wrong-state rejections name the legal command set.
 * G-13 extends that invariant to every other illegal-cell block reason:
 *   cap-missing · wrong-delegate · human-signoff · unknown-caller
 *
 * AC1: illegal-cell assertions fail if the legal set in the rejection message is
 *      wrong/empty. Each parametric test below maps one block reason to the full
 *      set of cells with that reason, and asserts every legal command appears in
 *      the rejection.
 *
 * AC2: at least one regression test proves a stale/empty legal set is caught.
 *      The "stale-set regression" describe block constructs an extended def with a
 *      new command, confirms the matrix captures it in legalCommands, calls
 *      checkWorkflowRules, and asserts the rejection contains the new command.
 *      A hardcoded or omitted legal set would fail this test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  buildConformanceMatrix,
  type ConformanceCell,
  type CapabilityPolicyInput,
} from "./conformance-matrix.js";
import {
  checkWorkflowRules,
  resetWorkflowCache,
  resetNativeStateCache,
  type WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { resetConfigHealth } from "./config-health.js";
import { clearImplementerStore } from "./implementer-store.js";
import { clearArtifactStore } from "./artifact-store.js";

// ── Fixtures (same 4-state workflow as AI-1543 / G-9) ────────────────────────

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

stakes:
  threshold: 2
  levels:
    stakes:low: 0
    stakes:medium: 1
    stakes:high: 2

break_glass:
  command: escape
  to: escape
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
        assign: { mode: required }
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        assign:
          mode: required
          constraint: not-implementer

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: deployment
        assign: { mode: auto }
      - command: request-changes
        to: implementation

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
        requires_human_signoff_above_stakes: true
        assign: { mode: auto }
      - command: reject
        to: implementation

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
    transitions:
      - command: unescape
        to: intake
        assign: { mode: auto }
`;

const TEST_POLICY_YAML = `
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

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: dev
    fills_roles: [dev, code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
`;

const TEST_AGENTS = {
  agents: [
    { name: "igor",     linearUserId: "igor-uuid",     clientId: "ig-c", clientSecret: "ig-s", accessToken: "ig-t", refreshToken: "ig-r" },
    { name: "charles",  linearUserId: "charles-uuid",  clientId: "ch-c", clientSecret: "ch-s", accessToken: "ch-t", refreshToken: "ch-r" },
    { name: "hanzo",    linearUserId: "hanzo-uuid",    clientId: "ha-c", clientSecret: "ha-s", accessToken: "ha-t", refreshToken: "ha-r" },
    { name: "astrid",   linearUserId: "astrid-uuid",   clientId: "as-c", clientSecret: "as-s", accessToken: "as-t", refreshToken: "as-r" },
    { name: "reviewer", linearUserId: "reviewer-uuid", clientId: "rv-c", clientSecret: "rv-s", accessToken: "rv-t", refreshToken: "rv-r" },
  ],
};

const testDef = yaml.load(TEST_WORKFLOW_YAML) as WorkflowDef;
const testPolicy = yaml.load(TEST_POLICY_YAML) as CapabilityPolicyInput;

// ── Mock team states ──────────────────────────────────────────────────────────

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid",    name: "Todo",    type: "unstarted" },
  { id: "state-doing-uuid",   name: "Doing",   type: "started" },
  { id: "state-done-uuid",    name: "Done",    type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

function makeCellFetch(
  workflowId: string,
  state: string,
  delegateLinearUserId: string | null,
  stakeLabel: string | null,
): typeof globalThis.fetch {
  const labelNames = [
    `wf:${workflowId}`,
    `state:${state}`,
    ...(stakeLabel ? [stakeLabel] : []),
  ];
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: MOCK_TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({ data: { issue: { branch: null, pullRequests: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("delegate")) {
      return new Response(
        JSON.stringify({ data: { issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
          delegate: delegateLinearUserId ? { id: delegateLinearUserId } : null,
        }}}),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ data: { issue: { labels: { nodes: labelNames.map((name) => ({ name })) } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ── Test environment ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "g13-test-"));

  const policyFile = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(tmpDir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(tmpDir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(TEST_AGENTS, null, 2), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.WORKFLOW_DEFS_DIR;
});

beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  clearAcRecordStore();
  resetConfigHealth();
  clearImplementerStore();
  clearArtifactStore();
});

// ── Pre-compute cell subsets for AC1 ─────────────────────────────────────────

const allCells = buildConformanceMatrix(testDef, testPolicy);

const capMissingCells = allCells.filter(
  (c) => c.expected === "block" && c.blockReason === "cap-missing",
);

const wrongDelegateCells = allCells.filter(
  (c) => c.expected === "block" && c.blockReason === "wrong-delegate",
);

const humanSignoffCells = allCells.filter(
  (c) => c.expected === "block" && c.blockReason === "human-signoff",
);

const unknownCallerCells = allCells.filter(
  (c) => c.expected === "block" && c.blockReason === "unknown-caller",
);

// ── AC1: cap-missing rejections name the legal command set ────────────────────

describe("G-13 AC1: cap-missing rejection names every legal command", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("at least one cap-missing cell exists for this test to be meaningful", () => {
    expect(capMissingCells.length).toBeGreaterThan(0);
  });

  it.each(capMissingCells)(
    "cap-missing names legal set: state=$state command=$command caller=$caller.bodyId stakes=$flags.stakeLabel",
    async (cell) => {
      globalThis.fetch = makeCellFetch(
        testDef.id,
        cell.state,
        cell.flags.delegateLinearUserId ?? null,
        cell.flags.stakeLabel,
      );
      const result = await checkWorkflowRules(
        cell.command,
        "issue-uuid",
        "Bearer tok",
        cell.caller.bodyId,
        null,
        cell.caller.linearUserId ?? null,
      );
      expect(result).not.toBeNull();
      for (const legalCmd of cell.legalCommands) {
        expect(result).toContain(legalCmd);
      }
    },
  );
});

// ── AC1: wrong-delegate rejections name the legal command set ─────────────────

describe("G-13 AC1: wrong-delegate rejection names every legal command", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("at least one wrong-delegate cell exists for this test to be meaningful", () => {
    expect(wrongDelegateCells.length).toBeGreaterThan(0);
  });

  it.each(wrongDelegateCells)(
    "wrong-delegate names legal set: state=$state command=$command caller=$caller.bodyId stakes=$flags.stakeLabel",
    async (cell) => {
      globalThis.fetch = makeCellFetch(
        testDef.id,
        cell.state,
        cell.flags.delegateLinearUserId ?? null,
        cell.flags.stakeLabel,
      );
      const result = await checkWorkflowRules(
        cell.command,
        "issue-uuid",
        "Bearer tok",
        cell.caller.bodyId,
        null,
        cell.caller.linearUserId ?? null,
      );
      expect(result).not.toBeNull();
      for (const legalCmd of cell.legalCommands) {
        expect(result).toContain(legalCmd);
      }
    },
  );
});

// ── AC1: human-signoff rejections name the legal command set ──────────────────

describe("G-13 AC1: human-signoff rejection names every legal command", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("at least one human-signoff cell exists for this test to be meaningful", () => {
    expect(humanSignoffCells.length).toBeGreaterThan(0);
  });

  it.each(humanSignoffCells)(
    "human-signoff names legal set: state=$state command=$command caller=$caller.bodyId stakes=$flags.stakeLabel",
    async (cell) => {
      globalThis.fetch = makeCellFetch(
        testDef.id,
        cell.state,
        cell.flags.delegateLinearUserId ?? null,
        cell.flags.stakeLabel,
      );
      const result = await checkWorkflowRules(
        cell.command,
        "issue-uuid",
        "Bearer tok",
        cell.caller.bodyId,
        null,
        cell.caller.linearUserId ?? null,
      );
      expect(result).not.toBeNull();
      for (const legalCmd of cell.legalCommands) {
        expect(result).toContain(legalCmd);
      }
    },
  );
});

// ── AC1: unknown-caller rejections name the legal command set ─────────────────

describe("G-13 AC1: unknown-caller rejection names every legal command", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("at least one unknown-caller cell exists for this test to be meaningful", () => {
    expect(unknownCallerCells.length).toBeGreaterThan(0);
  });

  it.each(unknownCallerCells)(
    "unknown-caller names legal set: state=$state command=$command stakes=$flags.stakeLabel",
    async (cell) => {
      globalThis.fetch = makeCellFetch(
        testDef.id,
        cell.state,
        cell.flags.delegateLinearUserId ?? null,
        cell.flags.stakeLabel,
      );
      const result = await checkWorkflowRules(
        cell.command,
        "issue-uuid",
        "Bearer tok",
        cell.caller.bodyId,
        null,
        null,
      );
      expect(result).not.toBeNull();
      for (const legalCmd of cell.legalCommands) {
        expect(result).toContain(legalCmd);
      }
    },
  );
});

// ── AC2: regression — stale/empty legal set is caught ────────────────────────
//
// These tests extend the def with a new command not present in the base fixture.
// They confirm:
//   a) buildConformanceMatrix includes the new command in legalCommands for the state.
//   b) checkWorkflowRules's rejection message contains the new command.
//
// A stale or hardcoded legal set (not derived from the live def) would fail (b)
// when the def is extended. The tests therefore catch both "no legal set at all"
// and "legal set was correct once but was not re-derived from the updated def."

describe("G-13 AC2: stale/empty legal set is caught", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // Extend the 'deployment' state with a new command that no existing message hardcodes.
  const NEW_COMMAND = "rollback-g13";
  const extendedDef: WorkflowDef = {
    ...testDef,
    states: testDef.states.map((s) => {
      if (s.id === "deployment") {
        return {
          ...s,
          transitions: [
            ...(s.transitions ?? []),
            { command: NEW_COMMAND, to: "implementation" },
          ],
        };
      }
      return s;
    }),
  };

  it("the extended matrix captures the new command in legalCommands for 'deployment' cells", () => {
    const matrix = buildConformanceMatrix(extendedDef, testPolicy);
    const deploymentCells = matrix.filter((c) => c.state === "deployment");
    expect(deploymentCells.length).toBeGreaterThan(0);
    for (const cell of deploymentCells) {
      expect(cell.legalCommands).toContain(NEW_COMMAND);
    }
  });

  it("wrong-delegate rejection in extended def names the new command (catches stale messages)", async () => {
    const matrix = buildConformanceMatrix(extendedDef, testPolicy);
    const cell = matrix.find(
      (c) =>
        c.state === "deployment" &&
        c.expected === "block" &&
        c.blockReason === "wrong-delegate" &&
        c.flags.stakeLabel === null,
    );
    expect(cell).toBeDefined();
    expect(cell!.legalCommands).toContain(NEW_COMMAND);

    // Write the extended def to disk so checkWorkflowRules uses it.
    const extendedDefPath = path.join(tmpDir, "dev-impl.yaml");
    fs.writeFileSync(extendedDefPath, yaml.dump(extendedDef), "utf8");
    resetWorkflowCache();
    resetNativeStateCache();

    globalThis.fetch = makeCellFetch(
      extendedDef.id,
      cell!.state,
      cell!.flags.delegateLinearUserId ?? null,
      cell!.flags.stakeLabel,
    );

    const result = await checkWorkflowRules(
      cell!.command,
      "issue-uuid",
      "Bearer tok",
      cell!.caller.bodyId,
      null,
      cell!.caller.linearUserId ?? null,
    );
    expect(result).not.toBeNull();
    expect(result).toContain(NEW_COMMAND);

    // Restore the original def.
    fs.writeFileSync(extendedDefPath, TEST_WORKFLOW_YAML, "utf8");
    resetWorkflowCache();
    resetNativeStateCache();
  });

  it("cap-missing rejection in extended def names the new command (catches stale messages)", async () => {
    const matrix = buildConformanceMatrix(extendedDef, testPolicy);
    const cell = matrix.find(
      (c) =>
        c.state === "deployment" &&
        c.expected === "block" &&
        c.blockReason === "cap-missing" &&
        c.flags.stakeLabel === null,
    );
    expect(cell).toBeDefined();
    expect(cell!.legalCommands).toContain(NEW_COMMAND);

    const extendedDefPath = path.join(tmpDir, "dev-impl.yaml");
    fs.writeFileSync(extendedDefPath, yaml.dump(extendedDef), "utf8");
    resetWorkflowCache();
    resetNativeStateCache();

    globalThis.fetch = makeCellFetch(
      extendedDef.id,
      cell!.state,
      cell!.flags.delegateLinearUserId ?? null,
      cell!.flags.stakeLabel,
    );

    const result = await checkWorkflowRules(
      cell!.command,
      "issue-uuid",
      "Bearer tok",
      cell!.caller.bodyId,
      null,
      cell!.caller.linearUserId ?? null,
    );
    expect(result).not.toBeNull();
    expect(result).toContain(NEW_COMMAND);

    fs.writeFileSync(extendedDefPath, TEST_WORKFLOW_YAML, "utf8");
    resetWorkflowCache();
    resetNativeStateCache();
  });

  it("human-signoff rejection in extended def names the new command (catches stale messages)", async () => {
    const matrix = buildConformanceMatrix(extendedDef, testPolicy);
    const cell = matrix.find(
      (c) =>
        c.state === "deployment" &&
        c.expected === "block" &&
        c.blockReason === "human-signoff",
    );
    expect(cell).toBeDefined();
    expect(cell!.legalCommands).toContain(NEW_COMMAND);

    const extendedDefPath = path.join(tmpDir, "dev-impl.yaml");
    fs.writeFileSync(extendedDefPath, yaml.dump(extendedDef), "utf8");
    resetWorkflowCache();
    resetNativeStateCache();

    globalThis.fetch = makeCellFetch(
      extendedDef.id,
      cell!.state,
      cell!.flags.delegateLinearUserId ?? null,
      cell!.flags.stakeLabel,
    );

    const result = await checkWorkflowRules(
      cell!.command,
      "issue-uuid",
      "Bearer tok",
      cell!.caller.bodyId,
      null,
      cell!.caller.linearUserId ?? null,
    );
    expect(result).not.toBeNull();
    expect(result).toContain(NEW_COMMAND);

    fs.writeFileSync(extendedDefPath, TEST_WORKFLOW_YAML, "utf8");
    resetWorkflowCache();
    resetNativeStateCache();
  });

  it("unknown-caller rejection in extended def names the new command (catches stale messages)", async () => {
    const matrix = buildConformanceMatrix(extendedDef, testPolicy);
    const cell = matrix.find(
      (c) =>
        c.state === "deployment" &&
        c.expected === "block" &&
        c.blockReason === "unknown-caller" &&
        c.flags.stakeLabel === null,
    );
    expect(cell).toBeDefined();
    expect(cell!.legalCommands).toContain(NEW_COMMAND);

    const extendedDefPath = path.join(tmpDir, "dev-impl.yaml");
    fs.writeFileSync(extendedDefPath, yaml.dump(extendedDef), "utf8");
    resetWorkflowCache();
    resetNativeStateCache();

    globalThis.fetch = makeCellFetch(
      extendedDef.id,
      cell!.state,
      cell!.flags.delegateLinearUserId ?? null,
      cell!.flags.stakeLabel,
    );

    const result = await checkWorkflowRules(
      cell!.command,
      "issue-uuid",
      "Bearer tok",
      cell!.caller.bodyId,
      null,
      null,
    );
    expect(result).not.toBeNull();
    expect(result).toContain(NEW_COMMAND);

    fs.writeFileSync(extendedDefPath, TEST_WORKFLOW_YAML, "utf8");
    resetWorkflowCache();
    resetNativeStateCache();
  });
});
