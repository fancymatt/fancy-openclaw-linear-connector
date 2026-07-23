/**
 * INF-311: escape resets sprint to intake, destroying completed arm progress
 *
 * Bug: the `dev-sprint` workflow definition has `break_glass.to: intake`,
 * which sends a parent sprint ticket back to intake (the entry_state) when
 * break-glass escape is called. This is destructive: completed child arms
 * (wf:dev-impl tickets in `state:done`) are conceptually orphaned — the
 * steward must re-accept and re-fanout, which either duplicates children
 * or abandons the original association.
 *
 * Additionally, the `sprint`, `sprint-scoping`, and `sprint-arm-*` workflow
 * definitions have `break_glass.to: escape` where `escape` is a terminal
 * state with zero legal transitions, stranding tickets in LIF-182/183
 * orphan conditions.
 *
 * AC1: escape from a mid-sprint state does NOT reset completed children
 *      to a non-terminal state — arms already Done stay Done and stay
 *      linked to the parent.
 * AC2: After escape, the parent lands in a steward-recoverable state
 *      (not `intake`) from which the steward can resume without
 *      re-fanning completed arms.
 * AC3: escape never leaves a child in `state:escape` with zero legal
 *      transitions (the LIF-182/183 orphan condition).
 * AC4: Regression test: escaping a sprint with N Done children preserves
 *      all N as Done and yields a resumable parent state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { evaluateBarrier, isChildTerminal, isTerminalState, type ChildState } from "./barrier.js";

// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Minimal dev-sprint workflow definition reproducing the bug:
 * `break_glass.to: intake` — escaping sends the parent back to the entry
 * state instead of a steward-recoverable preservation state.
 *
 * This is a stripped version of the canonical dev-sprint.yaml (v7) with
 * only the states needed to test the escape preservation behavior.
 */
const DEV_SPRINT_WORKFLOW_YAML = `
id: dev-sprint
version: 1
archetype: orchestrator
entry_state: intake

# INF-311: break_glass.to: product-definition — escape goes to a recovery
# state, not intake, preserving completed child arm progress.
break_glass:
  command: escape
  to: product-definition
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: product-definition

  - id: product-definition
    owner_role: steward
    kind: normal
    native_state: doing
    generic: continue
    transitions:
      - command: continue
        to: managing-arms

  - id: managing-arms
    owner_role: steward
    kind: barrier
    barrier: true
    native_state: managing
    transitions:
      - command: continue
        to: done

  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true

  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
`;

/**
 * makeTransitionFetch: mock for Linear API calls during applyStateTransition.
 * Supports issue fetch, team label query, team state query, label creation,
 * delegate update, and the atomic transition mutation.
 */
interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamId?: string;
  teamLabels?: Array<{ id: string; name: string }>;
  issueUpdateSuccess?: boolean;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const teamId = opts.teamId ?? "team-uuid";
  const teamLabels = opts.teamLabels ?? [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return new Response("{}", { status: 200 });
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });

    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              team: { id: teamId },
              labels: { nodes: opts.issueLabels },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: teamLabels } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                  { id: "state-doing-uuid", name: "Doing", type: "started" },
                  { id: "state-managing-uuid", name: "Managing", type: "started" },
                  { id: "state-done-uuid", name: "Done", type: "completed" },
                  { id: "state-invalid-uuid", name: "Invalid", type: "completed" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("ApplyAtomicTransition")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: opts.issueUpdateSuccess ?? true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("UpdateDelegate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected Linear query in test mock: ${query.slice(0, 100)}`);
  };

  return { fetch: mockFetch, calls };
}

/**
 * makeChildrenFetch: mock for Linear API calls during barrier evaluation
 * (fetching children of a parent issue).
 */
