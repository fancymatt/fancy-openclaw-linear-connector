/**
 * INF-267 (maps to INF-230): Sprint-spawner scanning→determining-scope label stamp.
 *
 * AC1: Reliable stamp — WHEN sprint-spawner transitions from scanning →
 *      determining-scope, the `state:determining-scope` label is reliably
 *      stamped on the ticket.
 * AC2: Missing label creation — `findOrCreateLabel` in `workflow-gate.ts`
 *      creates the label in Linear if it doesn't exist — no silent
 *      `label-resolve-failed`.
 * AC3: AC-validated — Unit test proves `findOrCreateLabel` succeeds for a
 *      missing label (creates it). Integration test proves sprint-spawner
 *      YAML resolve produces the correct label on a Linear ticket.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  applyStateTransition,
  resetWorkflowCache,
  resetNativeStateCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { defStateSnapshotPath } from "./store/def-state-snapshot-store.js";
import { clearAcRecordStore } from "./ac-record-store.js";

// ── Sprint-spawner YAML (canonical, from src/registered-defs/sprint-spawner.yaml) ──
// Includes the scanning→determining-scope transition via the `collect` command.
// Extracted to fixture inline for self-contained test execution.

const SPRINT_SPAWNER_YAML = `
id: sprint-spawner
version: 4
archetype: continuous-loop
entry_state: evaluating

migrations:
  evaluate: evaluating
  dormant: evaluating

break_glass:
  command: escape
  to: escape
  owner_role: steward

states:
  - id: evaluating
    owner_role: steward
    kind: normal
    native_state: todo
    description: >
      Evaluate current product state against the vision document.
    transitions:
      - command: proceed
        to: scanning
        generic: continue
      - command: hold
        to: __terminal_hold__
      - command: start-cycle
        to: scanning

  - id: scanning
    owner_role: steward
    kind: normal
    native_state: doing
    description: >
      Delegate parallel specialist scans.
    transitions:
      - command: collect
        to: determining-scope
        generic: continue

  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: doing
    description: >
      Read vision doc + specialist observations. Choose sprint theme.
    transitions:
      - command: propose-brief
        to: spawning-scope
        generic: continue
        requires_capability: sprint:signoff
        designated_approver: true
      - command: deliver-direct
        to: releasing
        requires_capability: sprint:signoff
        designated_approver: true

  - id: spawning-scope
    owner_role: engine
    kind: normal
    native_state: doing
    fanout:
      spec_source: structured
      child_workflow: wf:sprint-scoping
      initial_delegate: astrid
    transitions:
      - command: spawn
        to: scoping
        generic: continue

  - id: scoping
    owner_role: steward
    kind: normal
    native_state: managing
    barrier: true
    transitions:
      - command: launch
        to: launching

  - id: launching
    owner_role: steward
    kind: normal
    native_state: doing
    fanout:
      spec_source: sprint
      child_workflow: wf:dev-sprint
      initial_delegate: astrid
    transitions:
      - command: spawn
        to: managing
        generic: continue

  - id: managing
    owner_role: steward
    kind: normal
    native_state: managing
    barrier: true
    transitions:
      - command: complete
        to: releasing

  - id: releasing
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: release
        to: retrospecting
        generic: continue

  - id: retrospecting
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: loop
        to: evaluating
        generic: continue
      - command: hold
        to: __terminal_hold__

  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true

  - id: escape
    kind: terminal
    native_state: invalid

  - id: __terminal_hold__
    kind: terminal
    native_state: invalid
`;

// ── Minimal capability policy (includes steward + engine roles) ────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: sprint:signoff

containers:
  - id: workflow
    grants: [linear:transition, workflow:break-glass]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
`;

// ── Team workflow states mock (AI-1498 native state resolution) ────────────

const TEAM_STATES_RESPONSE = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
          { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
          { id: "state-doing-uuid", name: "Doing", type: "started" },
          { id: "state-thinking-uuid", name: "Thinking", type: "started" },
          { id: "state-managing-uuid", name: "Managing", type: "started" },
          { id: "state-done-uuid", name: "Done", type: "completed" },
          { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
        ],
      },
    },
  },
};

// ── Generic mock factory for applyStateTransition tests ────────────────────
// Handles all Linear queries applyStateTransition makes.

function makeSpawnerTransitionFetch(opts: {
  initialLabels: Array<{ id: string; name: string }>;
  teamLabels?: Array<{ id: string; name: string; isGroup?: boolean; parent?: { id: string; name: string } | null }>;
  issueUpdateSuccess?: boolean;
  teamId?: string;
  /** Simulate a fetch error for the issue fetch. */
  issueError?: boolean;
  /** Simulate a fetch error for the issueUpdate call. */
  updateError?: boolean;
  /** Simulate label creation returning null (failure). */
  createLabelFailure?: boolean;
}) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const teamId = opts.teamId ?? "team-uuid";
  const teamLabels = opts.teamLabels ?? [];
  const issueUpdateSuccess = opts.issueUpdateSuccess ?? true;

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables });
    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      if (opts.issueError) throw new Error("simulated fetch error");
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              identifier: "INF-267",
              team: { id: teamId },
              labels: { nodes: opts.initialLabels },
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
        JSON.stringify(TEAM_STATES_RESPONSE),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("issueLabelCreate")) {
      if (opts.createLabelFailure) {
        return new Response(
          JSON.stringify({
            data: { issueLabelCreate: { success: false, issueLabel: null } },
            errors: [{ message: "simulated label create failure" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("ApplyAtomicTransition")) {
      if (opts.updateError) throw new Error("simulated update error");
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: issueUpdateSuccess } } }),
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
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };

  return { fetch: mockFetch, calls };
}


// ── Unit Tests: findOrCreateLabel for a missing label ─────────────────────

// ── Shared agents config for applyStateTransition tests ────────────────────

function setupAgents(dir: string): void {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
    ],
  }, null, 2), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
}


