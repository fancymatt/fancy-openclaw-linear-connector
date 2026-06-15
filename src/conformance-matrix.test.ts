/**
 * AI-1543 / G-9 — Conformance matrix generator tests.
 *
 * Verifies that `buildConformanceMatrix(def, policy)` emits the full
 * (state × command × caller-class × ticket-flags) cross-product derived
 * from the workflow def + capability-policy, and that checkWorkflowRules
 * behaves exactly as each cell predicts:
 *
 *   • legal cells   → checkWorkflowRules returns null (allow)
 *   • illegal cells → checkWorkflowRules returns a non-null rejection
 *                     string that names every legal command for that state
 *
 * AC1: generator produces the full cross-product.
 * AC2: every legal cell passes; every illegal cell fails closed + names legal set.
 * AC3: changing the def changes the matrix without test-file edits.
 * AC4: full jest suite green (passes after implementation).
 *
 * Caller classes covered: delegate · non-delegate-same-role · wrong-role ·
 * steward · human (unknown caller, for stakes-gate tests).
 *
 * Ticket-flag dimensions: stakes-label (no-risk, low, medium, high) ×
 * version-stamp × parented.
 *
 * Hand-written adversarial/lifecycle rows (park, undelegate, complete, manage)
 * are a separate layer (§3.1 list 3) and are NOT generated here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  buildConformanceMatrix,
  type ConformanceCell,
  type CallerKind,
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

// ── Canonical fixture paths ───────────────────────────────────────────────

const CANONICAL_DEV_IMPL_FIXTURE = path.resolve(
  process.cwd(),
  "src/__fixtures__/canonical-dev-impl.yaml",
);

// ── Test workflow def — minimal 4-state shape ─────────────────────────────
// Intentionally smaller than canonical to make cross-product counts tractable.

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

// ── Test capability policy — two bodies per role where possible ───────────
// Two dev bodies (igor + charles) give us "non-delegate-same-role" coverage.

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

// ── Agents file ────────────────────────────────────────────────────────────

const TEST_AGENTS = {
  agents: [
    { name: "igor",     linearUserId: "igor-uuid",     clientId: "ig-c", clientSecret: "ig-s", accessToken: "ig-t", refreshToken: "ig-r" },
    { name: "charles",  linearUserId: "charles-uuid",  clientId: "ch-c", clientSecret: "ch-s", accessToken: "ch-t", refreshToken: "ch-r" },
    { name: "hanzo",    linearUserId: "hanzo-uuid",    clientId: "ha-c", clientSecret: "ha-s", accessToken: "ha-t", refreshToken: "ha-r" },
    { name: "astrid",   linearUserId: "astrid-uuid",   clientId: "as-c", clientSecret: "as-s", accessToken: "as-t", refreshToken: "as-r" },
    { name: "reviewer", linearUserId: "reviewer-uuid", clientId: "rv-c", clientSecret: "rv-s", accessToken: "rv-t", refreshToken: "rv-r" },
  ],
};

// ── Parsed objects (built synchronously for use in describe.each) ──────────

const testDef = yaml.load(TEST_WORKFLOW_YAML) as WorkflowDef;
const testPolicy = yaml.load(TEST_POLICY_YAML) as CapabilityPolicyInput;

// ── Mock team states (needed by applyStateTransition / label fetch) ────────

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid",    name: "Todo",    type: "unstarted" },
  { id: "state-doing-uuid",   name: "Doing",   type: "started" },
  { id: "state-done-uuid",    name: "Done",    type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

// ── Fetch mock factory for matrix cells ────────────────────────────────────

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

// ── Test environment ───────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-matrix-test-"));

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

// ── AC1: matrix shape ─────────────────────────────────────────────────────

describe("buildConformanceMatrix — AC1: matrix shape", () => {
  it("returns a non-empty array", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    expect(Array.isArray(cells)).toBe(true);
    expect(cells.length).toBeGreaterThan(0);
  });

  it("covers every non-terminal state in the def", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const nonTerminalStates = testDef.states
      .filter((s) => s.kind !== "terminal")
      .map((s) => s.id);
    const coveredStates = new Set(cells.map((c) => c.state));
    for (const s of nonTerminalStates) {
      expect(coveredStates.has(s)).toBe(true);
    }
  });

  it("covers terminal states (e.g. done, escape)", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const terminalStates = testDef.states
      .filter((s) => s.kind === "terminal")
      .map((s) => s.id);
    const coveredStates = new Set(cells.map((c) => c.state));
    for (const s of terminalStates) {
      expect(coveredStates.has(s)).toBe(true);
    }
  });

  it("includes at least one cell for every command defined in any state", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const allCommands = new Set<string>();
    for (const s of testDef.states) {
      for (const t of s.transitions ?? []) {
        allCommands.add(t.command);
      }
    }
    if (testDef.break_glass?.command) {
      allCommands.add(testDef.break_glass.command);
    }
    const coveredCommands = new Set(cells.map((c) => c.command));
    for (const cmd of allCommands) {
      expect(coveredCommands.has(cmd)).toBe(true);
    }
  });

  it("includes cells for every caller class", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const kinds = new Set<CallerKind>(cells.map((c) => c.caller.kind));
    const expectedKinds: CallerKind[] = [
      "delegate",
      "non-delegate-same-role",
      "wrong-role",
      "steward",
      "human",
    ];
    for (const k of expectedKinds) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it("includes cells for all ticket-flag stake variants (no-risk, low, medium, high)", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const stakeLabels = new Set(cells.map((c) => c.flags.stakeLabel));
    expect(stakeLabels.has(null)).toBe(true);    // no-risk
    expect(stakeLabels.has("stakes:low")).toBe(true);
    expect(stakeLabels.has("stakes:medium")).toBe(true);
    expect(stakeLabels.has("stakes:high")).toBe(true);
  });

  it("every cell has a legalCommands array that includes the break-glass command", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const bgCmd = testDef.break_glass?.command ?? "escape";
    for (const cell of cells) {
      expect(cell.legalCommands).toContain(bgCmd);
    }
  });

  it("every cell has a deterministic expected value ('allow' or 'block')", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    for (const cell of cells) {
      expect(["allow", "block"]).toContain(cell.expected);
    }
  });

  it("cells are unique: no duplicate (state, command, callerKind, bodyId, stakeLabel) tuples", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const keys = cells.map(
      (c) =>
        `${c.state}|${c.command}|${c.caller.kind}|${c.caller.bodyId}|${c.flags.stakeLabel}`,
    );
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});

// ── AC1: cross-product completeness ───────────────────────────────────────

describe("buildConformanceMatrix — AC1: cross-product completeness", () => {
  it("for each non-terminal state, includes every known command (legal and illegal)", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const allCommands = new Set<string>();
    for (const s of testDef.states) {
      for (const t of s.transitions ?? []) allCommands.add(t.command);
    }
    if (testDef.break_glass?.command) allCommands.add(testDef.break_glass.command);

    const nonTerminal = testDef.states.filter((s) => s.kind !== "terminal");
    for (const stateNode of nonTerminal) {
      const cellsForState = cells.filter((c) => c.state === stateNode.id);
      const commandsInState = new Set(cellsForState.map((c) => c.command));
      for (const cmd of allCommands) {
        expect(commandsInState.has(cmd)).toBe(true);
      }
    }
  });

  it("each state × command pair has at least one 'allow' and one 'block' cell (different callers)", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    // For each command that is LEGAL in its state, there should be a delegate cell
    // (allow) and at least one wrong-role or no-capability cell (block)
    for (const stateNode of testDef.states.filter((s) => s.kind !== "terminal")) {
      for (const t of stateNode.transitions ?? []) {
        const stateCmd = cells.filter((c) => c.state === stateNode.id && c.command === t.command);
        const hasAllow = stateCmd.some((c) => c.expected === "allow");
        const hasBlock = stateCmd.some((c) => c.expected === "block");
        expect(hasAllow).toBe(true);
        // Some commands are always blocked for some caller class
        // (e.g. wrong-role, human) — at least one block cell should exist
        expect(hasBlock).toBe(true);
      }
    }
  });

  it("illegal commands (not in state transitions) always produce 'block' cells", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const bgCmd = testDef.break_glass?.command ?? "escape";
    for (const stateNode of testDef.states) {
      const legalCmds = new Set([
        ...(stateNode.transitions ?? []).map((t) => t.command),
        bgCmd,
      ]);
      const cellsForState = cells.filter((c) => c.state === stateNode.id);
      const illegalCells = cellsForState.filter((c) => !legalCmds.has(c.command));
      for (const cell of illegalCells) {
        expect(cell.expected).toBe("block");
      }
    }
  });

  it("break-glass command is always 'allow' for known callers (§4.4)", () => {
    const cells = buildConformanceMatrix(testDef, testPolicy);
    const bgCmd = testDef.break_glass?.command ?? "escape";
    const bgCells = cells.filter((c) => c.command === bgCmd && c.caller.kind !== "human");
    expect(bgCells.length).toBeGreaterThan(0);
    for (const cell of bgCells) {
      expect(cell.expected).toBe("allow");
    }
  });
});

// ── AC2: legal cells execute correctly ────────────────────────────────────

describe("buildConformanceMatrix — AC2: legal cells pass checkWorkflowRules", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const legalCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) => c.expected === "allow",
  );

  it.each(legalCells)(
    "allow: state=$state command=$command caller=$caller.kind($caller.bodyId) stakes=$flags.stakeLabel",
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
      expect(result).toBeNull();
    },
  );
});

// ── AC2: illegal cells fail closed + name legal set ───────────────────────

describe("buildConformanceMatrix — AC2: illegal cells fail closed, name legal set", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const illegalCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) => c.expected === "block",
  );

  it.each(illegalCells)(
    "block: state=$state command=$command caller=$caller.kind($caller.bodyId) stakes=$flags.stakeLabel",
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
    },
  );
});

// ── AC2: illegal cells name the legal set ─────────────────────────────────
// For cells blocked because the command is not in the state's transitions
// (as opposed to capability/delegate/stakes failures), the rejection message
// must name every legal command.

describe("buildConformanceMatrix — AC2: wrong-state rejection names legal commands", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const wrongStateCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) =>
      c.expected === "block" &&
      c.blockReason === "wrong-state" &&
      c.legalCommands.length > 0,
  );

  it.each(wrongStateCells)(
    "wrong-state rejection names legal set: state=$state command=$command caller=$caller.bodyId",
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
      for (const legalCmd of cell.legalCommands.filter((c) => c !== cell.command)) {
        expect(result).toContain(legalCmd);
      }
    },
  );
});

// ── AC2: capability-gate cells ─────────────────────────────────────────────
// Transitions with requires_capability must block bodies that lack it.

describe("buildConformanceMatrix — AC2: capability gate blocks non-capable caller", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const capGateCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) => c.expected === "block" && c.blockReason === "cap-missing",
  );

  it("at least one cap-missing cell exists in the matrix", () => {
    expect(capGateCells.length).toBeGreaterThan(0);
  });

  it.each(capGateCells)(
    "cap-missing: state=$state command=$command caller=$caller.bodyId",
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
      // Rejection must mention the missing capability
      const capCells = capGateCells.filter(
        (c) => c.state === cell.state && c.command === cell.command,
      );
      if (capCells.length > 0 && capCells[0].requiredCapability) {
        expect(result).toContain(capCells[0].requiredCapability);
      }
    },
  );
});

// ── AC2: delegate-only cells ───────────────────────────────────────────────
// Non-delegate callers must be blocked on delegated tickets (AI-1397).

describe("buildConformanceMatrix — AC2: delegate-only enforcement", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const nonDelegateCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) =>
      c.expected === "block" &&
      c.blockReason === "wrong-delegate",
  );

  it("at least one wrong-delegate cell exists in the matrix", () => {
    expect(nonDelegateCells.length).toBeGreaterThan(0);
  });

  it.each(nonDelegateCells)(
    "wrong-delegate blocked: state=$state command=$command caller=$caller.bodyId",
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
    },
  );
});

// ── AC2: human-signoff gate ────────────────────────────────────────────────
// requires_human_signoff_above_stakes transitions must block AI agents when
// stakes >= threshold, but allow unknown callers (humans).

describe("buildConformanceMatrix — AC2: stakes-threshold human-signoff gate", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const stakesBlockCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) => c.expected === "block" && c.blockReason === "human-signoff",
  );

  const stakesAllowHumanCells = buildConformanceMatrix(testDef, testPolicy).filter(
    (c) =>
      c.expected === "allow" &&
      c.caller.kind === "human",
  );

  it("at least one human-signoff block cell exists (AI blocked at high stakes)", () => {
    expect(stakesBlockCells.length).toBeGreaterThan(0);
  });

  it.each(stakesBlockCells)(
    "human-signoff blocks AI agent: state=$state command=$command stakes=$flags.stakeLabel",
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
      expect(result).toContain("stakes");
    },
  );

  it.each(stakesAllowHumanCells)(
    "human caller allowed for stakes-gated transition: state=$state command=$command stakes=$flags.stakeLabel",
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
      expect(result).toBeNull();
    },
  );
});

// ── AC3: def-change regeneration ──────────────────────────────────────────
// Changing the def must produce a different matrix without any test-file edits.
// This test uses an in-process def mutation to verify the matrix changes.

describe("buildConformanceMatrix — AC3: def changes auto-regenerate matrix", () => {
  it("adding a new transition to a state increases the matrix cell count", () => {
    const baseCells = buildConformanceMatrix(testDef, testPolicy);

    const extendedDef: WorkflowDef = {
      ...testDef,
      states: testDef.states.map((s) => {
        if (s.id === "intake") {
          return {
            ...s,
            transitions: [
              ...(s.transitions ?? []),
              { command: "park", to: "__ad_hoc__" },
            ],
          };
        }
        return s;
      }),
    };

    const extendedCells = buildConformanceMatrix(extendedDef, testPolicy);
    expect(extendedCells.length).toBeGreaterThan(baseCells.length);
  });

  it("adding a new non-terminal state increases the covered-states count", () => {
    const baseCells = buildConformanceMatrix(testDef, testPolicy);
    const baseStates = new Set(baseCells.map((c) => c.state));

    const extendedDef: WorkflowDef = {
      ...testDef,
      states: [
        ...testDef.states,
        {
          id: "host-deploy",
          owner_role: "host-deploy",
          kind: "normal",
          native_state: "todo",
          transitions: [{ command: "host-deployed", to: "done" }],
        },
      ],
    };

    const extendedCells = buildConformanceMatrix(extendedDef, testPolicy);
    const extendedStates = new Set(extendedCells.map((c) => c.state));

    expect(extendedStates.size).toBeGreaterThan(baseStates.size);
    expect(extendedStates.has("host-deploy")).toBe(true);
  });

  it("removing a transition from a state removes corresponding cells", () => {
    const baseCells = buildConformanceMatrix(testDef, testPolicy);
    const intakeDemoteCells = baseCells.filter(
      (c) => c.state === "intake" && c.command === "demote",
    );
    expect(intakeDemoteCells.length).toBeGreaterThan(0);

    const reducedDef: WorkflowDef = {
      ...testDef,
      states: testDef.states.map((s) => {
        if (s.id === "intake") {
          return {
            ...s,
            transitions: (s.transitions ?? []).filter((t) => t.command !== "demote"),
          };
        }
        return s;
      }),
    };

    const reducedCells = buildConformanceMatrix(reducedDef, testPolicy);
    // "demote" from intake should still appear in the matrix (as illegal cells), but:
    // — The "allow" cells for demote in intake should be gone (demote is no longer legal there).
    const demoteAllowCells = reducedCells.filter(
      (c) => c.state === "intake" && c.command === "demote" && c.expected === "allow",
    );
    expect(demoteAllowCells.length).toBe(0);
  });

  it("changing a capability requirement updates the legal/illegal classification", () => {
    // Remove requires_capability from the deploy transition → Hanzo no longer required.
    const relaxedDef: WorkflowDef = {
      ...testDef,
      states: testDef.states.map((s) => {
        if (s.id === "deployment") {
          return {
            ...s,
            transitions: (s.transitions ?? []).map((t) =>
              t.command === "deploy" ? { ...t, requires_capability: undefined } : t,
            ),
          };
        }
        return s;
      }),
    };

    const originalCells = buildConformanceMatrix(testDef, testPolicy);
    const relaxedCells = buildConformanceMatrix(relaxedDef, testPolicy);

    // In the original, deploy from deployment is blocked for non-deploy bodies (cap-missing).
    const originalCapBlocked = originalCells.filter(
      (c) => c.state === "deployment" && c.command === "deploy" && c.blockReason === "cap-missing",
    );

    // In the relaxed def, those cap-missing cells should not exist.
    const relaxedCapBlocked = relaxedCells.filter(
      (c) => c.state === "deployment" && c.command === "deploy" && c.blockReason === "cap-missing",
    );

    expect(originalCapBlocked.length).toBeGreaterThan(0);
    expect(relaxedCapBlocked.length).toBe(0);
  });
});

// ── Canonical fixture integration ─────────────────────────────────────────
// Smoke-check the generator against the checked-in canonical-dev-impl.yaml.

describe("buildConformanceMatrix — canonical dev-impl fixture (v8)", () => {
  const canonicalRaw = fs.readFileSync(CANONICAL_DEV_IMPL_FIXTURE, "utf8");
  const canonicalDef = yaml.load(canonicalRaw) as WorkflowDef;

  it("produces cells for all 9 canonical states (intake, write-tests, implementation, code-review, deployment, host-deploy, ac-validate, done, escape)", () => {
    const cells = buildConformanceMatrix(canonicalDef, testPolicy);
    const stateSet = new Set(cells.map((c) => c.state));
    const expectedStates = [
      "intake",
      "write-tests",
      "implementation",
      "code-review",
      "deployment",
      "host-deploy",
      "ac-validate",
      "done",
      "escape",
    ];
    for (const s of expectedStates) {
      expect(stateSet.has(s)).toBe(true);
    }
  });

  it("deploy in deployment state has a cap-missing block cell (deploy:execute required)", () => {
    const cells = buildConformanceMatrix(canonicalDef, testPolicy);
    const deployCapBlock = cells.filter(
      (c) =>
        c.state === "deployment" &&
        c.command === "deploy" &&
        c.blockReason === "cap-missing",
    );
    expect(deployCapBlock.length).toBeGreaterThan(0);
  });

  it("deploy in deployment state has a human-signoff block cell for high-stakes AI callers", () => {
    const cells = buildConformanceMatrix(canonicalDef, testPolicy);
    const stakesBlock = cells.filter(
      (c) =>
        c.state === "deployment" &&
        c.command === "deploy" &&
        c.blockReason === "human-signoff",
    );
    expect(stakesBlock.length).toBeGreaterThan(0);
  });

  it("tests-ready in write-tests is legal for the test-author role delegate", () => {
    const cells = buildConformanceMatrix(canonicalDef, testPolicy);
    const allowCells = cells.filter(
      (c) =>
        c.state === "write-tests" &&
        c.command === "tests-ready" &&
        c.expected === "allow",
    );
    expect(allowCells.length).toBeGreaterThan(0);
  });

  it("total cell count scales with states × commands × callers × flags (sanity check)", () => {
    const cells = buildConformanceMatrix(canonicalDef, testPolicy);
    // Each of 9 states × N commands × 5 caller classes × 4 flag variants — at minimum
    // hundreds of cells. Exact count depends on implementation, but >200 is a safe lower bound.
    expect(cells.length).toBeGreaterThan(200);
  });
});

// ── G-13a T-rows: break-glass header identity gate (AI-1551) ──────────────
//
// Hand-written adversarial rows for the X-Openclaw-Break-Glass identity gate.
// The generated matrix covers the `escape` command (the break-glass workflow
// *intent*). These T-rows cover the separate *header-based* config bypass,
// which must be identity-gated to steward/human callers only.
//
// Matrix property under test:
//   breakGlassOverride=true + non-steward bodyId → identity gate rejects
//   breakGlassOverride=true + steward bodyId     → allowed

describe("G-13a T-rows: break-glass header identity gate (AI-1551)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkflowCache();
    resetPolicyCache();
  });

  // Fetch mock: ticket is wf:dev-impl / state:implementation; context fetch
  // succeeds. Workflow registry load will fail (nonexistent yaml path set per
  // test). break-glass header bypass is the only way through — but only for
  // steward callers.
  function makeBreakGlassFetch(): typeof globalThis.fetch {
    return async (_url: any, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
      if (
        parsed.query?.includes("delegate") ||
        parsed.query?.includes("IssueContext") ||
        parsed.query?.includes("IssueLabels")
      ) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
                delegate: { id: "astrid-uuid" },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("T-AC1: checkWorkflowRules rejects breakGlassOverride=true from a non-steward body (charles)", async () => {
    // Break the workflow registry so the request would normally fail-closed.
    process.env.WORKFLOW_DEF_PATH = "/nonexistent/workflow-bg-test.yaml";
    resetWorkflowCache();
    globalThis.fetch = makeBreakGlassFetch();

    // charles is in the dev container (no human:escalate) — break-glass must be denied.
    const result = await checkWorkflowRules(
      "submit",
      "issue-uuid",
      "Bearer tok",
      "charles",
      null,
      "charles-uuid",
      null,
      /* breakGlassOverride */ true,
    );

    expect(result).not.toBeNull();
    expect(result).toMatch(/break.glass|identity|steward/i);
  });

  it("T-AC1: checkWorkflowRules rejects breakGlassOverride=true from an unknown caller", async () => {
    process.env.WORKFLOW_DEF_PATH = "/nonexistent/workflow-bg-test.yaml";
    resetWorkflowCache();
    globalThis.fetch = makeBreakGlassFetch();

    const result = await checkWorkflowRules(
      "submit",
      "issue-uuid",
      "Bearer tok",
      "unknown-unregistered-agent",
      null,
      null,
      null,
      /* breakGlassOverride */ true,
    );

    expect(result).not.toBeNull();
    expect(result).toMatch(/break.glass|identity|steward/i);
  });

  it("T-AC2: checkWorkflowRules allows breakGlassOverride=true from a steward body (astrid)", async () => {
    process.env.WORKFLOW_DEF_PATH = "/nonexistent/workflow-bg-test.yaml";
    resetWorkflowCache();
    globalThis.fetch = makeBreakGlassFetch();

    // astrid fills the steward role (human:escalate) — break-glass must pass.
    const result = await checkWorkflowRules(
      "submit",
      "issue-uuid",
      "Bearer tok",
      "astrid",
      null,
      "astrid-uuid",
      null,
      /* breakGlassOverride */ true,
    );

    expect(result).toBeNull();
  });
});