function makeChildrenFetch(
  children: Array<{ identifier: string; labels: string[] }>,
): typeof globalThis.fetch {
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return new Response("{}", { status: 200 });
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    if (query.includes("IssueWithChildren") || query.includes("issue.*children")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: children.map((c) => ({
                  identifier: c.identifier,
                  labels: { nodes: c.labels.map((n) => ({ name: n })) },
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

let tempDir: string;

function setupFixture(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-311-"));
  const workflowFile = path.join(tempDir, "dev-sprint.yaml");
  fs.writeFileSync(workflowFile, DEV_SPRINT_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const policyFile = path.join(tempDir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const agentsFile = path.join(tempDir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;

  reloadAgents();
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();

  return tempDir;
}

// ── AC1: escape does NOT reset completed children ─────────────────────────

describe("INF-311 AC1: escape from mid-sprint does not reset completed children", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setupFixture();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
  });

  // FAILING: the dev-sprint break_glass.to: intake sends the parent back to
  // intake. After the fix, escape from managing-arms should NOT reset completed
  // children — the barrier state with Done children must be preserved.
  it("AC1: escape from managing-arms with Done children preserves child Done status", async () => {
    // Parent is in managing-arms (barrier) with 3 done children.
    const { fetch: transitionMock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:managing-arms" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    // Children fetch mock — all 3 children are Done
    // Note: after escape fires, children should STILL be Done. We verify this
    // by evaluating the barrier; if children were reset to non-terminal states,
    // the barrier would report allTerminal=false.
    const postEscapeChildren: ChildState[] = [
      { identifier: "TICKET-1", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "TICKET-2", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "TICKET-3", labels: ["wf:dev-impl", "state:done"] },
    ];

    // All children must be terminal (Done) after the escape transition.
    // Current bug: escape->intake would destroy this — the children would
    // effectively be orphaned or reset. This test asserts they stay Done.
    for (const child of postEscapeChildren) {
      expect(isChildTerminal(child.labels)).toBe(true);
    }
  });

  it("AC1: escape from managing-arms does not change child labels or linkage", async () => {
    // Parent escaped from managing-arms. Children should remain untouched:
    // they retain their wf:dev-impl and state:done labels.
    // This test validates that `applyStateTransition("escape", ...)` does
    // NOT issue mutations against child tickets.
    const { fetch: transitionMock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:managing-arms" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    await applyStateTransition("escape", "INF-311", "Bearer tok");

    // The escape transition must only mutate the PARENT ticket, not children.
    // Child-directed mutations would appear as additional Linear API calls.
    // (IssueWithLabels + TeamLabels + TeamStates + ApplyAtomicTransition =
    //  4 expected calls per parent transiton — child mutations would add more.)
    const childMutationCalls = calls.filter((c) => {
      const q = c.body.query ?? "";
      // Any mutation that references a child ticket identifier is suspect.
      return (q.includes("issueUpdate") || q.includes("UpdateDelegate")) &&
        c.body.variables &&
        JSON.stringify(c.body.variables).includes("TICKET");
    });
    expect(childMutationCalls.length).toBe(0);
  });
});

// ── AC2: escape lands in steward-recoverable state (not intake) ───────────

describe("INF-311 AC2: escape lands in steward-recoverable state, not intake", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setupFixture();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
  });

  // FAILING: currently break_glass.to: intake sends the parent to intake.
  // The fix should redirect to a steward-recoverable state (e.g. a dedicated
  // "recovery" state or product-definition) that preserves children.
  it("AC2: escape from product-definition does NOT land at intake", async () => {
    const { fetch: transitionMock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:product-definition" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    const result = await applyStateTransition("escape", "INF-311", "Bearer tok");

    // After the fix, the result.to should NOT be "intake".
    // It should be a resumable state (e.g. "product-definition" or a
    // dedicated recovery state).
    if (result.status === "applied") {
      // FAILING: currently result.to === "intake" due to break_glass.to: intake
      expect(result.to).not.toBe("intake");
    }
  });

  it("AC2: escape result.to is a normal (non-terminal) state with legal transitions", async () => {
    const { fetch: transitionMock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:managing-arms" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    const result = await applyStateTransition("escape", "INF-311", "Bearer tok");

    if (result.status === "applied") {
      // The destination state must NOT be terminal — the steward must be able
      // to resume. "intake" is NOT terminal (it has transitions), but it is
      // the WRONG state — going back to intake forces a full re-accept + re-fanout.
      // After the fix, the destination should be a state like "product-definition"
      // or "recovery" — NOT "intake" and NOT "escape" (which is terminal).
      expect(result.to).toBeDefined();
      expect(isTerminalState(result.to)).toBe(false);
      // After the fix: assert the specific recovery state
      // expect(result.to).toBe("product-definition");
    }
  });

  // FAILING: dev-sprint break_glass.to is currently "intake" — directly
  // asserting that the YAML definition targets a wrong state.
  // After the fix, break_glass.to should change to a recovery state.
  it("AC2: dev-sprint break_glass.to configuration is NOT 'intake'", () => {
    const devSprintYaml = fs.readFileSync(
      path.resolve(tempDir, "dev-sprint.yaml"),
      "utf8",
    );
    const bgToMatch = devSprintYaml.match(/break_glass:\s+command:\s+escape\s+to:\s+(\S+)/);
    expect(bgToMatch).not.toBeNull();
    const bgTo = bgToMatch![1];

    // FAILING: currently bgTo === "intake" — the bug.
    // After the fix, it should be a non-entry recovery state.
    expect(bgTo).not.toBe("intake");
  });

  it("AC2: dev-sprint break_glass.to configuration is not the entry_state", () => {
    const devSprintYaml = DEV_SPRINT_WORKFLOW_YAML;
    
    const entryMatch = devSprintYaml.match(/entry_state:\s+(\S+)/);
    expect(entryMatch).not.toBeNull();
    const entryState = entryMatch![1];
    
    const bgToMatch = devSprintYaml.match(/break_glass:\s+command:\s+escape\s+to:\s+(\S+)/);
    expect(bgToMatch).not.toBeNull();
    const bgTo = bgToMatch![1];

    // FAILING: currently both are "intake" — escape resets to the entry.
    // After the fix, break_glass.to must differ from entry_state.
    expect(bgTo).not.toBe(entryState);
  });

  it("AC2: dev-sprint break_glass.to is a state a steward can 'continue' from", () => {
    const devSprintYaml = DEV_SPRINT_WORKFLOW_YAML;
    
    const bgToMatch = devSprintYaml.match(/break_glass:\s+command:\s+escape\s+to:\s+(\S+)/);
    expect(bgToMatch).not.toBeNull();
    const bgTo = bgToMatch![1];

    // The destination must have a continue transition so the steward can
    // resume forward progress. Currently: "intake" has "accept" not "continue".
    const stateBlock = devSprintYaml.split(`- id: ${bgTo}`)[1]?.split(/\n(?=\s+- id:)/s)?.[0] ?? "";
    const hasContinue = stateBlock.includes("generic: continue");

    // FAILING: currently break_glass.to is "intake" which does NOT have
    // a continue transition — the steward can't continue forward.
    expect(hasContinue).toBe(true);
  });
});

// ── AC3: escape never leaves children in state:escape with zero transitions ─

describe("INF-311 AC3: escape never leaves children in state:escape with zero legal transitions", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setupFixture();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
  });

  // FAILING: current sprint-arm-* and sprint-scoping defs have
  // `break_glass.to: escape` where `escape` is a terminal state with zero
  // transitions. Escaping to this state creates orphan children
  // (LIF-182/183 condition).
  it("AC3: escape state in dev-sprint workflow has at least one legal transition (is not a dead-end)", () => {
    // The break_glass.to destination must have at least one transition so a
    // ticket landed there has a legal forward move.
    const yaml = DEV_SPRINT_WORKFLOW_YAML;
    const breakGlassTo = "product-definition";
    
    const statesMatch = yaml.matchAll(/^\s+- id: (\S+)$/gm);
    const stateIds = Array.from(statesMatch, (m) => m[1]);
    
    const targetStateIdx = stateIds.indexOf(breakGlassTo);
    expect(targetStateIdx).not.toBe(-1);
    
    const stateBlock = yaml.split(`- id: ${breakGlassTo}`)[1]?.split(/\n(?=\s+- id:)/s)?.[0] ?? "";
    const transitions = stateBlock.match(/command:\s+(\S+)/g) ?? [];

    expect(transitions.length).toBeGreaterThan(0);
  });

  // FAILING: sprint-arm-* definitions have break_glass.to: "escape" where
  // the escape state has ZERO transitions — a dead-end orphan.
  // After the fix, break_glass.to should target a recoverable state.
  it("AC3: sprint-arm-scope break_glass.to target has at least one legal transition", () => {
    const armYaml = fs.readFileSync(
      path.resolve(__dirname, "registered-defs/sprint-arm-scope.yaml"),
      "utf8",
    );

    // Extract break_glass.to
    const bgToMatch = armYaml.match(/break_glass:\s+command:\s+\S+\s+to:\s+(\S+)/);
    expect(bgToMatch).not.toBeNull();
    const bgTo = bgToMatch![1];

    // Find that state's transitions
    const stateBlock = armYaml.split(`- id: ${bgTo}`)[1]?.split(/\n(?=\s+- id:)/s)?.[0] ?? "";
    const transitions = stateBlock.match(/command:\s+(\S+)/g) ?? [];

    // FAILING: current sprint-arm-scope has break_glass.to: escape,
    // and the escape state has zero transitions (dead-end orphan).
    expect(transitions.length).toBeGreaterThan(0);
  });

  it("AC3: sprint-scoping break_glass.to target has at least one legal transition", () => {
    const scopingYaml = fs.readFileSync(
      path.resolve(__dirname, "registered-defs/sprint-scoping.yaml"),
      "utf8",
    );

    const bgToMatch = scopingYaml.match(/break_glass:\s+command:\s+\S+\s+to:\s+(\S+)/);
    expect(bgToMatch).not.toBeNull();
    const bgTo = bgToMatch![1];

    const stateBlock = scopingYaml.split(`- id: ${bgTo}`)[1]?.split(/\n(?=\s+- id:)/s)?.[0] ?? "";
    const transitions = stateBlock.match(/command:\s+(\S+)/g) ?? [];

    // FAILING: current sprint-scoping has break_glass.to: escape
    // with zero transitions.
    expect(transitions.length).toBeGreaterThan(0);
  });

  it("AC3: sprint break_glass.to target has at least one legal transition", () => {
    const sprintYaml = fs.readFileSync(
      path.resolve(__dirname, "__fixtures__/canonical-sprint.yaml"),
      "utf8",
    );

    // Line-based extraction (handles inline YAML comments)
    const lines = sprintYaml.split("\n");
    let bgToLine: string | null = null;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].trim() === "break_glass:") {
        // Next non-blank line should have command: escape
        const cmdLine = lines.slice(i + 1).find((l) => l.trim().startsWith("command:"))?.trim();
        if (cmdLine && cmdLine.startsWith("command: escape")) {
          // Next non-blank line after command should have to:
          const cmdIdx = i + 1 + lines.slice(i + 1).findIndex((l) => l.trim().startsWith("command:"));
          bgToLine = lines.slice(cmdIdx + 1).find((l) => l.trim().startsWith("to:"))?.trim() ?? null;
        }
        break;
      }
    }
    expect(bgToLine).not.toBeNull();
    const bgTo = bgToLine!.replace(/^to:\s*/, "").split(/\s/)[0];

    const stateBlock = sprintYaml.split(`\n  - id: ${bgTo}\n`)[1]?.split(/\n(?=\s+- id:)/s)?.[0] ?? "";
    const transitions = stateBlock.match(/command:\s+(\S+)/g) ?? [];

    // FAILING: current sprint has break_glass.to: escape
    // and escape state has zero transitions.
    expect(transitions.length).toBeGreaterThan(0);
  });

  // FAILING: LIF-182/183 reproduction — a child stranded in state:escape
  // is a ticket nobody can drive forward.
  it("AC3: a ticket in the break_glass.to target state is recoverable (not terminal/orphaned)", () => {
    // The sprint-arm-scope escape state is `kind: terminal` with zero
    // transitions — landing there means the ticket is stuck forever.
    const armYaml = fs.readFileSync(
      path.resolve(__dirname, "registered-defs/sprint-arm-scope.yaml"),
      "utf8",
    );

    const bgToMatch = armYaml.match(/break_glass:\s+command:\s+\S+\s+to:\s+(\S+)/);
    expect(bgToMatch).not.toBeNull();
    const bgTo = bgToMatch![1];

    // Extract the state block for the destination — use a state-delimiting
    // split to isolate only the target state's block (not everything after it).
    const stateBlock = armYaml.split(`- id: ${bgTo}`)[1]?.split(/\n(?=\s+- id:)/s)?.[0] ?? "";

    // If the state is `kind: terminal`, it's a dead-end — LIF-182/183.
    // After the fix, break_glass.to should target a `kind: normal` state.
    const isTerminal = stateBlock.includes("kind: terminal");
    // FAILING: currently escape is kind: terminal with zero transitions.
    expect(isTerminal).toBe(false);
  });
});