// ── Unit Tests: findOrCreateLabel for a missing label ─────────────────────

describe("INF-267 AC2: findOrCreateLabel creates a missing label (unit)", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-267-unit-"));

    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(tmpDir, "sprint-spawner.yaml");
    fs.writeFileSync(workflowFile, SPRINT_SPAWNER_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    setupAgents(tmpDir);
    resetPolicyCache();
    resetWorkflowCache();
    resetNativeStateCache();
    fs.rmSync(defStateSnapshotPath(), { force: true });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
  });

  afterAll(() => {
    resetWorkflowCache();
    resetNativeStateCache();
  });

  it("creates state:determining-scope label when it does not exist in the team", async () => {
    // Arrange: ticket is in scanning state; team has NO state:determining-scope label.
    const { fetch: mock, calls } = makeSpawnerTransitionFetch({
      initialLabels: [
        { id: "wf-lbl", name: "wf:sprint-spawner" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      teamLabels: [
        { id: "eval-lbl", name: "state:evaluating" },
        { id: "scan-lbl", name: "state:scanning" },
        // state:determining-scope is intentionally ABSENT from teamLabels
      ],
    });
    globalThis.fetch = mock;

    // Act: applyStateTransition for collect (scanning → determining-scope)
    const result = await applyStateTransition("collect", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "scanning",
    });

    // Assert: the label was created (issueLabelCreate was called)
    const createCalls = calls.filter((c) => c.query.includes("issueLabelCreate"));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);

    // The atomic transition was applied with the new label ID
    const updateCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const vars = updateCalls[0].variables as { labelIds?: string[] };
    expect(vars.labelIds).toContain("new-label-id");
    expect(vars.labelIds).not.toContain("scan-lbl");

    // Verify the result indicates success
    expect(result.status).toBe("applied");
  });

  it("reports label-resolve-failed when findOrCreateLabel cannot create the label", async () => {
    // Arrange: label missing AND creation fails.
    const { fetch: mock, calls } = makeSpawnerTransitionFetch({
      initialLabels: [
        { id: "wf-lbl", name: "wf:sprint-spawner" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      teamLabels: [
        { id: "eval-lbl", name: "state:evaluating" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      createLabelFailure: true,
    });
    globalThis.fetch = mock;

    // Act: attempt the transition
    const result = await applyStateTransition("collect", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "scanning",
    });

    // Assert: label creation was attempted and failed
    const createCalls = calls.filter((c) => c.query.includes("issueLabelCreate"));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);

    // Result should indicate failure
    expect(result.status).toBe("failed");
    expect(result.code).toBe("label-resolve-failed");

    // No atomic transition should have been applied
    const updateCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCalls.length).toBe(0);
  });

  it("uses the existing label when state:determining-scope already exists in the team", async () => {
    // Arrange: ticket in scanning; team already has the determining-scope label.
    const { fetch: mock, calls } = makeSpawnerTransitionFetch({
      initialLabels: [
        { id: "wf-lbl", name: "wf:sprint-spawner" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      teamLabels: [
        { id: "eval-lbl", name: "state:evaluating" },
        { id: "scan-lbl", name: "state:scanning" },
        { id: "scope-lbl", name: "state:determining-scope" },
      ],
    });
    globalThis.fetch = mock;

    // Act
    const result = await applyStateTransition("collect", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "scanning",
    });

    // Assert: no label create call was made (label already exists)
    const createCalls = calls.filter((c) => c.query.includes("issueLabelCreate"));
    expect(createCalls.length).toBe(0);

    // The transition swapped scanning → determining-scope
    const updateCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const vars = updateCalls[0].variables as { labelIds?: string[] };
    expect(vars.labelIds).toContain("scope-lbl");
    expect(vars.labelIds).not.toContain("scan-lbl");

    expect(result.status).toBe("applied");
  });
});