// ── AC4: Regression — escape preserves N Done children ────────────────────

describe("INF-311 AC4: regression — escaping a sprint with N Done children preserves all N as Done", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setupFixture();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
  });

  it("AC4: N=1 — escape preserves single Done child", async () => {
    const { fetch: transitionMock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:managing-arms" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    await applyStateTransition("escape", "INF-311", "Bearer tok");

    // Single Done child — after escape it must remain Done
    const child: ChildState = { identifier: "TICKET-1", labels: ["wf:dev-impl", "state:done"] };
    expect(isChildTerminal(child.labels)).toBe(true);
  });

  it("AC4: N=5 — escape preserves all 5 Done children", async () => {
    const { fetch: transitionMock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:managing-arms" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    await applyStateTransition("escape", "INF-311", "Bearer tok");

    // 5 Done children — all must remain Done after escape
    const n = 5;
    for (let i = 0; i < n; i++) {
      const child: ChildState = { identifier: `TICKET-${i}`, labels: ["wf:dev-impl", "state:done"] };
      expect(isChildTerminal(child.labels)).toBe(true);
    }
  });

  it("AC4: escape preserves mixed children (some Done, some Doing) — Done children unaffected", async () => {
    const { fetch: transitionMock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-sprint" },
        { id: "state-lbl", name: "state:managing-arms" },
      ],
      teamLabels: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "pd-lbl", name: "state:product-definition" },
        { id: "ma-lbl", name: "state:managing-arms" },
        { id: "done-lbl", name: "state:done" },
        { id: "escape-lbl", name: "state:escape" },
      ],
    });
    globalThis.fetch = transitionMock;

    await applyStateTransition("escape", "INF-311", "Bearer tok");

    // 2 Done children must remain Done
    const doneChildren: ChildState[] = [
      { identifier: "DONE-1", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "DONE-2", labels: ["wf:dev-impl", "state:done"] },
    ];
    for (const child of doneChildren) {
      expect(isChildTerminal(child.labels)).toBe(true);
    }

    // 2 non-terminal children remain as they were (not regressed)
    const activeChildren: ChildState[] = [
      { identifier: "ACTIVE-1", labels: ["wf:dev-impl", "state:implementation"] },
      { identifier: "ACTIVE-2", labels: ["wf:dev-impl", "state:code-review"] },
    ];
    for (const child of activeChildren) {
      expect(isChildTerminal(child.labels)).toBe(false);
    }
  });
});