// ── Integration Test: applyStateTransition with sprint-spawner YAML ────────

describe("INF-267 AC1 + AC3: sprint-spawner scanning→determining-scope label stamp (integration)", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-267-test-"));

    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(tmpDir, "sprint-spawner.yaml");
    fs.writeFileSync(workflowFile, SPRINT_SPAWNER_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    setupAgents(tmpDir);
    resetPolicyCache();
    resetWorkflowCache();
    resetNativeStateCache();
    // Clear def-state snapshot so no prior version detection interferes
    fs.rmSync(defStateSnapshotPath(), { force: true });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
  });

  afterAll(() => {
    resetWorkflowCache();
    resetNativeStateCache();
  });

  it("stamps state:determining-scope label when ticket transitions from scanning via 'collect'", async () => {
    // Arrange: ticket at scanning state in sprint-spawner workflow.
    // Team has no determining-scope label — it must be created.
    const { fetch: mock, calls } = makeSpawnerTransitionFetch({
      initialLabels: [
        { id: "wf-lbl", name: "wf:sprint-spawner" },
        { id: "scan-lbl", name: "state:scanning" },
        { id: "other-lbl", name: "priority:high" },
      ],
      teamLabels: [
        { id: "eval-lbl", name: "state:evaluating" },
        { id: "scan-lbl", name: "state:scanning" },
        // state:determining-scope absent — must be created
      ],
    });
    globalThis.fetch = mock;

    // Act: apply the transition
    const result = await applyStateTransition("collect", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "scanning",
    });

    // Assert: the transition applied
    expect(result.status).toBe("applied");
    expect(result.code).not.toBe("label-resolve-failed");

    // The label was created (issueLabelCreate was called)
    const createCalls = calls.filter((c) => c.query.includes("issueLabelCreate"));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);

    // The atomic transition was applied
    const updateCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the new state label was included and the old one removed
    const vars = updateCalls[0].variables as { labelIds?: string[] };
    expect(vars.labelIds).toContain("new-label-id"); // newly created label
    expect(vars.labelIds).not.toContain("scan-lbl"); // old state label removed
    expect(vars.labelIds).toContain("other-lbl");    // non-state labels kept
    expect(vars.labelIds).toContain("wf-lbl");        // workflow label kept
  });

  it("reliably stamps label when the label already exists (no create needed)", async () => {
    // Arrange: team already has state:determining-scope
    const { fetch: mock, calls } = makeSpawnerTransitionFetch({
      initialLabels: [
        { id: "wf-lbl", name: "wf:sprint-spawner" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      teamLabels: [
        { id: "eval-lbl", name: "state:evaluating" },
        { id: "scan-lbl", name: "state:scanning" },
        { id: "scope-lbl", name: "state:determining-scope" },
      ],
    });
    globalThis.fetch = mock;

    // Act
    const result = await applyStateTransition("collect", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "scanning",
    });

    // Assert: applied, no create call
    expect(result.status).toBe("applied");
    const createCalls = calls.filter((c) => c.query.includes("issueLabelCreate"));
    expect(createCalls.length).toBe(0);

    // State label was swapped correctly
    const updateCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const vars = updateCalls[0].variables as { labelIds?: string[] };
    expect(vars.labelIds).toContain("scope-lbl");
    expect(vars.labelIds).not.toContain("scan-lbl");
  });

  it("reports label-resolve-failed gracefully when creation fails (no silent failure)", async () => {
    // Arrange: label missing AND creation fails
    const { fetch: mock, calls } = makeSpawnerTransitionFetch({
      initialLabels: [
        { id: "wf-lbl", name: "wf:sprint-spawner" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      teamLabels: [
        { id: "eval-lbl", name: "state:evaluating" },
        { id: "scan-lbl", name: "state:scanning" },
      ],
      createLabelFailure: true,
    });
    globalThis.fetch = mock;

    // Act
    const result = await applyStateTransition("collect", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "scanning",
    });

    // Assert: failure properly reported
    expect(result.status).toBe("failed");
    expect(result.code).toBe("label-resolve-failed");

    // No atomic transition was applied
    const updateCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCalls.length).toBe(0);
  });
});
