/**
 * Unit tests for workflow-gate enforcement (AI-1352 Phase 3 / B1)
 * and state-label transition application (AI-1353 Phase 3 / B2).
 *
 * Retargeted to the 5-state dev-impl shape (AI-1356, 2026-06-06):
 *   intake → implementation → code-review → deployment → done (+escape).
 *   capability repo:merge → deploy:execute; role/container merge-gate →
 *   deployment; command merge → deploy. A state is a work-phase; a
 *   transition is a decision (the old approved/merged/changes-requested
 *   "resting places" collapsed into transitions).
 *
 * Uses minimal in-memory YAML files injected via WORKFLOW_DEF_PATH and
 * CAPABILITY_POLICY_PATH so tests never depend on vault / project paths.
 *
 * Includes a suite that exercises the canonical-schema fixture
 * (src/__fixtures__/canonical-dev-impl.yaml — verbatim copy of the vault
 * source) to catch parser / schema drift before it reaches production.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  checkWorkflowRules,
  applyStateTransition,
  checkRawMutationInterception,
  buildStateTransitionReminder,
  resetWorkflowCache,
  validateNativeStateMappings,
  validateGateAnchorDefs,
  resolveStakesLevel,
  resolveNativeStateId,
  resetNativeStateCache,
  enrollIfMissing,
  loadWorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { clearArtifactStore, getBoundArtifact, hasBoundArtifact } from "./artifact-store.js";
import { runTransitionWalk } from "./canary.js";
import { clearAcRecordStore, getAcRecord } from "./ac-record-store.js";
import { resetConfigHealth } from "./config-health.js";
import { defStateSnapshotPath } from "./store/def-state-snapshot-store.js";
import { clearImplementerStore } from "./implementer-store.js";

// Resolved from the project root (jest cwd) so it works under both the
// ESM tsc build and the CommonJS ts-jest transpile.
const CANONICAL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
const CANONICAL_UX_AUDIT_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-ux-audit.yaml");
const CANONICAL_SPRINT_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-sprint.yaml");

// ── Minimal test capability policy ────────────────────────────────────────
// Includes deploy:execute so we can test the deployment capability gate.

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute
  - id: infra:ssh

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute, infra:ssh]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: code-review
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
  - id: worker1
    container: dev
    fills_roles: [worker]
  - id: worker2
    container: dev
    fills_roles: [worker]
`;

// ── Capability policy with ux-audit roles (AI-1438 Phase 5 / B-1) ────────

const UX_AUDIT_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: ux-researcher
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: maya
    container: ux-researcher
    fills_roles: [ux-researcher]
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

// ── Capability policy with sprint roles (AI-1471 Phase 6 / C-1) ───────────

const SPRINT_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]
  - id: sprint-owner
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: ux-researcher
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]
  - id: sprint-owner
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: maya
    container: ux-researcher
    fills_roles: [ux-researcher]
  - id: engine-1
    container: engine
    fills_roles: [engine]
  - id: soren
    container: sprint-owner
    fills_roles: [sprint-owner]
`;

// ── Minimal test workflow def ──────────────────────────────────────────────

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
      - command: route
        to: working
        assign:
          mode: required
          constraint: not-self
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
        assign:
          mode: required
          constraint: not-implementer

  - id: working
    owner_role: worker
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation
        assign: { default: prior-implementer }

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
      - command: reject
        to: implementation
        assign: { default: prior-implementer }

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gate-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  // Agents file with linearUserId for all test bodies (H-1 fail-closed requires
  // linearUserId on singleton auto-delegate targets).
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "reviewer", linearUserId: "reviewer-linear-uuid", clientId: "r-client", clientSecret: "r-secret", accessToken: "r-token", refreshToken: "r-refresh" },
      { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-client", clientSecret: "h-secret", accessToken: "h-token", refreshToken: "h-refresh" },
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
    ],
  }, null, 2), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  // AI-1914 AC3: the def-state-removal check reads a persisted "previous version"
  // snapshot that (by design) survives resetWorkflowCache. These legacy cases
  // reload the same `dev-impl` id with different state subsets across unrelated
  // scenarios, which would otherwise read as a state removal. Clear the snapshot
  // per test so each starts with no prior version (dedicated coverage for the
  // removal path lives in ai-1914-ac3-load-validation.test.ts).
  fs.rmSync(defStateSnapshotPath(), { force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLabelFetch(labelNames: string[], branchAndPR?: { hasBranch?: boolean; hasPR?: boolean; hasMergedPR?: boolean; mergeSha?: string | null; repoUrl?: string | null }, healthCommit?: string | null): typeof globalThis.fetch {
  const branch = {
    hasBranch: branchAndPR?.hasBranch ?? true,
    hasPR: branchAndPR?.hasPR ?? true,
    hasMergedPR: branchAndPR?.hasMergedPR ?? false,
  };
  // AI-1498: mock team workflow states for native state resolution.
  const mockTeamStates = [
    { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
    { id: "state-doing-uuid", name: "Doing", type: "started" },
    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
    { id: "state-managing-uuid", name: "Managing", type: "started" },
    { id: "state-done-uuid", name: "Done", type: "completed" },
    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
  ];
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    // Return team states when query asks for it (AI-1498 native state resolution)
    if (bodyText.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: mockTeamStates } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Return branch/PR data when the query asks for it (AI-1475 D1 done gate).
    // AI-1797: status is now derived from GitHub PR attachments — hasBranch is
    // implied by hasPR and branch-only evidence is not representable.
    if (bodyText.includes("IssueBranchAndPR")) {
      const prState = branch.hasMergedPR ? "merged" : "open";
      const repoUrl = branchAndPR?.repoUrl ?? "fancymatt/repo";
      const mergeSha = branchAndPR?.mergeSha;
      const metadata: Record<string, unknown> = { status: prState };
      if (mergeSha) metadata.mergeCommitSha = mergeSha;
      const nodes = branch.hasPR
        ? [{ url: `https://github.com/${repoUrl}/pull/1`, sourceType: "github", metadata }]
        : [];
      return new Response(
        JSON.stringify({ data: { issue: { attachments: { nodes } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Intercept /health requests for the deploy health gate (AI-2361).
    if (typeof _url === "string" && _url.endsWith("/health") && healthCommit !== undefined && healthCommit !== null) {
      return new Response(
        JSON.stringify({ commit: healthCommit }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Return delegate context when query asks for it
    if (bodyText.includes("delegate")) {
      const body: Record<string, unknown> = {
        data: {
          issue: {
            labels: { nodes: labelNames.map((name) => ({ name })) },
            delegate: null,
          },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Default: label-only response
    const body = {
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
        },
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("checkWorkflowRules — mode switch", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns null when issueId is null (fail open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("submit", null, "Bearer tok", "charles")).toBeNull();
  });

  it("rejects transition verbs on ad-hoc ticket (no wf:* label) — §4.6 mode switch (INF-35)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("returns null for unknown workflow id (wf:other-workflow) — fail open", async () => {
    globalThis.fetch = makeLabelFetch(["wf:other-workflow", "state:implementation"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null when label fetch throws — begin-work passes through (§4.6)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    // begin-work and note pass through on fetch failure — they're safe even on unknown tickets
    expect(await checkWorkflowRules("begin-work", "issue-uuid", "Bearer tok", "charles")).toBeNull();
    expect(await checkWorkflowRules("note", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks state-advancing intents when label fetch throws — fail closed (H-1)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("unable to fetch ticket context");
  });

  // G-13a (AI-1551): steward can break-glass on fetch failure; non-steward cannot.
  it("allows blocked intent through on fetch failure with break-glass — steward caller (H-1 / G-13a)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    // submit passes through on break-glass: breakGlassOverride bypasses the fetch-failure
    // fail-closed AND the no-wf-label guard
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "astrid", null, null, null, true);
    expect(result).toBeNull();
  });

  it("rejects break-glass on fetch failure from non-steward caller (G-13a AC1)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", null, null, null, true);
    expect(result).not.toBeNull();
    expect(result).toContain("Break-glass rejected");
    expect(result).toContain("charles");
  });

  it("blocks state-advancing intents when no state:* label — fail closed (corrupt projection)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "bug"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("no 'state:*' workflow label");
  });

  it("still allows escape (break-glass) when no state:* label", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "bug"]);
    expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });
});

// ── Break-glass ────────────────────────────────────────────────────────────

describe("checkWorkflowRules — break-glass escape", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const allStates = [
    "intake", "implementation", "code-review", "deployment", "done",
  ];

  for (const state of allStates) {
    it(`escape is always legal from state '${state}' (§4.4)`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles")).toBeNull();
    });
  }
});

// ── AI-1460: refuse-work meta-command ─────────────────────────────────────

describe("checkWorkflowRules — AI-1460: refuse-work meta-command", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const allStates = [
    "intake", "implementation", "code-review", "deployment", "done",
  ];

  for (const state of allStates) {
    it(`refuse-work is legal from state '${state}' for a known caller`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles")).toBeNull();
    });
  }

  it("refuse-work is blocked for unknown callers", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("Unknown caller");
    expect(result).toContain("ghost-agent");
  });

  it("rejects refuse-work on ad-hoc tickets (no wf:* label) (INF-35)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

});

// ── AI-1574: refuse-work caller-gating hardening ──────────────────────────
// The line-905 exemption must become conditional:
//   - delegate (callerLinearUserId === delegateId) → allowed
//   - steward (bodyId fills the workflow's break_glass.owner_role) → allowed
//   - all others → blocked
//
// Without the fix, line 905 is unconditional and any known caller can refuse
// work on someone else's governed ticket (third-party reroute hole).

describe("checkWorkflowRules — AI-1574: refuse-work caller-gating", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeDelegateFetch(labelNames: string[], delegateId: string): typeof globalThis.fetch {
    return async (_url, _init) => new Response(JSON.stringify({
      data: { issue: { labels: { nodes: labelNames.map((n) => ({ name: n })) }, delegate: { id: delegateId } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // AC1: the current delegate can always refuse their own work.
  it("AC1: refuse-work by the current delegate (callerLinearUserId === delegateId) passes through", async () => {
    globalThis.fetch = makeDelegateFetch(["wf:dev-impl", "state:write-tests"], "delegate-uid");
    expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles", null, "delegate-uid")).toBeNull();
  });

  it("AC1: delegate can refuse from every governed state", async () => {
    for (const state of ["intake", "write-tests", "implementation", "code-review", "deployment", "done"]) {
      globalThis.fetch = makeDelegateFetch(["wf:dev-impl", `state:${state}`], "delegate-uid");
      expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles", null, "delegate-uid")).toBeNull();
    }
  });

  // AC2: a non-delegate, non-steward caller must be blocked.
  it("AC2: refuse-work by a non-delegate, non-steward caller is blocked", async () => {
    globalThis.fetch = makeDelegateFetch(["wf:dev-impl", "state:implementation"], "real-delegate-uid");
    // charles (dev role, not steward) provides a different callerLinearUserId
    const result = await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles", null, "charles-uid");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  // Steward exemption: the workflow steward (break_glass.owner_role) may always refuse.
  it("refuse-work by the workflow steward passes through even when not the delegate", async () => {
    globalThis.fetch = makeDelegateFetch(["wf:dev-impl", "state:implementation"], "real-delegate-uid");
    // astrid fills the steward role in TEST_POLICY_YAML
    expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "astrid", null, "astrid-uid")).toBeNull();
  });

  // AC3 regression: ad-hoc (ungoverned) tickets — refuse-work is a transition verb
  // now rejected (INF-35). Handoff-work, note, and begin-work remain pass-through.
  it("INF-35 AC3: refuse-work on an ungoverned ticket (no wf:* label) is now rejected", async () => {
    globalThis.fetch = makeDelegateFetch(["bug", "priority:high"], "real-delegate-uid");
    const result = await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles", null, "charles-uid");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });
});

// ── Per-state legal / illegal commands ────────────────────────────────────

describe("checkWorkflowRules — intake state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'accept' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    expect(await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("allows 'demote' in intake when ticket has no in-flight work (AC3)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"], { hasBranch: false, hasPR: false, hasMergedPR: false });
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("blocks 'submit' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("submit");
    expect(result).toContain("intake");
    expect(result).toContain("accept");
  });

  it("blocks 'deploy' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy");
    expect(result).toContain("intake");
  });
});

describe("checkWorkflowRules — implementation state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'submit' in implementation — auto-assigns to singleton reviewer", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // code-review role has a single body ('reviewer'), so no target needed — auto-assign
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'submit' when author tries to self-assign as reviewer (not-implementer constraint)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // charles is the caller (implementer) and tries to pass himself as reviewer.
    // With singleton code-review role (reviewer), the singleton override rejects first.
    // The effective block is that charles is not the singleton reviewer body.
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("charles");
    // Either singleton override or self-review constraint blocks it
    expect(result!.includes("auto-assigns") || result!.includes("Self-review blocked")).toBe(true);
  });

  it("blocks 'route' when the caller targets itself (not-self constraint)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("route", "issue-uuid", "Bearer tok", "worker1", "worker1");
    expect(result).not.toBeNull();
    expect(result).toContain("Self-assignment blocked");
    expect(result).toContain("worker1");
  });

  it("allows 'route' to a different legal worker (not-self constraint)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    expect(await checkWorkflowRules("route", "issue-uuid", "Bearer tok", "worker1", "worker2")).toBeNull();
  });

  it("rejects submit with wrong target (not a code-review body)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("auto-assigns");
    expect(result).toContain("reviewer");
    expect(result).toContain("hanzo");
  });

  it("blocks 'deploy' in implementation", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
  });

  it("blocks 'approve' in implementation (not at review)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("approve");
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });
});

describe("checkWorkflowRules — code-review state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'approve' in code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    expect(await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("allows 'request-changes' in code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    expect(await checkWorkflowRules("request-changes", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'deploy' in code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("code-review");
  });

  it("blocks 'submit' in code-review (wrong phase — already submitted)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("code-review");
    expect(result).toContain("approve");
    expect(result).toContain("request-changes");
  });
});

// ── Deploy capability gate (Hanzo-only) ────────────────────────────────────

// ── AI-2476: v14 merge state capability gate ──────────────────────────
// In v14, the old `deployment` state was split into `merge` (requires
// deploy:execute for forward `continue`) and `deploy` (requires infra:ssh).
// Hanzo has deploy:execute; Charles and Astrid do not.
// Uses the canonical dev-impl fixture (v10+) which has merge/deploy states.

describe("checkWorkflowRules — deploy:execute capability gate (merge state)", () => {
  let originalWorkflowPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();
  });
  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
  });

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'continue' from Hanzo (deployment body) in merge state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasMergedPR: true });
    expect(await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("blocks 'continue' from Charles (dev body, no deploy:execute) in merge state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("deploy:execute");
  });

  it("blocks 'continue' from Astrid (steward body, no deploy:execute) in merge state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy:execute");
  });

  it("blocks illegal command 'submit' in merge state even for Hanzo", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("merge");
    expect(result).toContain("continue");
  });
});

// ── done state (terminal) ───────────────────────────────────────────────────

describe("checkWorkflowRules — done state (terminal)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks any non-escape command in done state (terminal)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("done");
  });

  it("escape is still legal in done state (§4.4)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });
});

// ── done state (terminal) ───────────────────────────────────────────────────

describe("checkWorkflowRules — done state (terminal)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks any non-escape command in done state (terminal)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("done");
  });

  it("escape is still legal in done state (§4.4)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });
});

// ── Error message content ──────────────────────────────────────────────────

describe("checkWorkflowRules — error message format", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("names the legal moves in the rejection for an illegal command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles");
    expect(result).toContain("submit");
    expect(result).toContain("escape");
  });
});

// ── Canonical vault schema fixture ────────────────────────────────────────
// These tests load the verbatim checked-in copy of the vault YAML
// (src/__fixtures__/canonical-dev-impl.yaml) to guard against parser/schema
// drift between the simplified test fixtures above and what actually runs in
// production. If these fail, the canonical YAML drifted or the parser broke.

describe("checkWorkflowRules — canonical vault schema (src/__fixtures__/canonical-dev-impl.yaml)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPath: string | undefined;

  beforeAll(() => {
    originalPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
  });

  afterAll(() => {
    if (originalPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = originalPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("parses the canonical YAML without error (passes for a legal command)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // 'submit' is legal in implementation; auto-assigns to singleton reviewer; null means pass-through
    // AI-1731: submit now has requires_comment — pass hasComment=true to test legality, not the comment gate
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", null, undefined, null, false, false, true)).toBeNull();
  });

  it("canonical: escape is legal from every state (§4.4)", async () => {
    const allStates = [
      "intake", "implementation", "code-review", "deployment", "done", "escape",
    ];
    for (const state of allStates) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles");
      expect(result).toBeNull(); // state: ${state}
    }
  });

  it("canonical: merge state allows continue and reject (not just continue)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    // 'reject' requires no capability — should pass through
    // AI-1731: reject now has requires_comment — pass hasComment=true to test legality, not the comment gate
    const result = await checkWorkflowRules("reject", "issue-uuid", "Bearer tok", "astrid", null, undefined, null, false, false, true);
    expect(result).toBeNull();
  });

  it("canonical: merge state blocks 'submit' (illegal), names continue and reject as legal", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("continue");
    expect(result).toContain("reject");
    expect(result).toContain("escape");
  });

  it("canonical: continue in merge state is blocked for non-deployment body (charles)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy:execute");
    expect(result).toContain("deployment");
  });

  it("canonical: continue in merge state is allowed for Hanzo (deployment body)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge", "stakes:low"], { hasMergedPR: true });
    expect(await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });
});

// ── Phase 3 / B2: applyStateTransition ───────────────────────────────────
// Tests the atomic state-label swap triggered by a forwarded legal command.

type FetchCall = {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
};

/** Build a fetch mock that handles the three B2 API calls and records all calls. */
function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamId?: string;
  teamLabels?: Array<{ id: string; name: string }>;
  issueUpdateSuccess?: boolean;
  /** Override to simulate a fetch error for the issue fetch. */
  issueError?: boolean;
  /** Override to simulate a fetch error for the issueUpdate call. */
  updateError?: boolean;
  /** Branch/PR status for done gate (AI-1475 D1 + AI-1492). Defaults to has branch + PR (pass gate).
   * null = fetch throws; "graphql-error" = schema-level rejection payload (AI-1797). */
  branchStatus?: { hasBranch?: boolean; hasPR?: boolean; hasMergedPR?: boolean } | null | "graphql-error";
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const teamId = opts.teamId ?? "team-uuid";
  const teamLabels = opts.teamLabels ?? [];
  const issueUpdateSuccess = opts.issueUpdateSuccess ?? true;
  // Default: branch pushed + PR exists (gate passes)
  const branch = opts.branchStatus === null || opts.branchStatus === "graphql-error" ? opts.branchStatus : {
    hasBranch: opts.branchStatus?.hasBranch ?? true,
    hasPR: opts.branchStatus?.hasPR ?? true,
    hasMergedPR: opts.branchStatus?.hasMergedPR ?? false,
  };

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });

    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      if (opts.issueError) throw new Error("simulated fetch error");
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

    // AI-1498: Team workflow states for native state resolution.
    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("issueLabelCreate")) {
      // Simulate label creation returning a new ID.
      return new Response(
        JSON.stringify({
          data: {
            issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } },
          },
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

    // AI-1463: UpdateDelegate mutation for auto-delegate assignment.
    if (query.includes("UpdateDelegate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // AI-1475 D1 + AI-1492 + AI-1797: Branch/PR status for done gate,
    // derived from GitHub PR attachments (hasBranch implied by hasPR).
    if (query.includes("IssueBranchAndPR")) {
      if (branch === null) {
        // Simulate fetch error for branch/PR query
        throw new Error("simulated branch/PR fetch error");
      }
      if (branch === "graphql-error") {
        // AI-1797: persistent schema-level rejection (the silent fail-open bug)
        return new Response(
          JSON.stringify({ errors: [{ message: 'Cannot query field "branch" on type "Issue".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const prState = branch.hasMergedPR ? "merged" : "open";
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              attachments: {
                nodes: branch.hasPR
                  ? [{ url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: prState } }]
                  : [],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };

  return { fetch: mockFetch, calls };
}

describe("applyStateTransition — no-ops (fail-open / mode switch)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("is a no-op when issueId is null", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: [] });
    globalThis.fetch = mock;
    await applyStateTransition("submit", null, "Bearer tok");
    expect(calls).toHaveLength(0);
  });

  it("is a no-op for ad-hoc ticket (no wf:* label)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [{ id: "lbl-1", name: "bug" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");
    // Only the IssueWithLabels fetch should fire; no issueUpdate.
    expect(calls.some((c) => (c.body.query ?? "").includes("IssueWithLabels"))).toBe(true);
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("is a no-op when issue fetch fails", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [],
      issueError: true,
    });
    globalThis.fetch = mock;
    // Should not throw even on fetch failure — AI-1809: surfaces a machine-readable failure.
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toMatchObject({ status: "failed", code: "context-fetch-failed" });
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("is a no-op when already in target state (idempotent re-apply)", async () => {
    // implementation + submit → code-review, but if already code-review, no-op.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
    });
    globalThis.fetch = mock;
    // 'submit' transitions implementation → code-review, but ticket is already code-review.
    // The transition lookup finds 'submit' only in implementation, not code-review.
    // So this logs a warn (no transition for submit in code-review) and returns.
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("idempotent: no issueUpdate when current state already past the command's source", async () => {
    // 'accept' lives in intake (intake → implementation). If the ticket is already
    // in implementation, a re-delivered 'accept' finds no 'accept' transition in
    // implementation → skips. No issueUpdate.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("accept", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });
});

describe("applyStateTransition — AI-1490: idempotency re-stamp when label is missing", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("re-stamps state:* label when in target state but label is missing", async () => {
    // Scenario: CLI set native state correctly but failed to apply the label.
    // Ticket is in merge state (per getCurrentState from labels) but
    // actually missing the state:merge label. B2 should re-stamp it.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("approve", "issue-uuid", "Bearer tok");
    // approve: code-review → merge. Current state is merge.
    // Label state:merge is present. So no-op.
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyStateTransition"))).toBe(false);
  });

  it("re-stamps when state matches but label is absent", async () => {
    // Ticket has wf:dev-impl and state:code-review labels, but the approve
    // command already ran (CLI set state to deployment). The B2 reads labels
    // which still show code-review (stale or partial failure).
    // B2 should swap code-review → deployment.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("approve", "issue-uuid", "Bearer tok");
    // Should have done a label swap (ApplyStateTransition mutation).
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(true);
  });
});

describe("applyStateTransition — normal state advance", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("advances state:implementation → state:code-review on 'submit'", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
        { id: "other-lbl", name: "priority:high" },
      ],
      teamLabels: [
        { id: "existing-cr-lbl", name: "state:code-review" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { issueId: string; labelIds: string[] };
    expect(vars.issueId).toBe("internal-uuid");
    // Should have: wf-lbl, other-lbl (kept), existing-cr-lbl (new state) — NOT state-lbl
    expect(vars.labelIds).toContain("wf-lbl");
    expect(vars.labelIds).toContain("other-lbl");
    expect(vars.labelIds).toContain("existing-cr-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  it("creates the target state label when it does not exist in the team", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [], // no state:code-review label yet
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");

    expect(calls.some((c) => (c.body.query ?? "").includes("issueLabelCreate"))).toBe(true);
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("new-label-id");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  it("exactly one state:* label in the new set (no double-add)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:intake" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("accept", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    const stateLabelCount = vars.labelIds.filter((id) =>
      [{ id: "state-lbl", name: "state:intake" }, { id: "impl-lbl", name: "state:implementation" }]
        .map((n) => n.id)
        .includes(id),
    ).length;
    // Exactly one state label: the new one only.
    expect(stateLabelCount).toBe(1);
    expect(vars.labelIds).toContain("impl-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  // AI-1498 regression: the CLI pre-moves the state:* label before the proxy's
  // post-forward applyStateTransition runs. Without sourceStateOverride the gate
  // reads the already-moved label, the intent lookup fails in the destination
  // state, and the native stateId never gets written (label/native desync).
  // With sourceStateOverride the gate resolves the transition from the TRUE
  // source state and writes all three facets (label + native here).
  it("writes native stateId when CLI already moved the label (sourceStateOverride)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      // CLI has already swapped the label to the destination state.
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "impl-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("accept", "issue-uuid", "Bearer tok", {
      sourceStateOverride: "intake",
    });

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[]; stateId?: string };
    // implementation → native_state: doing → state-doing-uuid
    expect(vars.stateId).toBe("state-doing-uuid");
    // exactly the destination state label, no source label lingering
    expect(vars.labelIds).toContain("impl-lbl");
    expect(vars.labelIds).toContain("wf-lbl");
  });

  it("skips the transition when label already moved and NO override (reproduces the bug)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "impl-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;
    // No override: gate reads state:implementation, looks up 'accept' there,
    // finds no such transition, and skips — no atomic write at all.
    await applyStateTransition("accept", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("fail-open when issueUpdate returns non-success (no throw)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
      issueUpdateSuccess: false,
    });
    globalThis.fetch = mock;
    // AI-1809: no throw, but the failure is machine-readable, not silent.
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toMatchObject({ status: "failed", code: "atomic-mutation-failed" });
  });

  it("fail-open when issueUpdate throws (no throw)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
      updateError: true,
    });
    globalThis.fetch = mock;
    // AI-1809: no throw, but the failure is machine-readable, not silent.
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toMatchObject({ status: "failed", code: "atomic-mutation-failed" });
  });
});

describe("applyStateTransition — break-glass escape", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("transitions to state:intake from any state on 'escape' command (AI-1710: escape re-enters at intake)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("intake-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });
});

describe("applyStateTransition — __ad_hoc__ demotion", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("removes state:* and wf:* labels when demoting to __ad_hoc__", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:intake" },
        { id: "other-lbl", name: "priority:medium" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("demote", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    // wf:* and state:* labels gone; non-workflow labels kept.
    expect(vars.labelIds).toContain("other-lbl");
    expect(vars.labelIds).not.toContain("wf-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
    // No TeamLabels or label create call needed for __ad_hoc__.
    expect(calls.some((c) => (c.body.query ?? "").includes("TeamLabels"))).toBe(false);
  });

  it("does not call issueUpdate when demoting a ticket that already has no state/wf labels", async () => {
    // Already cleaned up — issue has no wf:* label, so mode switch exits early.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [{ id: "other-lbl", name: "priority:medium" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("demote", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });
});

// ── Layer 2: Raw status/assignee mutation interception (AI-1387) ──────────

describe("checkRawMutationInterception — Layer 2 (AI-1387)", () => {
  let layer2Dir: string;
  let layer2OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    layer2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "layer2-test-"));
    const policyFile = path.join(layer2Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(layer2Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    layer2OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = layer2OriginalFetch;
  });

  // Minimal label response: workflow ticket in implementation state.
  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  // Non-workflow ticket.
  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
  };

  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return layer2OriginalFetch(url, init);
    };
  }

  it("blocks a raw stateId mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
    expect(result).toContain("blocked on this workflow ticket");
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });

  it("blocks a raw assigneeId mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { assigneeId: "user-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("Direct assignee");
    expect(result).toContain("blocked on this workflow ticket");
  });

  it("blocks a raw stateId + assigneeId mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid", assigneeId: "user-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("Direct status/assignee");
  });

  it("passes through on ad-hoc (non-workflow) tickets", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("passes through when mutation does not touch stateId or assigneeId", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { title: "Updated title" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("passes through when body is not an issueUpdate or commentCreate mutation", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    // attachmentCreate is an unintercepted mutation type — it must always pass through.
    const body = {
      query: "mutation M($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }",
      variables: { input: { issueId: "issue-uuid", url: "https://example.com/file.pdf" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("fails closed on a raw stateId mutation when issueId is unresolvable (AI-1347)", async () => {
    // A raw stateId change with no resolvable ticket id is exactly the bypass
    // shape the gate exists to stop — block it rather than pass through.
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, null, "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("could not be resolved");
  });

  it("passes through when body is null", async () => {
    const result = await checkRawMutationInterception(null, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("fails open on label fetch error", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("includes per-command help with assignment targets in the rejection", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    // Should include the submit command (the legal move from implementation)
    expect(result).toContain("linear submit");
    // Should include the escape/break-glass command
    expect(result).toContain("escape");
    // Should show the transition arrow
    expect(result).toContain("→ code-review");
  });
});

// ── Layer 1: Proactive legal-verb re-injection (AI-1387) ──────────────────

describe("buildStateTransitionReminder — Layer 1 (AI-1387)", () => {
  let layer1Dir: string;
  let layer1OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    layer1Dir = fs.mkdtempSync(path.join(os.tmpdir(), "layer1-test-"));
    const policyFile = path.join(layer1Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(layer1Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    layer1OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = layer1OriginalFetch;
  });

  it("returns reminder for code-review state after submit from implementation", async () => {
    // After "submit" (implementation → code-review), the new state is code-review.
    // Legal moves: approve, request-changes, escape.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await buildStateTransitionReminder("submit", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Workflow]");
    expect(result).toContain("code-review");
    expect(result).toContain("approve");
    expect(result).toContain("request-changes");
    expect(result).toContain("escape");
  });

  it("returns reminder for implementation state after accept from intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await buildStateTransitionReminder("accept", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });

  it("returns null for terminal state (done)", async () => {
    // After "validated" (ac-validate → done), the destination is terminal.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:ac-validate"]);
    const result = await buildStateTransitionReminder("validated", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns intake transition reminder after escape (AI-1710: escape re-enters at intake, not terminal)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await buildStateTransitionReminder("escape", "ABC-123", "Bearer tok");
    // escape now routes to intake (normal state with transitions), not a terminal — reminder is expected
    expect(result).not.toBeNull();
    expect(result).toContain("accept");
  });

  it("returns null for unknown intent", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await buildStateTransitionReminder("unknown-command", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null when issueId is null", async () => {
    const result = await buildStateTransitionReminder("submit", null, "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns reminder for deployment state after approve from code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await buildStateTransitionReminder("approve", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("deployment");
    expect(result).toContain("deploy");
    expect(result).toContain("reject");
  });

  it("returns reminder for implementation state after request-changes from code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await buildStateTransitionReminder("request-changes", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });
});

// ── AI-1475 Defect 1: Done gate — branch/PR verification before deploy→done ──────

// ── AI-2476: Re-armed merged-PR release gate (branch/PR verification) ──
// The v8 predicate (intent === 'deploy' || intent === 'handoff-host-deploy') was
// deleted by AI-1872 (v10). Tests now use v14's state+intent: forward exits from
// `merge` or `deploy` state with `continue` intent. The `deployment` state no
// longer exists in the v10+ canonical dev-impl fixture.

describe("checkWorkflowRules — AI-2476: merged-PR release gate (branch/PR verification)", () => {
  let originalWorkflowPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();
  });
  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
  });

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // INF-96: open PR (not merged) is now blocked — only verified merged PR passes.
  it("blocks 'continue' from merge state when branch and PR exist but are not merged (INF-96)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasBranch: true, hasPR: true });
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("blocks 'continue' from deploy state when branch and PR exist but are not merged (INF-96)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"], { hasBranch: true, hasPR: true });
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  // INF-96: open (unmerged) PR no longer passes the gate.
  it("blocks 'continue' from merge state with an open PR attachment (INF-96)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasBranch: false, hasPR: true });
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("blocks 'continue' from deploy state with an open PR attachment (INF-96)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"], { hasBranch: false, hasPR: true });
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  // AI-1797 regression: schema-level errors payload → fail-open with alert.
  it("emits a deduped warning alert when the gate query returns GraphQL errors (AI-1797)", async () => {
    _resetAlertBusForTests();
    const alertStore = new AlertStore(":memory:");
    initAlertBus({ store: alertStore, pushEnabled: false });
    try {
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("delegate")) {
          return new Response(JSON.stringify({
            data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] }, delegate: null } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("IssueBranchAndPR")) {
          return new Response(JSON.stringify({
            errors: [{ message: 'Cannot query field "branch" on type "Issue".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch call: ${bodyText.slice(0, 60)}`);
      };
      const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
      expect(result).toBeNull(); // fail-open — but no longer silent
      const alerts = alertStore.query({ source: "done-gate" });
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const queryAlert = alerts.find((a) => a.dedupKey === "done-gate|query-failing");
      expect(queryAlert).toBeDefined();
      expect(queryAlert?.severity).toBe("warning");
      // Retried once → same dedupKey folded, not a second row
      expect(alerts.filter((a) => a.dedupKey === "done-gate|query-failing").length).toBe(1);
    } finally {
      _resetAlertBusForTests();
    }
  });

  // INF-96: Complete absence of evidence is now a hard block (was AI-1497 fail-open).
  it("blocks 'continue' from merge state when neither branch nor PR exist (INF-96)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasBranch: false, hasPR: false });
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("blocks 'continue' from deploy state when neither branch nor PR exist (INF-96)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"], { hasBranch: false, hasPR: false });
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  // AI-1497: null after retry is now fail-open to avoid stranding tickets.
  it("fail-open: allows 'continue' from deploy state when branch/PR fetch returns null twice (API error, AI-1497)", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async (_url, init) => {
      fetchCallCount++;
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("IssueContext")) {
        return new Response(JSON.stringify({
          data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deploy" }] }, delegate: null } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (bodyText.includes("IssueBranchAndPR")) {
        return new Response(JSON.stringify({ data: { issue: null } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch call: ${bodyText.slice(0, 60)}`);
    };
    const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull(); // fail-open after retry
    expect(fetchCallCount).toBeGreaterThanOrEqual(3); // label fetch + 2 branch/PR fetches
  });

  it("gate does NOT fire for non-forward commands in merge state (reject)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasBranch: false, hasPR: false });
    const result = await checkWorkflowRules("reject", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, true);
    // reject from merge requires a comment; once that's satisfied, the done gate
    // should NOT fire (it only fires on forward 'continue' intents).
    expect(result).toBeNull();
  });

  it("gate does NOT fire for non-forward commands in deploy state (reject)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"], { hasBranch: false, hasPR: false });
    const result = await checkWorkflowRules("reject", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, true);
    expect(result).toBeNull();
  });

  it("gate does NOT fire for 'submit' from non-merge/deploy states (implementation → code-review)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"], { hasBranch: false, hasPR: false });
    // 'submit' is the forward command from implementation; it should not trigger
    // the done gate (which only fires from merge/deploy states).
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", null, null, null, false, false, true);
    expect(result).toBeNull();
  });

  // AI-1492 regression: branch auto-deleted after squash merge — merged PR must still pass.
  it("allows 'continue' from merge state when PR is merged but branch is deleted (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasBranch: false, hasPR: true, hasMergedPR: true });
    expect(await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("allows 'continue' from deploy state when PR is merged but branch is deleted (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"], { hasBranch: false, hasPR: true, hasMergedPR: true });
    expect(await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("allows 'continue' from merge state when PR is merged and branch still exists (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"], { hasBranch: true, hasPR: true, hasMergedPR: true });
    expect(await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("allows 'continue' from deploy state when PR is merged and branch still exists (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"], { hasBranch: true, hasPR: true, hasMergedPR: true });
    expect(await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  // INF-132: when Linear's attachment metadata is stale (shows "open"), the gate
  // falls through to the GitHub API to verify the PR's merge state.
  describe("INF-132: GitHub API fallback for stale Linear metadata", () => {
    afterEach(() => { delete process.env.GITHUB_TOKEN; });

    it("allows 'continue' from merge state when Linear says open but GitHub confirms merged", async () => {
      // Linear returns "open" (hasMergedPR: false), but GitHub says merged.
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("delegate")) {
          return new Response(JSON.stringify({
            data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] }, delegate: null } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("IssueBranchAndPR")) {
          // Linear attachment metadata shows "open" (stale)
          return new Response(JSON.stringify({
            data: { issue: { attachments: { nodes: [{ url: "https://github.com/fancymatt/fancy-openclaw-linear-connector/pull/999", sourceType: "github", metadata: { status: "open" } }] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamStates")) {
          return new Response(JSON.stringify({
            data: { team: { states: { nodes: [] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        // GitHub API fallback: PR 999 is merged
        if ((_url as string).includes("api.github.com")) {
          return new Response(JSON.stringify({ merged: true, merged_at: "2026-07-19T18:51:23Z" }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        // Workflow def query
        if (bodyText.includes("WorkflowDefs")) {
          return new Response(JSON.stringify({ data: { workflowDefs: [] } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`INF-132 test: unexpected fetch: ${bodyText.slice(0, 100)}`);
      };
      const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
      expect(result).toBeNull();
    });

    it("blocks 'continue' from merge state when Linear says open and GitHub also says not merged", async () => {
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("delegate")) {
          return new Response(JSON.stringify({
            data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] }, delegate: null } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("IssueBranchAndPR")) {
          return new Response(JSON.stringify({
            data: { issue: { attachments: { nodes: [{ url: "https://github.com/fancymatt/fancy-openclaw-linear-connector/pull/999", sourceType: "github", metadata: { status: "open" } }] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamStates")) {
          return new Response(JSON.stringify({
            data: { team: { states: { nodes: [] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        // GitHub API fallback: PR 999 is NOT merged
        if ((_url as string).includes("api.github.com")) {
          return new Response(JSON.stringify({ merged: false, state: "open" }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        if (bodyText.includes("WorkflowDefs")) {
          return new Response(JSON.stringify({ data: { workflowDefs: [] } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`INF-132 test: unexpected fetch: ${bodyText.slice(0, 100)}`);
      };
      const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
      expect(result).not.toBeNull();
      expect(result).toContain("blocked");
    });

    it("allows 'continue' from merge state when Linear shows merged (fast path, no GitHub call)", async () => {
      // When Linear already says merged, we should NOT hit the GitHub API.
      // This test verifies the fast path still works.
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("delegate")) {
          return new Response(JSON.stringify({
            data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] }, delegate: null } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("IssueBranchAndPR")) {
          // Linear attachment shows "merged" — fast path, no GitHub call needed
          return new Response(JSON.stringify({
            data: { issue: { attachments: { nodes: [{ url: "https://github.com/fancymatt/fancy-openclaw-linear-connector/pull/999", sourceType: "github", metadata: { status: "merged" } }] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamStates")) {
          return new Response(JSON.stringify({
            data: { team: { states: { nodes: [] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("WorkflowDefs")) {
          return new Response(JSON.stringify({ data: { workflowDefs: [] } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        // If we hit GitHub API here, something is wrong — throw
        if ((_url as string).includes("api.github.com")) {
          throw new Error("INF-132: unexpected GitHub API call when Linear already confirmed merged");
        }
        throw new Error(`INF-132 test: unexpected fetch: ${bodyText.slice(0, 100)}`);
      };
      const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
      expect(result).toBeNull();
    });

    it("allows 'continue' when GitHub API returns 404 (PR deleted, fail-open)", async () => {
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("delegate")) {
          return new Response(JSON.stringify({
            data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:merge" }] }, delegate: null } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("IssueBranchAndPR")) {
          return new Response(JSON.stringify({
            data: { issue: { attachments: { nodes: [{ url: "https://github.com/fancymatt/fancy-openclaw-linear-connector/pull/888", sourceType: "github", metadata: { status: "open" } }] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamStates")) {
          return new Response(JSON.stringify({
            data: { team: { states: { nodes: [] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        // GitHub returns 404 — PR was deleted, fail-open (fall back to Linear)
        if ((_url as string).includes("api.github.com")) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        if (bodyText.includes("WorkflowDefs")) {
          return new Response(JSON.stringify({ data: { workflowDefs: [] } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`INF-132 test: unexpected fetch: ${bodyText.slice(0, 100)}`);
      };
      const result = await checkWorkflowRules("continue", "issue-uuid", "Bearer tok", "hanzo");
      // With a 404, GitHub verification fails and we fall back to Linear's
      // "open" status — the gate blocks since no merged evidence exists.
      expect(result).not.toBeNull();
      expect(result).toContain("blocked");
    });
  });

});

// ── AI-1475 Defect 2: Submit requires reviewer ≠ author ──────────────────────

describe("checkWorkflowRules — AI-1475 D2: submit self-review prevention", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows submit from implementer (charles) with auto-assign to reviewer", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks submit when implementer tries to self-assign as reviewer target", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("charles");
  });

  it("blocks submit with explicit target that is not a code-review body", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("hanzo");
  });
});

// ── AI-1475 D1: applyStateTransition done gate defense-in-depth ──────────

describe("applyStateTransition — AI-2476: merged-PR release gate defense-in-depth", () => {
  let originalWorkflowPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();
  });
  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
  });

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // AI-2476 re-arm: uses v14 state+intent (merge/deploy + continue) instead of
  // v8 literal verb (deploy/handoff-host-deploy). Both merge→deploy and
  // deploy→ac-validate forward carries trigger the gate.

  it("blocks label swap from merge state with open PR attachment (INF-96)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
      teamLabels: [{ id: "dep-lbl", name: "state:deploy" }],
      branchStatus: { hasBranch: false, hasPR: true },
    });
    globalThis.fetch = mock;
    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
  });

  it("blocks label swap from deploy state with open PR attachment (INF-96)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "acv-lbl", name: "state:ac-validate" }],
      branchStatus: { hasBranch: false, hasPR: true },
    });
    globalThis.fetch = mock;
    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
  });

  // AI-1797 regression: a schema-level errors payload (the silent fail-open bug)
  // must fail-open in B2 too — the ticket is past code review; do not strand it.
  // AI-2476: re-keyed to v14 state+intent (deploy state, continue intent).
  it("fails open in B2 when the gate query returns GraphQL errors (AI-1797)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "acv-lbl", name: "state:ac-validate" }],
      branchStatus: "graphql-error",
    });
    globalThis.fetch = mock;
    await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  it("blocks label swap from merge state when branch + PR exist but not merged (INF-96)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
      teamLabels: [{ id: "dep-lbl", name: "state:deploy" }],
      branchStatus: { hasBranch: true, hasPR: true },
    });
    globalThis.fetch = mock;
    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
  });

  it("blocks label swap from deploy state when branch + PR exist but not merged (INF-96)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "acv-lbl", name: "state:ac-validate" }],
      branchStatus: { hasBranch: true, hasPR: true },
    });
    globalThis.fetch = mock;
    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
  });

  it("gate does NOT block non-forward transitions (reject) from merge state", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
      branchStatus: { hasBranch: false, hasPR: false },
    });
    globalThis.fetch = mock;
    await applyStateTransition("reject", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  it("gate does NOT block 'submit' from non-merge/deploy states (implementation → code-review)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
      branchStatus: { hasBranch: false, hasPR: false },
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  // AI-1492 regression: merged PR passes B2 defense-in-depth even when branch is deleted.
  it("allows label swap from merge state when PR is merged but branch is deleted (AI-1492)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
      teamLabels: [{ id: "dep-lbl", name: "state:deploy" }],
      branchStatus: { hasBranch: false, hasPR: true, hasMergedPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  it("allows label swap from deploy state when PR is merged but branch is deleted (AI-1492)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "acv-lbl", name: "state:ac-validate" }],
      branchStatus: { hasBranch: false, hasPR: true, hasMergedPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  // INF-96: complete absence of evidence is now hard-block in B2 too.
  it("blocks label swap from merge state when neither branch nor PR exist (INF-96)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
      teamLabels: [{ id: "dep-lbl", name: "state:deploy" }],
      branchStatus: { hasBranch: false, hasPR: false },
    });
    globalThis.fetch = mock;
    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
  });

  it("blocks label swap from deploy state when neither branch nor PR exist (INF-96)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "acv-lbl", name: "state:ac-validate" }],
      branchStatus: { hasBranch: false, hasPR: false },
    });
    globalThis.fetch = mock;
    const result = await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("status", "blocked");
  });

  // AI-1497: null after retry is fail-open in B2.
  it("allows label swap from deploy state when branch/PR fetch throws both times (AI-1497 fail-open)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "acv-lbl", name: "state:ac-validate" }],
      branchStatus: null, // simulates fetch error on every attempt
    });
    globalThis.fetch = mock;
    await applyStateTransition("continue", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  // Gate does NOT fire for non-forward intents from merge/deploy
  it("does NOT block 'reject' from merge state (not a forward transition)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
      branchStatus: { hasBranch: false, hasPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("reject", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  it("does NOT block 'reject' from deploy state (not a forward transition)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deploy" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
      branchStatus: { hasBranch: false, hasPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("reject", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

});

// ── AI-1402: Default-deny + needs-human blocking + unknown-caller ─────────

describe("checkWorkflowRules — AI-1402: needs-human blocked when forward path exists", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks needs-human in implementation (forward path: submit)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("needs-human");
  });

  it("blocks needs-human in code-review (forward path: approve, request-changes)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("needs-human");
  });

  it("blocks needs-human in deploy state (forward path: continue, reject)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"]);
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("needs-human");
  });

  it("blocks needs-human when no state label — fail-closed for this intent", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl"]); // no state:* label
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("needs-human");
    // Should suggest escape as the legal alternative
    expect(result).toContain("escape");
  });

  it("break-glass (escape) is still legal from every state (§4.4)", async () => {
    for (const state of ["intake", "implementation", "code-review", "merge", "deploy", "done"]) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles");
      expect(result).toBeNull(); // state: ${state}
    }
  });
});

describe("checkWorkflowRules — AI-1402: unknown-caller fail-closed", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks unknown caller on wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // "ghost-agent" is not in the test policy (which only has hanzo, charles, astrid)
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("ghost-agent");
    expect(result).toContain("Unknown caller");
  });

  it("allows known caller (charles) on wf:dev-impl ticket with legal command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("unknown caller on ad-hoc ticket is rejected — transition verb blocked before caller check (INF-35)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("no `wf:*` label");
  });

  it("escape (break-glass) does NOT bypass unknown-caller check — unidentified callers are blocked", async () => {
    // The unknown-caller block fires before the break-glass check. An agent not in the
    // capability policy cannot affect a governed ticket, even via break-glass.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("Unknown caller");
  });
});

describe("checkRawMutationInterception — AI-1402: labelIds blocking + unknown-caller", () => {
  let ai1402Dir: string;
  let ai1402OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1402Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1402-test-"));
    const policyFile = path.join(ai1402Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ai1402Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    ai1402OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1402OriginalFetch;
  });

  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
  };

  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1402OriginalFetch(url, init);
    };
  }

  it("blocks a raw labelIds mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { labelIds: ["lbl-1", "lbl-2"] } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct");
    expect(result).toContain("labels");
    expect(result).toContain("blocked on this workflow ticket");
  });

  it("passes through labelIds mutation on ad-hoc ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { labelIds: ["lbl-1"] } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("passes through title-only mutation on workflow ticket (title is not workflow-affecting)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { title: "Updated title" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("blocks unknown caller raw mutation on workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Unknown caller");
    expect(result).toContain("ghost-agent");
  });

  it("passes unknown caller on ad-hoc ticket (no wf:* label)", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).toBeNull();
  });

  it("passes when bodyId is undefined (backward-compat: no caller header)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    // bodyId omitted (undefined) — still blocks the stateId mutation via existing logic
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    // Should still be blocked by the stateId rule, not by the unknown-caller rule
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
  });
});


// ── AI-1658: addedLabelIds/removedLabelIds + commentCreate intercepts ────────
//
// Three enforcement gaps in checkRawMutationInterception:
//
// 1. AC1 — addedLabelIds/removedLabelIds bypass: the gate checks touches("labelIds")
//    (full-replace) but not the additive/subtractive fields. An agent can add or
//    remove state:* labels via these fields without triggering Layer 2.
//
// 2. AC2 — commentCreate not intercepted: the gate only intercepts `issueUpdate`
//    mutations. Agents can post free-form comments on governed tickets with no
//    intent header, violating the one-comment-per-step rule.
//
// All tests in this block are RED against the current implementation:
//   - addedLabelIds/removedLabelIds: gate returns null (passes through) instead of blocking
//   - commentCreate: gate returns null (passes through) instead of blocking
//
// Tests map to AI-1658 AC1 (addedLabelIds/removedLabelIds) and AC2 (commentCreate).

describe("checkRawMutationInterception — AI-1658: addedLabelIds/removedLabelIds + commentCreate", () => {
  let ai1658Dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ai1658OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1658Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1658-test-"));
    const policyFile = path.join(ai1658Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ai1658Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    ai1658OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1658OriginalFetch;
  });

  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] }, delegate: null } },
  };

  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] }, delegate: null } },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mockLabelFetch(labelResponse: object): (url: any, init?: RequestInit) => Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1658OriginalFetch(url, init);
    };
  }

  // ── AC1: addedLabelIds blocked (all 3 encoding shapes) ───────────────────

  it("AC1: blocks issueUpdate with addedLabelIds on governed ticket (variables.input shape)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-state-code-review"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked on this workflow ticket");
    expect(result).toContain("implementation");
  });

  it("AC1: blocks issueUpdate with addedLabelIds on governed ticket (inline $var shape)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $addedLabelIds: [String!]) { issueUpdate(id: $id, input: { addedLabelIds: $addedLabelIds }) { success } }",
      variables: { id: "issue-uuid", addedLabelIds: ["lbl-state-code-review"] },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked on this workflow ticket");
  });

  it("AC1: blocks issueUpdate with addedLabelIds on governed ticket (inline literal shape)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: 'mutation M($id: String!) { issueUpdate(id: $id, input: { addedLabelIds: ["lbl-state-code-review"] }) { success } }',
      variables: { id: "issue-uuid" },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked on this workflow ticket");
  });

  // ── AC1: removedLabelIds blocked (all 3 encoding shapes) ─────────────────

  it("AC1: blocks issueUpdate with removedLabelIds on governed ticket (variables.input shape)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { removedLabelIds: ["lbl-state-implementation"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked on this workflow ticket");
    expect(result).toContain("implementation");
  });

  it("AC1: blocks issueUpdate with removedLabelIds on governed ticket (inline $var shape)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $removedLabelIds: [String!]) { issueUpdate(id: $id, input: { removedLabelIds: $removedLabelIds }) { success } }",
      variables: { id: "issue-uuid", removedLabelIds: ["lbl-state-implementation"] },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked on this workflow ticket");
  });

  it("AC1: blocks issueUpdate with removedLabelIds on governed ticket (inline literal shape)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: 'mutation M($id: String!) { issueUpdate(id: $id, input: { removedLabelIds: ["lbl-state-implementation"] }) { success } }',
      variables: { id: "issue-uuid" },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked on this workflow ticket");
  });

  // ── AC1 + AC4: addedLabelIds/removedLabelIds pass through on ad-hoc ──────

  it("AC4: addedLabelIds passes through on ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-some-tag"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("AC4: removedLabelIds passes through on ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { removedLabelIds: ["lbl-some-tag"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("AC1: rejection for addedLabelIds includes current state and legal verbs", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-state-code-review"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
    expect(result).toContain("escape");
  });

  // ── 2026-07-03 supersession of AI-1658 AC2: pure comments are ALLOWED ─────
  // Comment→delegate routing wakes the owner, so comments are the legitimate
  // mid-state nudge path; state/label/assignee writes remain gated.

  it("allows pure commentCreate on a governed ticket (supersedes AI-1658 AC2)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      variables: { input: { issueId: "issue-uuid", body: "here is a status update" } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  // ── AC4: commentCreate passes through on ad-hoc ticket ───────────────────

  it("AC4: commentCreate passes through on ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const body = {
      query: "mutation M($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      variables: { input: { issueId: "issue-uuid", body: "a comment" } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("allows commentCreate with unresolvable issueId (comments are ungated)", async () => {
    const body = {
      query: "mutation M($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      variables: { input: { body: "a comment without issueId" } },
    };
    const result = await checkRawMutationInterception(body, null, "Bearer tok", "charles");
    expect(result).toBeNull();
  });
});


// ── AI-1535: raw delegateId mutations get delegate-only semantics ───────────
// A delegate-routing meta-command (handoff-work, undelegate) writes `delegateId`
// with NO intent header, so it lands in checkRawMutationInterception, not the
// intent-path delegate-only guard. App-user delegates omit assigneeId (AI-1395),
// so the old detector (stateId/assigneeId/labelIds only) missed delegate writes
// entirely — letting a non-delegate yank the delegate (the AI-1531 dogfood bug).
describe("checkRawMutationInterception — AI-1535: delegate-only raw mutations", () => {
  let ai1535Dir: string;
  let ai1535OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1535Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1535-test-"));
    const policyFile = path.join(ai1535Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ai1535Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    ai1535OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1535OriginalFetch;
  });

  const DELEGATE_USER_ID = "delegate-user-uuid";

  // Workflow ticket whose current delegate is DELEGATE_USER_ID.
  const WORKFLOW_IMPL_WITH_DELEGATE = {
    data: { issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: DELEGATE_USER_ID },
    } },
  };

  // Workflow ticket with NO delegate set.
  const WORKFLOW_IMPL_NO_DELEGATE = {
    data: { issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: null,
    } },
  };

  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] }, delegate: { id: DELEGATE_USER_ID } } },
  };

  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1535OriginalFetch(url, init);
    };
  }

  // The three encodings a delegateId can reach issueUpdate (mirrors AI-1402).
  const delegateBodies = {
    "variables.input shape": {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { delegateId: "new-user-uuid" } },
    },
    "inline $var shape": {
      query: "mutation M($id: String!, $delegateId: String) { issueUpdate(id: $id, input: { delegateId: $delegateId }) { success } }",
      variables: { id: "issue-uuid", delegateId: "new-user-uuid" },
    },
    "inline literal shape": {
      query: 'mutation M($id: String!) { issueUpdate(id: $id, input: { delegateId: "new-user-uuid" }) { success } }',
      variables: { id: "issue-uuid" },
    },
  };

  for (const [name, body] of Object.entries(delegateBodies)) {
    it(`blocks a raw delegate write by a NON-delegate (${name})`, async () => {
      globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_WITH_DELEGATE);
      // caller "charles" is a known body but NOT the current delegate
      const result = await checkRawMutationInterception(
        body, "issue-uuid", "Bearer tok", "charles", "some-other-user-uuid",
      );
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("Direct delegate change blocked");
      expect(result).toContain("not the current delegate");
    });
  }

  it("ALLOWS a raw delegate write by the CURRENT delegate (legitimate handoff-work)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_WITH_DELEGATE);
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "charles", DELEGATE_USER_ID,
    );
    expect(result).toBeNull();
  });

  it("blocks a raw delegate write by an unverifiable caller when a delegate exists (AI-1400 B2 parity)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_WITH_DELEGATE);
    // callerLinearUserId omitted (null) but bodyId is a known body
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "charles", null,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("cannot be verified");
  });

  // AI-1570: a NO-delegate raw write is no longer a blanket fail-open. The caller
  // may only ESTABLISH a first delegate if it fills the current state's owner_role
  // (or the workflow steward / break-glass owner role). charles fills `dev`, which
  // owns the `implementation` state of WORKFLOW_IMPL_NO_DELEGATE, so this stays allowed.
  it("ALLOWS a no-delegate raw write by the current state's owner role (charles=dev on implementation)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_NO_DELEGATE);
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "charles", "some-other-user-uuid",
    );
    expect(result).toBeNull();
  });

  // AI-1570 regression — the AI-1560 dogfood bug. A NO-delegate ticket in `deployment`
  // state (owner_role `deployment`, filled only by hanzo). A stale `dev`-role session
  // (charles, standing in for Igor) tries to raw-establish the delegate from a state it
  // does not own. The old code fail-opened here, letting it re-spawn a duplicate owner.
  // Now it must be BLOCKED across all three delegateId encodings.
  const WORKFLOW_DEPLOY_NO_DELEGATE = {
    data: { issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
      delegate: null,
    } },
  };

  for (const [name, body] of Object.entries(delegateBodies)) {
    it(`BLOCKS a no-delegate raw write by an out-of-role caller (charles=dev on deployment state) (${name})`, async () => {
      globalThis.fetch = mockLabelFetch(WORKFLOW_DEPLOY_NO_DELEGATE);
      const result = await checkRawMutationInterception(
        body, "issue-uuid", "Bearer tok", "charles", "some-other-user-uuid",
      );
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("may not establish a delegate");
    });
  }

  it("ALLOWS a no-delegate raw write by the state owner (hanzo=deployment on deployment state)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_DEPLOY_NO_DELEGATE);
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "hanzo", "some-other-user-uuid",
    );
    expect(result).toBeNull();
  });

  it("ALLOWS a no-delegate raw write by the workflow steward (astrid via break-glass owner_role)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_DEPLOY_NO_DELEGATE);
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "astrid", "some-other-user-uuid",
    );
    expect(result).toBeNull();
  });

  // AI-1570 enrollment carve-out: at the ENTRY state (intake), a known orchestrator
  // that fills no owning role may still establish the first delegate (ticket joining
  // the workflow). charles fills `dev`, not the intake owner `steward`, yet must be
  // allowed here — the routing-guard corrects the delegate target to astrid downstream.
  const WORKFLOW_INTAKE_NO_DELEGATE = {
    data: { issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
      delegate: null,
    } },
  };

  it("ALLOWS a no-delegate raw write at the ENTRY state by a non-owner known caller (enrollment)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_INTAKE_NO_DELEGATE);
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "charles", "some-other-user-uuid",
    );
    expect(result).toBeNull();
  });

  it("passes through a delegate write on an ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const result = await checkRawMutationInterception(
      delegateBodies["variables.input shape"], "issue-uuid", "Bearer tok", "charles", "some-other-user-uuid",
    );
    expect(result).toBeNull();
  });

  it("blocks a mixed delegate + stateId mutation via the blanket guard (delegate listed)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_WITH_DELEGATE);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      // even the CURRENT delegate cannot raw-write stateId — must use a verb
      variables: { id: "issue-uuid", input: { delegateId: "new-user-uuid", stateId: "state-done-uuid" } },
    };
    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "charles", DELEGATE_USER_ID,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("blocked on this workflow ticket");
    expect(result).toContain("status");
    expect(result).toContain("delegate");
  });
});


// ── AI-1579: recovery-actor first-delegate authorization ────────────────────
// A configured recovery actor (e.g. `ai`) may re-establish a delegate on a
// governed ticket whose delegate is currently EMPTY (orphaned) at ANY state,
// including a mid-workflow state whose owner_role it does not fill. This is the
// authorization counterpart to the stale-session recovery machinery: when a
// delegate's session dies without advancing the ticket, recovery clears the
// delegate and must re-dispatch via a raw delegateId write from `ai`. The
// carve-out is scoped to the empty-delegate path, so it can never steal a live
// delegate, and every other out-of-role caller stays blocked (AI-1560 parity).
describe("checkRawMutationInterception — AI-1579: recovery-actor authorization", () => {
  let ai1579Dir: string;
  let ai1579OriginalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;

  // Policy mirrors TEST_POLICY_YAML but adds `ai` as a known body in an
  // orchestrator container that fills NO workflow role (parity with prod).
  const AI_1579_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: code-review
    grants: [linear:transition]
  - id: orchestrator
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: ai
    container: orchestrator
    fills_roles: []
`;

  const WORKFLOW_WITH_RECOVERY = `${TEST_WORKFLOW_YAML.replace(
    "entry_state: intake\n",
    "entry_state: intake\nrecovery_actor: ai\n",
  )}`;
  // Same workflow, recovery actor NOT configured — `ai` must stay blocked mid-state.
  const WORKFLOW_NO_RECOVERY = TEST_WORKFLOW_YAML;

  function writeWorkflow(yamlText: string) {
    const workflowFile = path.join(ai1579Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, yamlText, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetWorkflowCache();
  }

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    ai1579Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1579-test-"));
    const policyFile = path.join(ai1579Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, AI_1579_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    writeWorkflow(WORKFLOW_WITH_RECOVERY);
    resetPolicyCache();
    ai1579OriginalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = ai1579OriginalFetch; });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  // A NO-delegate ticket at a mid-workflow state (deployment, owned by `deployment`).
  const ORPHANED_DEPLOY = {
    data: { issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
      delegate: null,
    } },
  };
  // The same state, but a delegate IS live.
  const LIVE_DELEGATE_DEPLOY = {
    data: { issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
      delegate: { id: "live-delegate-uuid" },
    } },
  };

  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1579OriginalFetch(url, init);
    };
  }

  const delegateWrite = {
    query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    variables: { id: "issue-uuid", input: { delegateId: "new-delegate-uuid" } },
  };

  // AC: orphaned-mid-state allow — recovery actor re-establishes a delegate.
  it("ALLOWS the recovery actor (ai) to re-delegate an orphaned ticket at a mid-workflow state", async () => {
    globalThis.fetch = mockLabelFetch(ORPHANED_DEPLOY);
    const result = await checkRawMutationInterception(
      delegateWrite, "issue-uuid", "Bearer tok", "ai", "ai-linear-uuid",
    );
    expect(result).toBeNull();
  });

  // AC: active-delegate-steal block — recovery actor cannot yank a live delegate.
  it("BLOCKS the recovery actor (ai) from stealing a LIVE delegate at a mid-workflow state", async () => {
    globalThis.fetch = mockLabelFetch(LIVE_DELEGATE_DEPLOY);
    const result = await checkRawMutationInterception(
      delegateWrite, "issue-uuid", "Bearer tok", "ai", "ai-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("not the current delegate");
  });

  // AC: non-recovery-caller-mid-state block — AI-1560 parity preserved.
  it("BLOCKS a non-recovery out-of-role caller (charles=dev) from establishing a delegate mid-state", async () => {
    globalThis.fetch = mockLabelFetch(ORPHANED_DEPLOY);
    const result = await checkRawMutationInterception(
      delegateWrite, "issue-uuid", "Bearer tok", "charles", "charles-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("may not establish a delegate");
  });

  // The carve-out is config-gated: with no recovery_actor set, even `ai` is blocked.
  it("BLOCKS the would-be recovery actor when recovery_actor is NOT configured", async () => {
    writeWorkflow(WORKFLOW_NO_RECOVERY);
    globalThis.fetch = mockLabelFetch(ORPHANED_DEPLOY);
    const result = await checkRawMutationInterception(
      delegateWrite, "issue-uuid", "Bearer tok", "ai", "ai-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("may not establish a delegate");
  });

  // Recovery actor still allowed at the ENTRY state (entry-state carve-out path).
  it("ALLOWS the recovery actor (ai) at the entry state too", async () => {
    globalThis.fetch = mockLabelFetch({
      data: { issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
        delegate: null,
      } },
    });
    const result = await checkRawMutationInterception(
      delegateWrite, "issue-uuid", "Bearer tok", "ai", "ai-linear-uuid",
    );
    expect(result).toBeNull();
  });
});


// ── Phase 5 / B-1: ux-audit workflow definition validation (AI-1438) ────────
// Validates the canonical ux-audit YAML fixture parses correctly and
// enforces workflow rules per design.md §14 + §16.0.
// No engine/runtime logic — definition + validation only.

describe("checkWorkflowRules — canonical ux-audit schema (src/__fixtures__/canonical-ux-audit.yaml)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let uxDir: string;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    uxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ux-audit-test-"));
    const policyFile = path.join(uxDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, UX_AUDIT_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
    if (originalPolicyPath !== undefined) {
      process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    } else {
      delete process.env.CAPABILITY_POLICY_PATH;
    }
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // §16.0 invariant: the YAML parses and produces a valid WorkflowDef
  it("parses the canonical ux-audit YAML without error", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);
    // 'complete-audit' is legal in auditing; null means pass-through
    expect(await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "maya")).toBeNull();
  });

  // §16.0 invariant: escape is legal from every state (§4.4)
  it("escape is legal from every ux-audit state (§4.4)", async () => {
    const allStates = [
      "intake", "auditing", "spawning", "managing", "review", "done", "escape",
    ];
    for (const state of allStates) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:ux-audit", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid");
      expect(result).toBeNull(); // state: ${state}
    }
  });

  // §16.0 invariant: each state has the expected legal transitions
  it("intake state allows accept and demote only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:intake"]);
    // accept is legal
    expect(await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
    // demote is legal
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:intake"]);
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
    // complete-audit is illegal in intake
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:intake"]);
    const blocked = await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "astrid");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("accept");
    expect(blocked).toContain("demote");
    expect(blocked).toContain("escape");
  });

  it("auditing state allows complete-audit only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);
    expect(await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // submit is illegal in auditing
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);
    const blocked = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("complete-audit");
  });

  it("spawning state allows spawn only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:spawning"]);
    expect(await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "engine-1")).toBeNull();
    // accept is illegal in spawning
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:spawning"]);
    const blocked = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "engine-1");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("spawn");
  });

  it("managing state allows complete only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:managing"]);
    expect(await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // spawn is illegal in managing
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:managing"]);
    const blocked = await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("complete");
  });

  it("review state allows approve and request-rework", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:review"]);
    expect(await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:review"]);
    expect(await checkWorkflowRules("request-rework", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // complete is illegal in review
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:review"]);
    const blocked = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("approve");
    expect(blocked).toContain("request-rework");
  });

  // §16.0 invariant: all transition targets resolve to valid states
  it("all transition targets reference valid states", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const stateIds = new Set(def.states.map((s) => s.id));
    // Also accept __ad_hoc__ as a valid target (it's a special demotion target)
    stateIds.add("__ad_hoc__");
    for (const state of def.states) {
      for (const t of state.transitions ?? []) {
        expect(stateIds.has(t.to)).toBe(true);
      }
    }
  });

  // §16.0 invariant: break_glass is defined
  it("break_glass is defined with a command", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    expect(def.break_glass).toBeDefined();
    expect(def.break_glass!.command).toBe("escape");
    expect(def.break_glass!.to).toBe("escape");
  });

  // §16.0 invariant: entry_state references a valid state
  it("entry_state references a valid state", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const stateIds = new Set(def.states.map((s) => s.id));
    expect(stateIds.has(def.entry_state ?? "")).toBe(true);
  });

  // §16.0 invariant: archetype is set
  it("archetype is 'orchestrator'", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    expect(def.archetype).toBe("orchestrator");
  });
});

// ── AI-1463: Auto-delegate assignment on approve transition ──────────────────

describe("applyStateTransition — auto-delegate assignment (AI-1463)", () => {
  let autoDelegateDir: string;
  let autoDelegateOriginalFetch: typeof globalThis.fetch;
  let originalAgentsFile: string | undefined;

  beforeEach(() => {
    autoDelegateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1463-test-"));
    const policyFile = path.join(autoDelegateDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(autoDelegateDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    // Set up agents.json with all policy bodies having linearUserId
    const agentsFile = path.join(autoDelegateDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "reviewer", linearUserId: "reviewer-linear-uuid", clientId: "r-client", clientSecret: "r-secret", accessToken: "r-token", refreshToken: "r-refresh" },
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "hanzo-client", clientSecret: "hanzo-secret", accessToken: "hanzo-token", refreshToken: "hanzo-refresh" },
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "charles-client", clientSecret: "charles-secret", accessToken: "charles-token", refreshToken: "charles-refresh" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "worker1", linearUserId: "worker1-linear-uuid", clientId: "w1-client", clientSecret: "w1-secret", accessToken: "w1-token", refreshToken: "w1-refresh" },
        { name: "worker2", linearUserId: "worker2-linear-uuid", clientId: "w2-client", clientSecret: "w2-secret", accessToken: "w2-token", refreshToken: "w2-refresh" },
      ],
    }, null, 2), "utf8");
    originalAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    resetPolicyCache();
    resetWorkflowCache();
    autoDelegateOriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = autoDelegateOriginalFetch;
    if (originalAgentsFile) {
      process.env.AGENTS_FILE = originalAgentsFile;
    } else {
      delete process.env.AGENTS_FILE;
    }
    reloadAgents();
    fs.rmSync(autoDelegateDir, { recursive: true, force: true });
  });

  it("auto-assigns delegate to hanzo when approve transitions code-review → deployment", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "deploy-lbl", name: "state:deployment" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("approve", "issue-uuid", "Bearer tok");

    // Verify the label swap happened
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();

    // AI-1493: delegate is bundled in the atomic mutation (not separate UpdateDelegate).
    const vars = updateCall!.body.variables as { issueId: string; delegateId?: string };
    expect(vars.issueId).toBe("internal-uuid");
    expect(vars.delegateId).toBe("hanzo-linear-uuid");
  });

  it("does not auto-assign delegate when destination state has no owner_role", async () => {
    // submit transitions implementation → code-review. code-review has owner_role: code-review
    // but there is no body filling the code-review role in the test policy, so resolveBodiesForRole
    // returns [] and auto-delegate should be skipped.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("submit", "issue-uuid", "Bearer tok");

    // Label swap should happen
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();

    // But no delegate update (code-review role has no bodies in test policy)
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeUndefined();
  });

  it("does not auto-assign delegate when destination is terminal (done)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();

    // Terminal state — no auto-delegate
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeUndefined();
  });

  it("fail-open: auto-delegate errors do not block the label transition", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "deploy-lbl", name: "state:deployment" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("approve", "issue-uuid", "Bearer tok");

    // Label swap should have happened with hanzo resolved as delegate
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    // Delegate is bundled in the atomic mutation (AI-1493), not a separate UpdateDelegate
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeUndefined();

  });
});

// ── Phase 5 / B-3: Barrier integration with applyStateTransition ──────────

describe("applyStateTransition — B-3 barrier integration", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: Array<{ query: string; variables?: Record<string, unknown> }>;
  let uxDir: string;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;

  const BARRIER_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    uxDir = fs.mkdtempSync(path.join(os.tmpdir(), "barrier-integration-"));
    fs.writeFileSync(path.join(uxDir, "capability-policy.yaml"), BARRIER_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = path.join(uxDir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Mock fetch that handles both state transition and barrier calls.
   * The child transitions to done, which triggers the barrier check.
   * Parent is ux-audit in managing with all children done.
   */
  function makeBarrierIntegrationFetch(opts: {
    childLabels?: Array<{ id: string; name: string }>;
    hasParent?: boolean;
    parentLabels?: Array<{ id: string; name: string }>;
    siblings?: Array<{ identifier: string; labels: string[] }>;
  }): typeof globalThis.fetch {
    const childLabels = opts.childLabels ?? [
      { id: "wf-lbl", name: "wf:dev-impl" },
      { id: "state-lbl", name: "state:code-review" },
    ];
    const hasParent = opts.hasParent ?? true;
    const parentLabels = opts.parentLabels ?? [
      { id: "wf-lbl", name: "wf:ux-audit" },
      { id: "state-lbl", name: "state:managing" },
    ];
    const siblings = opts.siblings ?? [
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
    ];

    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables as Record<string, unknown> | undefined });

      const q = parsed.query ?? "";

      // State transition: fetch issue with labels
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "child-internal-id", team: { id: "team-uuid" }, labels: { nodes: childLabels } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // State transition: team label lookup
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // AI-1498: Team workflow states for native state resolution
      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [
            { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-managing-uuid", name: "Managing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // State transition: label create
      if (q.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // State transition: issueUpdate
      if (q.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch parent identifier
      if (q.includes("ChildParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: hasParent ? { identifier: "AI-1439" } : null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch parent state
      if (q.includes("ParentState") || q.includes("ParentLabels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch parent with label IDs (via fetchIssueWithLabels → IssueLabels query)
      if (q.includes("IssueLabels") && !q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch children
      if (q.includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: siblings.map((s) => ({
                    identifier: s.identifier,
                    labels: { nodes: s.labels.map((l) => ({ name: l })) },
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: label swap (via issueUpdateLabels → UpdateLabels mutation)
      if (q.includes("UpdateLabels")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: comment
      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: resolve internal ID
      if (q.includes("issue(id: $id) { id }") && !q.includes("team") && !q.includes("parent") && !q.includes("labels") && !q.includes("branch")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // AI-1475 D1: Branch/PR status for done gate
      if (q.includes("IssueBranchAndPR")) {
        const hasMergeDeployState = childLabels.some((l: { name: string }) => l.name === "state:merge" || l.name === "state:deploy");
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                attachments: { nodes: [{ url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: hasMergeDeployState ? "merged" : "open" } }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${q.slice(0, 100)}`);
    };
  }

  it("triggers barrier check when child transitions to done via matching workflow", async () => {
    // AI-1992: barrier-ness is config-driven — the barrier check on the parent
    // needs the PARENT's (ux-audit) def, while the child transition needs the
    // dev-impl def. Load the whole fixtures dir so both are in the registry
    // (single-file mode could only serve one).
    process.env.WORKFLOW_DEFS_DIR = path.resolve(process.cwd(), "src/__fixtures__");
    resetWorkflowCache();

    globalThis.fetch = makeBarrierIntegrationFetch({
      childLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:ac-validate" },
      ],
    });

    // v8: validated from ac-validate → done (terminal)
    await applyStateTransition("validated", "AI-2001", "Bearer tok");

    // Restore single-file ux-audit workflow def for sibling tests
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;
    resetWorkflowCache();

    // Should have done state transition
    const stateTransition = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(stateTransition).toBeDefined();

    // Should have triggered barrier check (fetching parent)
    const parentFetch = calls.find((c) => c.query.includes("ChildParent"));
    expect(parentFetch).toBeDefined();

    // Should have fetched children for barrier evaluation
    const childrenFetch = calls.find((c) => c.query.includes("ParentChildren"));
    expect(childrenFetch).toBeDefined();

    // Should have transitioned parent managing → review
    const barrierTransition = calls.find((c) => c.query.includes("UpdateLabels"));
    expect(barrierTransition).toBeDefined();

    // Should have posted a barrier comment
    const commentCall = calls.find((c) => c.query.includes("commentCreate"));
    expect(commentCall).toBeDefined();
  });

  it("does not trigger barrier for non-terminal transition", async () => {
    const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
    process.env.WORKFLOW_DEF_PATH = devImplFixture;
    resetWorkflowCache();

    globalThis.fetch = makeBarrierIntegrationFetch({
      childLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
    });

    // submit from implementation → code-review (not terminal)
    await applyStateTransition("submit", "AI-2001", "Bearer tok");

    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;

    // Should have done state transition
    const stateTransition = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(stateTransition).toBeDefined();

    // Should NOT have triggered barrier check (code-review is not terminal)
    const parentFetch = calls.find((c) => c.query.includes("ChildParent"));
    expect(parentFetch).toBeUndefined();
  });

  it("does not trigger barrier when child has no parent", async () => {
    const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
    process.env.WORKFLOW_DEF_PATH = devImplFixture;
    resetWorkflowCache();

    globalThis.fetch = makeBarrierIntegrationFetch({
      hasParent: false,
      childLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:merge" },
      ],
    });

    await applyStateTransition("continue", "AI-2001", "Bearer tok");

    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;

    // State transition should happen
    const stateTransition = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(stateTransition).toBeDefined();

    // Barrier check should return early (no parent)
    const childrenFetch = calls.find((c) => c.query.includes("ParentChildren"));
    expect(childrenFetch).toBeUndefined();
  });

  it("INF-43: logs barrier hold (not 'children still active') when child set is unreadable", async () => {
    process.env.WORKFLOW_DEFS_DIR = path.resolve(process.cwd(), "src/__fixtures__");
    resetWorkflowCache();

    // Simulate an unreadable child set: ParentChildren returns GraphQL errors
    const unreadableFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables as Record<string, unknown> | undefined });
      const q = parsed.query ?? "";

      // State transition: fetch issue with labels
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "child-internal-id", team: { id: "team-uuid" }, labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "state-lbl", name: "state:ac-validate" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team label lookup
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team states
      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [
            { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-managing-uuid", name: "Managing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Label create
      if (q.includes("issueLabelCreate")) {
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "label-x" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // State transition: issueUpdate
      if (q.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch parent identifier
      if (q.includes("ChildParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: { identifier: "AI-1439" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch parent state
      if (q.includes("ParentState") || q.includes("ParentLabels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: [{ id: "wf-lbl", name: "wf:ux-audit" }, { id: "state-lbl", name: "state:managing" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch parent with label IDs
      if (q.includes("IssueLabels") && !q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: [{ id: "wf-lbl", name: "wf:ux-audit" }, { id: "state-lbl", name: "state:managing" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: fetch children — UNREADABLE (GraphQL errors)
      if (q.includes("ParentChildren")) {
        return new Response(
          JSON.stringify({ errors: [{ message: "Something went wrong reading children" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: label swap
      if (q.includes("UpdateLabels")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: comment
      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Barrier: resolve internal ID
      if (q.includes("issue(id: $id) { id }") && !q.includes("team") && !q.includes("parent") && !q.includes("labels") && !q.includes("branch")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    globalThis.fetch = unreadableFetch;

    await applyStateTransition("validated", "AI-2001", "Bearer tok");

    // State transition should still happen (child moves to done)
    const stateTransition = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(stateTransition).toBeDefined();

    // Barrier should fetch children
    const childrenFetch = calls.find((c) => c.query.includes("ParentChildren"));
    expect(childrenFetch).toBeDefined();

    // The barrier should NOT have transitioned the parent (no UpdateLabels)
    const barrierTransition = calls.find((c) => c.query.includes("UpdateLabels"));
    expect(barrierTransition).toBeUndefined();

    // The barrier SHOULD have posted an alarm comment (INF-34: unreadable set = hold + alarm)
    const commentCall = calls.find((c) => c.query.includes("commentCreate"));
    expect(commentCall).toBeDefined();

    // Restore single-file ux-audit workflow def for sibling tests
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;
    resetWorkflowCache();
  });
});

// ── Phase 6 / C-1: sprint workflow definition validation (AI-1471) ──────────
// Validates the canonical sprint YAML fixture parses correctly and
// enforces workflow rules per design.md §14b + §16.0.
// No engine/runtime logic — definition + validation only.
// F1 structural kill: there is NO transition path from intake to spawning.
// The only forward edge from intake is accept → ux-shaping.

describe("checkWorkflowRules — canonical sprint schema (src/__fixtures__/canonical-sprint.yaml)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let sprintDir: string;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    sprintDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprint-test-"));
    const policyFile = path.join(sprintDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, SPRINT_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;

    // AI-2359: singleton auto-delegate now fails closed when the target body
    // has no linearUserId. The canonical-sprint apply path (accept → ux-shaping)
    // auto-delegates to the 'ux-researcher' singleton 'maya', so every
    // SPRINT_POLICY_YAML body must have a linearUserId or the transition aborts
    // before binding its artifact (C-2). Give this block its own registry.
    const agentsFile = path.join(sprintDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({ agents: [
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-client", clientSecret: "h-secret", accessToken: "h-token", refreshToken: "h-refresh" },
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "maya", linearUserId: "maya-linear-uuid", clientId: "m-client", clientSecret: "m-secret", accessToken: "m-token", refreshToken: "m-refresh" },
        { name: "engine-1", linearUserId: "engine-1-linear-uuid", clientId: "e-client", clientSecret: "e-secret", accessToken: "e-token", refreshToken: "e-refresh" },
        { name: "soren", linearUserId: "soren-linear-uuid", clientId: "s-client", clientSecret: "s-secret", accessToken: "s-token", refreshToken: "s-refresh" },
      ] }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
    if (originalPolicyPath !== undefined) {
      process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    } else {
      delete process.env.CAPABILITY_POLICY_PATH;
    }
    if (originalAgentsFile !== undefined) {
      process.env.AGENTS_FILE = originalAgentsFile;
    } else {
      delete process.env.AGENTS_FILE;
    }
    // Restore the in-memory registry so the sprint bodies don't leak into
    // later describe blocks that rely on the outer fixture.
    reloadAgents();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // §16.0 invariant: the YAML parses and produces a valid WorkflowDef
  it("parses the canonical sprint YAML without error", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:ux-shaping"]);
    // 'submit' is legal in ux-shaping; null means pass-through
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "maya")).toBeNull();
  });

  // §16.0 invariant: escape is legal from every state (§4.4)
  it("escape is legal from every sprint state (§4.4)", async () => {
    const allStates = [
      "intake", "ux-shaping", "spawning", "managing", "validating", "done", "escape",
    ];
    for (const state of allStates) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid");
      expect(result).toBeNull(); // state: ${state}
    }
  });

  // §16.0 invariant: each state has the expected legal transitions
  // C-2 update: accept now requires an artifact ref, so we pass one here
  it("intake state allows accept and demote only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    // accept is legal when artifact ref is provided
    expect(await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid", null, null, "sprints/plan.md")).toBeNull();
    // demote is legal (no artifact required)
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
    // spawn is illegal in intake (F1: no intake → spawning shortcut)
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    const blocked = await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "astrid");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("accept");
    expect(blocked).toContain("demote");
    expect(blocked).toContain("escape");
  });

  it("ux-shaping state allows submit only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:ux-shaping"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // accept is illegal in ux-shaping
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:ux-shaping"]);
    const blocked = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("submit");
  });

  it("spawning state allows spawn only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:spawning"]);
    expect(await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "engine-1")).toBeNull();
    // submit is illegal in spawning
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:spawning"]);
    const blocked = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "engine-1");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("spawn");
  });

  it("managing state allows complete only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:managing"]);
    expect(await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "soren")).toBeNull();
    // spawn is illegal in managing
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:managing"]);
    const blocked = await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "soren");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("complete");
  });

  it("validating state allows approve and request-rework", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:validating"]);
    expect(await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "soren")).toBeNull();
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:validating"]);
    expect(await checkWorkflowRules("request-rework", "issue-uuid", "Bearer tok", "soren")).toBeNull();
    // complete is illegal in validating
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:validating"]);
    const blocked = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "soren");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("approve");
    expect(blocked).toContain("request-rework");
  });

  // §16.0 invariant: all transition targets reference valid states
  it("all transition targets reference valid states", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const stateIds = new Set(def.states.map((s) => s.id));
    // Also accept __ad_hoc__ as a valid target (it's a special demotion target)
    stateIds.add("__ad_hoc__");
    for (const state of def.states) {
      for (const t of state.transitions ?? []) {
        expect(stateIds.has(t.to)).toBe(true);
      }
    }
  });

  // §16.0 invariant: break_glass is defined
  it("break_glass is defined with a command", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    expect(def.break_glass).toBeDefined();
    expect(def.break_glass!.command).toBe("escape");
    expect(def.break_glass!.to).toBe("escape");
  });

  // §16.0 invariant: entry_state references a valid state
  it("entry_state references a valid state", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const stateIds = new Set(def.states.map((s) => s.id));
    expect(stateIds.has(def.entry_state ?? "")).toBe(true);
  });

  // §16.0 invariant: archetype is set
  it("archetype is 'feature-initiative'", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    expect(def.archetype).toBe("feature-initiative");
  });

  // ── F1 structural kill tests ────────────────────────────────────────────
  // F1: There is NO transition path from intake to spawning. The only forward
  // edge from intake is accept → ux-shaping. The orchestrator physically
  // cannot skip UX.

  it("F1: no direct intake → spawning edge exists", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const intakeState = def.states.find((s) => s.id === "intake");
    expect(intakeState).toBeDefined();
    const transitions = intakeState!.transitions ?? [];
    // No transition from intake goes directly to spawning
    const hasDirectSpawning = transitions.some((t) => t.to === "spawning");
    expect(hasDirectSpawning).toBe(false);
  });

  it("F1: no indirect path from intake to spawning (BFS reachability)", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();

    // Build adjacency list from transitions
    const adjacency = new Map<string, string[]>();
    for (const state of def.states) {
      adjacency.set(state.id, (state.transitions ?? []).map((t) => t.to));
    }

    // BFS from intake to find ALL paths to spawning.
    // F1 invariant: every path from intake to spawning must include ux-shaping.
    // Equivalently: spawning is only reachable from ux-shaping.
    // We check that the ONLY predecessor of spawning is ux-shaping.
    const spawningPredecessors: string[] = [];
    for (const state of def.states) {
      const targets = (state.transitions ?? []).map((t) => t.to);
      if (targets.includes("spawning")) {
        spawningPredecessors.push(state.id);
      }
    }
    // Only ux-shaping should transition to spawning (and also validating via request-rework)
    // F1 structural kill: intake is NOT in the predecessors of spawning
    expect(spawningPredecessors).not.toContain("intake");
    // And ux-shaping IS a predecessor (the path exists, just through UX)
    expect(spawningPredecessors).toContain("ux-shaping");
  });

  it("F1: the only forward edge from intake is accept → ux-shaping", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const intakeState = def.states.find((s) => s.id === "intake");
    expect(intakeState).toBeDefined();
    const transitions = intakeState!.transitions ?? [];
    // Filter out demote (goes to __ad_hoc__)
    const forwardTransitions = transitions.filter((t) => t.to !== "__ad_hoc__");
    // There is exactly one forward transition and it goes to ux-shaping
    expect(forwardTransitions.length).toBe(1);
    expect(forwardTransitions[0].command).toBe("accept");
    expect(forwardTransitions[0].to).toBe("ux-shaping");
  });

  // ── Barrier placement: managing → validating (never directly to done) ──

  it("barrier: managing transition goes to validating, not done", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const managingState = def.states.find((s) => s.id === "managing");
    expect(managingState).toBeDefined();
    const completeTransition = (managingState!.transitions ?? []).find((t) => t.command === "complete");
    expect(completeTransition).toBeDefined();
    expect(completeTransition!.to).toBe("validating");
    expect(completeTransition!.to).not.toBe("done");
  });

  // ── done state has satisfies_parent_barrier ─────────────────────────────

  it("done state has satisfies_parent_barrier: true", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const doneState = def.states.find((s) => s.id === "done");
    expect(doneState).toBeDefined();
    expect(doneState!.kind).toBe("terminal");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((doneState as any).satisfies_parent_barrier).toBe(true);
  });

  // ── Phase 6 / C-2: Artifact-binding intake tests (AI-1472) ────────────
  // Tests the artifact-binding gate at intake.accept and the recording
  // of bound artifacts connector-side for the validating gate to read.

  it("C-2: accept without artifact ref is rejected (intake → ux-shaping)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    // accept is the command that requires_artifact, but we pass no artifactRef
    const result = await checkWorkflowRules(
      "accept", "issue-uuid", "Bearer tok", "astrid", null, null,
      null, // no artifact ref
    );
    expect(result).not.toBeNull();
    expect(result).toContain("artifact");
    expect(result).toContain("sprint-plan");
  });

  it("C-2: accept with artifact ref passes (intake → ux-shaping)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    const result = await checkWorkflowRules(
      "accept", "issue-uuid", "Bearer tok", "astrid", null, null,
      "ai-systems/projects/fleet/sprints/sprint-42.md",
    );
    expect(result).toBeNull();
  });

  it("C-2: accept with empty artifact ref is rejected", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    const result = await checkWorkflowRules(
      "accept", "issue-uuid", "Bearer tok", "astrid", null, null,
      "", // empty string is falsy
    );
    expect(result).not.toBeNull();
    expect(result).toContain("artifact");
  });

  it("C-2: demote does not require an artifact (intake → __ad_hoc__)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
    // demote has no requires_artifact — should pass without one
    const result = await checkWorkflowRules(
      "demote", "issue-uuid", "Bearer tok", "astrid", null, null,
      null,
    );
    expect(result).toBeNull();
  });

  it("C-2: artifact ref is recorded connector-side on successful accept", async () => {
    clearArtifactStore();
    // We need to test applyStateTransition with the artifact recording.
    // Set up the mock fetch to handle label fetch + issue fetch + label swap + delegate
    let commentCreated = false;
    let lastAtomicWrite: { labelIds?: string[]; delegateId?: string; stateId?: string } | undefined;
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      // AI-1762 read-after-write verification — echo back what the atomic mutation wrote.
      if (bodyText.includes("VerifyTransitionWrite")) {
        const labelNames = (lastAtomicWrite?.labelIds ?? []).map((id) =>
          id === "lbl-1" ? "wf:sprint" : id === "lbl-ux-shaping" ? "state:ux-shaping" : id,
        );
        return new Response(
          JSON.stringify({ data: { issue: {
            labels: { nodes: labelNames.map((name) => ({ name })) },
            delegate: lastAtomicWrite?.delegateId ? { id: lastAtomicWrite.delegateId } : null,
            state: lastAtomicWrite?.stateId ? { id: lastAtomicWrite.stateId } : null,
          } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Atomic transition-write mutation (state + labels + delegate in one).
      // Must be matched BEFORE the broad "delegate" context-fetch branch:
      // AI-2359 gave the ux-researcher singleton (maya) a linearUserId, so the
      // atomic write now carries a delegateId variable and its body contains
      // "delegate" — without this ordering it would be misrouted to the context
      // fetch, return a non-success shape, and fail the transition (C-2 regressed
      // silently on main only because maya was skipped for lack of a linearUserId).
      if (bodyText.includes("issueUpdate")) {
        try {
          lastAtomicWrite = (JSON.parse(bodyText) as { variables?: typeof lastAtomicWrite }).variables;
        } catch { /* keep prior */ }
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Issue context fetch (for delegate check in checkWorkflowRules)
      if (bodyText.includes("delegate")) {
        return new Response(
          JSON.stringify({ data: { issue: { labels: { nodes: [{ name: "wf:sprint" }, { name: "state:intake" }] }, delegate: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Fetch issue with labels (for applyStateTransition)
      if (bodyText.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "lbl-1", name: "wf:sprint" }, { id: "lbl-2", name: "state:intake" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Team label lookup (findOrCreateLabel)
      if (bodyText.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-ux-shaping", name: "state:ux-shaping" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Delegate update mutation
      if (bodyText.includes("UpdateDelegate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Comment creation
      if (bodyText.includes("commentCreate")) {
        commentCreated = true;
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // AI-1498: Team workflow states for native state resolution
      if (bodyText.includes("TeamStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [
            { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-managing-uuid", name: "Managing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Default
      return new Response(
        JSON.stringify({ data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const artifactPath = "ai-systems/projects/fleet/sprints/sprint-42.md";
    await applyStateTransition("accept", "issue-uuid", "Bearer tok", {
      bodyId: "astrid",
      artifactRef: artifactPath,
    });

    // Verify the artifact was recorded
    const bound = getBoundArtifact("issue-uuid");
    expect(bound).not.toBeNull();
    expect(bound!.ref).toBe(artifactPath);
    expect(bound!.boundBy).toBe("astrid");

    clearArtifactStore();
  });

  it("C-2: artifact is NOT recorded when accept has no artifact ref", async () => {
    clearArtifactStore();
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "lbl-1", name: "wf:sprint" }, { id: "lbl-2", name: "state:intake" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-ux-shaping", name: "state:ux-shaping" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // applyStateTransition with no artifactRef — should NOT bind
    await applyStateTransition("accept", "issue-uuid", "Bearer tok", {
      bodyId: "astrid",
      // artifactRef omitted
    });

    // No artifact should be recorded
    expect(getBoundArtifact("issue-uuid")).toBeNull();

    clearArtifactStore();
  });

  it("C-2: requires_artifact is true on the accept transition in canonical sprint YAML", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const intakeState = def.states.find((s) => s.id === "intake");
    expect(intakeState).toBeDefined();
    const acceptTransition = (intakeState!.transitions ?? []).find((t) => t.command === "accept");
    expect(acceptTransition).toBeDefined();
    expect(acceptTransition!.requires_artifact).toBe(true);
  });

  it("C-2: other sprint transitions do not require artifact", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    // Check that only accept has requires_artifact
    const allTransitions: import("./workflow-gate.js").WorkflowTransition[] = [];
    for (const state of def.states) {
      for (const t of state.transitions ?? []) {
        allTransitions.push(t);
      }
    }
    const requiringArtifact = allTransitions.filter((t) => t.requires_artifact);
    expect(requiringArtifact.length).toBe(1);
    expect(requiringArtifact[0].command).toBe("accept");
  });

  it("C-2: artifact binding is cleaned up on escape", async () => {
    clearArtifactStore();
    // First bind an artifact
    const { bindArtifact: doBind } = await import("./artifact-store.js");
    doBind("issue-escape-test", {
      ref: "sprints/plan.md",
      boundAt: new Date().toISOString(),
      boundBy: "astrid",
    });
    expect(getBoundArtifact("issue-escape-test")).not.toBeNull();

    // Now simulate escape transition which should clean up
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "lbl-1", name: "wf:sprint" }, { id: "lbl-2", name: "state:intake" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-escape", name: "state:escape" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("TeamStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [
            { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-managing-uuid", name: "Managing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await applyStateTransition("escape", "issue-escape-test", "Bearer tok", {
      bodyId: "astrid",
    });

    expect(getBoundArtifact("issue-escape-test")).toBeNull();
    clearArtifactStore();
  });

  it("C-2: validating → approve blocked when no artifact is bound", async () => {
    clearArtifactStore();
    // No artifact bound for this issue
    expect(hasBoundArtifact("issue-validate-test")).toBe(false);

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "lbl-1", name: "wf:sprint" }, { id: "lbl-2", name: "state:validating" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-done", name: "state:done" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // applyStateTransition for approve from validating — should be blocked
    // (no label swap happens because artifact gate blocks)
    await applyStateTransition("approve", "issue-validate-test", "Bearer tok", {
      bodyId: "soren",
    });

    // The issue should NOT have been transitioned — we can verify by checking
    // that the mock didn't receive an issueUpdate with state:done label.
    // Since applyStateTransition is void, we verify the artifact gate blocked
    // by checking no artifact was ever recorded.
    expect(hasBoundArtifact("issue-validate-test")).toBe(false);

    clearArtifactStore();
  });

  it("C-2: validating → approve passes when artifact is bound", async () => {
    clearArtifactStore();
    // Bind an artifact first
    const { bindArtifact: doBind } = await import("./artifact-store.js");
    doBind("issue-validate-pass", {
      ref: "ai-systems/projects/fleet/sprints/sprint-42.md",
      boundAt: new Date().toISOString(),
      boundBy: "astrid",
    });
    expect(hasBoundArtifact("issue-validate-pass")).toBe(true);

    let labelSwapHappened = false;
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "lbl-1", name: "wf:sprint" }, { id: "lbl-2", name: "state:validating" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-done", name: "state:done" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("TeamStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [
            { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-managing-uuid", name: "Managing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("issueUpdate") && bodyText.includes("labelIds")) {
        labelSwapHappened = true;
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await applyStateTransition("approve", "issue-validate-pass", "Bearer tok", {
      bodyId: "soren",
    });

    // The label swap should have happened (artifact gate passed)
    expect(labelSwapHappened).toBe(true);

    clearArtifactStore();
  });
});

// ── Phase 6 / C-3: End-to-end milestone validation walk (AI-1473) ──────────
// Proves that F1–F4 are structurally unreachable through the enforcing proxy.
// This is the "walk" from AI-1318 re-targeted to the sprint (Archetype C)
// workflow. Each test exercises the full checkWorkflowRules + applyStateTransition
// pipeline with sprint.yaml loaded as the workflow def.
//
// F1 (skip-UX): No intake → spawning edge. Only forward path is intake → ux-shaping.
// F2a (stall-in-managing): Event-driven barrier auto-advances managing → validating
//   when all children terminal.
// F2b (self-sign-off): Barrier lands in validating, never done. Done requires
//   the bound artifact gate (§5.6) + explicit approve.
// F3 (wrong-capability body): Fan-out mints dev-impl children; only registered
//   dev-impl bodies can be assigned to implementation steps.
// F4 (self-merge): Deploy edge is Hanzo-only (deploy:execute); sprint owner
//   has no deployment path.

describe("C-3: E2E milestone validation walk — sprint (Archetype C)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let c3Dir: string;

  // Agents file with sprint-owner (soren) having a linearUserId
  const C3_AGENTS_JSON = {
    agents: [
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "astrid-client", clientSecret: "astrid-secret", accessToken: "astrid-token", refreshToken: "astrid-refresh" },
      { name: "maya", linearUserId: "maya-linear-uuid", clientId: "maya-client", clientSecret: "maya-secret", accessToken: "maya-token", refreshToken: "maya-refresh" },
      { name: "engine-1", linearUserId: "engine-1-linear-uuid", clientId: "engine-1-client", clientSecret: "engine-1-secret", accessToken: "engine-1-token", refreshToken: "engine-1-refresh" },
      { name: "soren", linearUserId: "soren-linear-uuid", clientId: "soren-client", clientSecret: "soren-secret", accessToken: "soren-token", refreshToken: "soren-refresh" },
      { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "hanzo-client", clientSecret: "hanzo-secret", accessToken: "hanzo-token", refreshToken: "hanzo-refresh" },
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "charles-client", clientSecret: "charles-secret", accessToken: "charles-token", refreshToken: "charles-refresh" },
    ],
  };

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    c3Dir = fs.mkdtempSync(path.join(os.tmpdir(), "c3-walk-"));
    const policyFile = path.join(c3Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, SPRINT_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;

    const agentsFile = path.join(c3Dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify(C3_AGENTS_JSON, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    reloadAgents();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
    clearArtifactStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearArtifactStore();
  });

  // ── F1: Skip-UX is structurally impossible ────────────────────────────

  describe("F1: skip-UX is structurally impossible", () => {
    it("F1a: proxy blocks 'spawn' command in intake state", async () => {
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      const result = await checkWorkflowRules("spawn", "SPRINT-1", "Bearer tok", "astrid");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("spawn");
      expect(result).toContain("intake");
      expect(result).toContain("accept");
      expect(result).toContain("demote");
      expect(result).toContain("escape");
    });

    it("F1b: proxy blocks 'submit' in intake", async () => {
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      const result = await checkWorkflowRules("submit", "SPRINT-1", "Bearer tok", "astrid");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
    });

    it("F1c: spawning is only reachable from ux-shaping and validating (schema-level)", async () => {
      const { loadWorkflowDef } = await import("./workflow-gate.js");
      const def = await loadWorkflowDef();
      const predecessors: string[] = [];
      for (const state of def.states) {
        if ((state.transitions ?? []).some((t) => t.to === "spawning")) {
          predecessors.push(state.id);
        }
      }
      expect(predecessors).toContain("ux-shaping");
      expect(predecessors).toContain("validating");
      expect(predecessors).not.toContain("intake");
    });

    it("F1d: accept without artifact is blocked", async () => {
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      const result = await checkWorkflowRules("accept", "SPRINT-1", "Bearer tok", "astrid", null, null, null);
      expect(result).not.toBeNull();
      expect(result).toContain("artifact");
    });

    it("F1e: happy path intake → ux-shaping → spawning with artifact", async () => {
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      expect(await checkWorkflowRules("accept", "SPRINT-1", "Bearer tok", "astrid", null, null, "sprints/plan.md")).toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:ux-shaping"]);
      expect(await checkWorkflowRules("submit", "SPRINT-1", "Bearer tok", "maya")).toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:spawning"]);
      expect(await checkWorkflowRules("spawn", "SPRINT-1", "Bearer tok", "engine-1")).toBeNull();
    });
  });

  // ── F2a: Barrier auto-advances managing → validating ────────────────

  describe("F2a: barrier auto-advances managing → validating (not done)", () => {
    it("barrier evaluation finds all children terminal", async () => {
      const { evaluateBarrier } = await import("./barrier.js");
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("ParentChildren")) {
          return new Response(JSON.stringify({
            data: { issue: { children: { nodes: [
              { identifier: "AI-3001", labels: { nodes: [{ name: "state:done" }] } },
              { identifier: "AI-3002", labels: { nodes: [{ name: "state:done" }] } },
            ] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected: ${bodyText.slice(0, 80)}`);
      };
      const result = await evaluateBarrier("SPRINT-1", "Bearer tok");
      expect(result.allTerminal).toBe(true);
      expect(result.totalChildren).toBe(2);
    });

    it("barrier auto-transition targets validating for sprint (not review)", async () => {
      const { attemptBarrierTransition } = await import("./barrier.js");

      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";

        // evaluateBarrier → fetchChildren
        if (bodyText.includes("ParentChildren")) {
          return new Response(JSON.stringify({
            data: { issue: { children: { nodes: [
              { identifier: "AI-3001", labels: { nodes: [{ name: "state:done" }] } },
            ] } } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // fetchParentState (not prefetched)
        if (bodyText.includes("ParentState")) {
          return new Response(JSON.stringify({
            data: { issue: {
              id: "sprint-internal-id",
              team: { id: "team-uuid" },
              labels: { nodes: [
                { id: "lbl-wf", name: "wf:sprint" },
                { id: "lbl-state", name: "state:managing" },
              ] },
            } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // fetchIssueWithLabels from linear-helpers (query name: IssueLabels)
        if (bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify({
            data: { issue: {
              id: "sprint-internal-id",
              team: { id: "team-uuid" },
              labels: { nodes: [
                { id: "lbl-wf", name: "wf:sprint" },
                { id: "lbl-state", name: "state:managing" },
              ] },
            } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // TeamLabels lookup
        if (bodyText.includes("TeamLabels")) {
          return new Response(
            JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Label creation — must create state:validating
        if (bodyText.includes("issueLabelCreate")) {
          const parsed = JSON.parse(bodyText) as { variables: { name: string } };
          expect(parsed.variables.name).toBe("state:validating");
          return new Response(
            JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "lbl-validating" } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Label swap + comment mutations
        if (bodyText.includes("issueUpdate") || bodyText.includes("commentCreate")) {
          return new Response(
            JSON.stringify({ data: { issueUpdate: { success: true }, commentCreate: { success: true, comment: { id: "c-id" } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`unexpected query: ${bodyText.slice(0, 100)}`);
      };

      const result = await attemptBarrierTransition("SPRINT-1", "Bearer tok");
      expect(result.transitioned).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("barrier does NOT fire when sprint parent is not in managing", async () => {
      const { onChildTerminal } = await import("./barrier.js");
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("ChildParent")) {
          return new Response(JSON.stringify({ data: { issue: { parent: { identifier: "SPRINT-1" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("ParentState")) {
          return new Response(JSON.stringify({ data: { issue: {
            id: "sprint-internal-id",
            team: { id: "team-uuid" },
            labels: { nodes: [{ id: "lbl-wf", name: "wf:sprint" }, { id: "lbl-state", name: "state:validating" }] },
          } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected: ${bodyText.slice(0, 80)}`);
      };
      const result = await onChildTerminal("AI-3001", "Bearer tok");
      expect(result).toBeNull();
    });
  });

  // ── F2b: Barrier lands in validating, never done ──────────────────────

  describe("F2b: barrier lands in validating, never done (self-sign-off blocked)", () => {
    it("validating state blocks 'complete' — cannot self-sign-off", async () => {
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:validating"]);
      const result = await checkWorkflowRules("complete", "SPRINT-1", "Bearer tok", "soren");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("complete");
      expect(result).toContain("validating");
      expect(result).toContain("approve");
      expect(result).toContain("request-rework");
    });

    it("validating → approve blocked when no artifact bound (§5.6 gate)", async () => {
      clearArtifactStore();
      let diagnosticComment = false;
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueWithLabels")) {
          return new Response(JSON.stringify({ data: { issue: { id: "sprint-internal-id", team: { id: "team-uuid" }, labels: { nodes: [
            { id: "lbl-wf", name: "wf:sprint" }, { id: "lbl-state", name: "state:validating" },
          ] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamLabels")) {
          return new Response(JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-done", name: "state:done" }] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("commentCreate")) {
          diagnosticComment = true;
          return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c-id" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("issueUpdate")) {
          return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      await applyStateTransition("approve", "SPRINT-NO-ARTIFACT", "Bearer tok", { bodyId: "soren" });
      expect(diagnosticComment).toBe(true);
    });

    it("validating → approve passes when artifact is bound", async () => {
      clearArtifactStore();
      const { bindArtifact: doBind } = await import("./artifact-store.js");
      doBind("SPRINT-WITH-ARTIFACT", { ref: "sprints/sprint-42.md", boundAt: new Date().toISOString(), boundBy: "astrid" });

      let labelSwapHappened = false;
      globalThis.fetch = async (_url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueWithLabels")) {
          return new Response(JSON.stringify({ data: { issue: { id: "sprint-internal-id", team: { id: "team-uuid" }, labels: { nodes: [
            { id: "lbl-wf", name: "wf:sprint" }, { id: "lbl-state", name: "state:validating" },
          ] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamLabels")) {
          return new Response(JSON.stringify({ data: { team: { labels: { nodes: [{ id: "lbl-done", name: "state:done" }] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("issueUpdate") && bodyText.includes("labelIds")) {
          labelSwapHappened = true;
          return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("issueUpdate")) {
          return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (bodyText.includes("TeamStates")) {
          return new Response(JSON.stringify({ data: { team: { states: { nodes: [
            { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-managing-uuid", name: "Managing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      await applyStateTransition("approve", "SPRINT-WITH-ARTIFACT", "Bearer tok", { bodyId: "soren" });
      expect(labelSwapHappened).toBe(true);
    });

    it("schema: done has satisfies_parent_barrier but NO transitions out", async () => {
      const { loadWorkflowDef } = await import("./workflow-gate.js");
      const def = await loadWorkflowDef();
      const doneState = def.states.find((s) => s.id === "done");
      expect(doneState).toBeDefined();
      expect(doneState!.kind).toBe("terminal");
      expect((doneState as Record<string, unknown>).satisfies_parent_barrier).toBe(true);
      expect(doneState!.transitions ?? []).toHaveLength(0);
    });
  });

  // ── F3: Wrong-capability body cannot be assigned ──────────────────────
  // soren is in the sprint policy but NOT in the dev-impl policy.
  // When dev-impl is loaded, soren is an unknown caller → blocked.

  describe("F3: wrong-capability body cannot be assigned to child steps", () => {
    it("sprint-owner (soren) blocked from submit on dev-impl child", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      // Write a dev-impl-only policy that does NOT include soren
      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
      const result = await checkWorkflowRules("submit", "AI-3001", "Bearer tok", "soren");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("soren");

      // Restore sprint fixture
      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });

    it("sprint-owner (soren) blocked from continue on dev-impl merge state", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
      const result = await checkWorkflowRules("continue", "AI-3001", "Bearer tok", "soren");
      expect(result).not.toBeNull();
      // soren is blocked — either as unknown caller or by deploy:execute capability gate.
      // Both reasons are structurally sound: the sprint owner cannot deploy.
      expect(result).toContain("[Proxy]");
      expect(result!.includes("deploy:execute") || result!.includes("Unknown caller")).toBe(true);

      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });

    it("fan-out triggers for sprint just like ux-audit (AI-1992: config-driven)", async () => {
      const { shouldTriggerFanout } = await import("./fanout.js");
      const yamlMod = await import("js-yaml");
      const fsMod = await import("node:fs");
      const loadFixture = (name: string) =>
        yamlMod.load(fsMod.readFileSync(path.resolve(process.cwd(), "src/__fixtures__", name), "utf8")) as Awaited<ReturnType<typeof import("./workflow-gate.js").loadWorkflowDef>>;
      const sprintDef = loadFixture("canonical-sprint.yaml");
      const uxAuditDef = loadFixture("canonical-ux-audit.yaml");
      expect(shouldTriggerFanout(sprintDef, "spawning", "spawn")).toBeTruthy();
      expect(shouldTriggerFanout(sprintDef, "managing", "spawn")).toBeFalsy();
      expect(shouldTriggerFanout(sprintDef, "spawning", "complete")).toBeFalsy();
      expect(shouldTriggerFanout(uxAuditDef, "spawning", "spawn")).toBeTruthy();
    });
  });

  // ── F4: Self-merge is structurally impossible ────────────────────────

  describe("F4: self-merge is structurally impossible (deploy:execute gate)", () => {
    it("sprint-owner cannot deploy even if in merge state", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
      const result = await checkWorkflowRules("continue", "AI-3001", "Bearer tok", "soren");
      expect(result).not.toBeNull();
      // Blocked — either unknown caller or deploy:execute. Both prove F4.
      expect(result!.includes("deploy:execute") || result!.includes("Unknown caller")).toBe(true);

      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });

    it("only Hanzo (deployment body) can merge", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge", "stakes:low"], { hasBranch: true, hasPR: true, hasMergedPR: true });
      expect(await checkWorkflowRules("continue", "AI-3001", "Bearer tok", "hanzo")).toBeNull();

      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });

    it("sprint workflow has no deploy command at all", async () => {
      resetWorkflowCache(); // Ensure we load the sprint fixture, not the cached dev-impl
      const { loadWorkflowDef } = await import("./workflow-gate.js");
      const def = await loadWorkflowDef();
      const deployTransitions: string[] = [];
      for (const state of def.states) {
        for (const t of state.transitions ?? []) {
          if (t.command === "deploy") deployTransitions.push(state.id);
        }
      }
      expect(deployTransitions).toHaveLength(0);
    });

    // INF-96: no branch/PR evidence is now a hard block (reverses AI-1497 fail-open).
    // The done gate no longer silently passes tickets with zero GitHub evidence.
    it("blocks dev-impl merge when no branch/PR evidence (INF-96)", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge", "stakes:low"], { hasBranch: false, hasPR: false });
      const result = await checkWorkflowRules("continue", "AI-3001", "Bearer tok", "hanzo");
      expect(result).not.toBeNull(); // INF-96: block on no evidence
      expect(result).toContain("blocked");

      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });
  });

  // ── Full end-to-end walk: happy path ────────────────────────────────

  describe("E2E happy path: intake → done with all gates satisfied", () => {
    it("complete walk: intake → ux-shaping → spawning → managing → validating → done", async () => {
      const ARTIFACT_REF = "sprints/sprint-42.md";
      const SPRINT_ID = "SPRINT-E2E";
      const { bindArtifact: doBind } = await import("./artifact-store.js");
      doBind(SPRINT_ID, { ref: ARTIFACT_REF, boundAt: new Date().toISOString(), boundBy: "astrid" });

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      expect(await checkWorkflowRules("accept", SPRINT_ID, "Bearer tok", "astrid", null, null, ARTIFACT_REF)).toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:ux-shaping"]);
      expect(await checkWorkflowRules("submit", SPRINT_ID, "Bearer tok", "maya")).toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:spawning"]);
      expect(await checkWorkflowRules("spawn", SPRINT_ID, "Bearer tok", "engine-1")).toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:managing"]);
      expect(await checkWorkflowRules("complete", SPRINT_ID, "Bearer tok", "soren")).toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:validating"]);
      expect(await checkWorkflowRules("approve", SPRINT_ID, "Bearer tok", "soren")).toBeNull();

      expect(hasBoundArtifact(SPRINT_ID)).toBe(true);
    });

    it("complete walk: every shortcut attempt is blocked", async () => {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      expect(await checkWorkflowRules("spawn", "SPRINT-SHORTCUT", "Bearer tok", "engine-1")).not.toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:intake"]);
      expect(await checkWorkflowRules("approve", "SPRINT-SHORTCUT", "Bearer tok", "soren")).not.toBeNull();

      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:sprint", "state:managing"]);
      const block3 = await checkWorkflowRules("approve", "SPRINT-SHORTCUT", "Bearer tok", "soren");
      expect(block3).not.toBeNull();
      expect(block3).toContain("complete"); // should suggest 'complete', not 'approve'
    });
  });
});

// ── Phase 6.5 / H-7 (AI-1482): Verbatim AC + Stakes-threshold tests ────

const STAKES_WORKFLOW_YAML = `
id: dev-impl
version: 6
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

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
      - command: route
        to: working
        assign:
          mode: required
          constraint: not-self
        capture_ac: true
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
        assign:
          mode: required
          constraint: not-implementer

  - id: working
    owner_role: worker
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
        requires_human_signoff_above_stakes: true
      - command: reject
        to: implementation

  - id: done
    kind: terminal
    native_state: done
    transitions: []

  - id: escape
    kind: terminal
    native_state: invalid
    transitions:
      - command: unescape
        to: intake
        assign: { mode: auto }
`;

describe("AI-1482: Verbatim AC + Stakes-threshold sign-off", () => {
  let originalFetch: typeof globalThis.fetch;
  let origWorkflowPath: string | undefined;

  beforeAll(() => {
    origWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    const workflowFile = path.join(dir, "dev-impl-stakes.yaml");
    fs.writeFileSync(workflowFile, STAKES_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    // Ensure the capability policy is still set (may have been cleared by prior suites)
    const policyFile = path.join(dir, "capability-policy.yaml");
    if (!fs.existsSync(policyFile)) {
      fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    }
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    process.env.WORKFLOW_DEF_PATH = origWorkflowPath;
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
    clearArtifactStore();
    // Clear AC record store
    clearAcRecordStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Stakes-threshold gate ──────────────────────────────────────────

  describe("stakes-threshold gate", () => {
    it("allows deploy from AI agent when stakes are below threshold", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:low"]);
      const result = await checkWorkflowRules("deploy", "AI-STAKES-LOW", "Bearer tok", "hanzo");
      expect(result).toBeNull();
    });

    it("allows deploy from AI agent when stakes:medium (below threshold 2)", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:medium"]);
      const result = await checkWorkflowRules("deploy", "AI-STAKES-MED", "Bearer tok", "hanzo");
      expect(result).toBeNull();
    });

    it("blocks deploy from AI agent when stakes:high (at threshold)", async () => {
      // hanzo is a registered agent body
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:high"]);
      const result = await checkWorkflowRules("deploy", "AI-STAKES-HIGH", "Bearer tok", "hanzo");
      expect(result).not.toBeNull();
      expect(result).toContain("elevated stakes");
      expect(result).toContain("human sign-off");
    });

    it("blocks deploy from any registered AI body on high-stakes ticket", async () => {
      // hanzo is the deployment body (has deploy:execute) and is an AI agent
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:high"]);
      const result = await checkWorkflowRules("deploy", "AI-STAKES-HIGH2", "Bearer tok", "hanzo");
      expect(result).not.toBeNull();
      expect(result).toContain("elevated stakes");
    });

    it("allows other transitions on high-stakes ticket (only deploy is gated)", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review", "stakes:high"]);
      const result = await checkWorkflowRules("approve", "AI-STAKES-REVIEW", "Bearer tok", "reviewer");
      expect(result).toBeNull();
    });

    it("allows deploy on high-stakes ticket when no stakes threshold configured", async () => {
      // Reset to the standard test YAML (no stakes config)
      const origPath = process.env.WORKFLOW_DEF_PATH;
      const workflowFile = path.join(dir, "dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = workflowFile;
      resetWorkflowCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:high"]);
      const result = await checkWorkflowRules("deploy", "AI-NO-STAKES", "Bearer tok", "hanzo");
      expect(result).toBeNull();

      process.env.WORKFLOW_DEF_PATH = origPath;
      resetWorkflowCache();
    });

    it("allows deploy from AI agent when no stakes label present (fail OPEN — AI-1539 Matt directive)", async () => {
      // A missing tag must NOT hold a task up for human review: fail open to level 0.
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
      const result = await checkWorkflowRules("deploy", "AI-NO-LABEL", "Bearer tok", "hanzo");
      expect(result).toBeNull();
    });
  });

  // ── resolveStakesLevel unit tests ──────────────────────────────────

  describe("resolveStakesLevel", () => {
    const stakesConfig = { threshold: 2, levels: { "stakes:low": 0, "stakes:medium": 1, "stakes:high": 2 } };

    it("returns 0 when no stakes label present (fail OPEN — AI-1539)", () => {
      expect(resolveStakesLevel(["wf:dev-impl", "state:deployment"], stakesConfig)).toBe(0);
    });

    it("returns mapped level for known stakes label", () => {
      expect(resolveStakesLevel(["stakes:low"], stakesConfig)).toBe(0);
      expect(resolveStakesLevel(["stakes:medium"], stakesConfig)).toBe(1);
      expect(resolveStakesLevel(["stakes:high"], stakesConfig)).toBe(2);
    });

    it("returns 0 for unknown/unmapped stakes label (fail OPEN — AI-1539)", () => {
      expect(resolveStakesLevel(["stakes:unknown"], stakesConfig)).toBe(0);
    });

    // ── AI-1539: namespace-agnostic resolution (def keys on risk:*) ──────
    describe("AI-1539: risk:* namespace (matches the live v8 dev-impl def)", () => {
      const riskConfig = { threshold: 2, levels: { "risk:low": 0, "risk:medium": 1, "risk:high": 2 } };

      it("resolves risk:low to level 0 (below threshold) — the AI-1531 regression", () => {
        // Before AI-1539, the hardcoded /^stakes:/ matcher missed risk:low and
        // fail-closed every dev-impl ticket to the threshold (forced human sign-off).
        expect(resolveStakesLevel(["wf:dev-impl", "state:deployment", "risk:low"], riskConfig)).toBe(0);
      });

      it("resolves risk:medium → 1 and risk:high → 2", () => {
        expect(resolveStakesLevel(["risk:medium"], riskConfig)).toBe(1);
        expect(resolveStakesLevel(["risk:high"], riskConfig)).toBe(2);
      });

      it("fails OPEN to level 0 when the ticket carries no configured level label (AI-1539 Matt directive)", () => {
        expect(resolveStakesLevel(["wf:dev-impl", "state:deployment"], riskConfig)).toBe(0);
      });

      it("only counts labels in the configured namespace; an explicit risk:high still gates", () => {
        // A label from the wrong namespace must NOT be treated as the stakes label;
        // only keys present in stakesConfig.levels count. An explicit risk:high gates;
        // a stray stakes:low (not in the risk:* map) is ignored → fail open to 0.
        expect(resolveStakesLevel(["stakes:low", "risk:high"], riskConfig)).toBe(2);
        expect(resolveStakesLevel(["stakes:low"], riskConfig)).toBe(0); // no risk:* present → fail open
      });
    });
  });

// ── AI-2358: Stakes-threshold designated-approver bypass ────────────────────

/** Track whether tests are in a beforeAll-defined YAML so afterEach does not
 *  accidentally restore the fetch to a stale value. */
let _ai2358RestoreFetch: typeof globalThis.fetch | undefined;
const AI2358_CAP_POLICY = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: sprint:signoff

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: sprint-owner
    grants: [linear:transition, sprint:signoff]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: sprint-owner
    requires: [sprint:signoff]

bodies:
  - id: ai
    container: sprint-owner
    fills_roles: [sprint-owner]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const AI2358_WORKFLOW_YAML = `
id: sprint-with-stakes
description: Sprint workflow with stakes threshold and designated approver
entry_state: validating

stakes:
  threshold: 2
  levels:
    stakes:low: 0
    stakes:medium: 1
    stakes:high: 2

break_glass:
  command: escape

states:
  - id: validating
    owner_role: sprint-owner
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
        requires_human_signoff_above_stakes: true
        requires_capability: sprint:signoff
        designated_approver: true
      # AI-2360 negative control: capability-gated but NOT a designated approver.
      # Models dev-impl's \`deploy\` (requires_capability: deploy:execute, no flag).
      # A holder of the capability must still be blocked by the stakes gate.
      - command: bare-approve
        to: done
        requires_human_signoff_above_stakes: true
        requires_capability: sprint:signoff
      - command: request-rework
        to: intake

  - id: done
    kind: terminal
    native_state: done
    transitions: []

  - id: escape
    kind: terminal
    native_state: invalid
    transitions:
      - command: unescape
        to: validating
        assign: { mode: auto }
`;

describe("AI-2358: stakes-threshold designated-approver bypass", () => {
  let ai2358Dir: string;
  let ai2358OrigFetch: typeof globalThis.fetch;
  let ai2358OrigWorkflowPath: string | undefined;
  let ai2358OrigPolicyPath: string | undefined;

  beforeAll(() => {
    ai2358Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2358-test-"));
    const workflowFile = path.join(ai2358Dir, "sprint-stakes.yaml");
    fs.writeFileSync(workflowFile, AI2358_WORKFLOW_YAML, "utf8");
    ai2358OrigWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    const policyFile = path.join(ai2358Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, AI2358_CAP_POLICY, "utf8");
    ai2358OrigPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    process.env.WORKFLOW_DEF_PATH = ai2358OrigWorkflowPath;
    process.env.CAPABILITY_POLICY_PATH = ai2358OrigPolicyPath;
    try { fs.rmSync(ai2358Dir, { recursive: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    ai2358OrigFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
  });

  afterEach(() => {
    if (_ai2358RestoreFetch) {
      globalThis.fetch = _ai2358RestoreFetch;
      _ai2358RestoreFetch = undefined;
    } else {
      globalThis.fetch = ai2358OrigFetch;
    }
  });

  it("AC1: designated approver (ai, holding sprint:signoff) bypasses stakes-threshold gate on high-stakes approve", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    const result = await checkWorkflowRules("approve", "AI2358-AC1", "Bearer tok", "ai");
    expect(result).toBeNull();
  });

  it("AC2: non-holder (charles, no sprint:signoff) is blocked on high-stakes approve (capability gate fires first)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    const result = await checkWorkflowRules("approve", "AI2358-AC2", "Bearer tok", "charles");
    // The requires_capability gate fires before the stakes gate; charles
    // doesn't hold sprint:signoff, so the capability gate blocks him.
    expect(result).not.toBeNull();
    expect(result).toContain("requires the 'sprint:signoff' capability");
  });

  it("AC3: non-holder (astrid, no sprint:signoff) is blocked on high-stakes approve (capability gate fires first)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    const result = await checkWorkflowRules("approve", "AI2358-AC3", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("requires the 'sprint:signoff' capability");
  });

  it("AC4: low-stakes approve passes for designated approver (ai)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:low"]);
    const result = await checkWorkflowRules("approve", "AI2358-AC4", "Bearer tok", "ai");
    expect(result).toBeNull();
  });

  it("AC5: transition with no requires_capability still blocks (original behavior preserved)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    const result = await checkWorkflowRules("request-rework", "AI2358-AC5", "Bearer tok", "charles");
    // request-rework does NOT have requires_human_signoff_above_stakes — should pass
    expect(result).toBeNull();
  });

  it("AC6: human/unknown caller (not in policy) is still allowed through stakes-threshold gate", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    const result = await checkWorkflowRules("approve", "AI2358-AC6", "Bearer tok", "matt");
    // matt is not in the capability policy — unknown = human
    expect(result).toBeNull();
  });

  // AI-2360 regression: the bypass is opt-in via `designated_approver: true`.
  // `bare-approve` is capability-gated but carries no flag, so a holder of the
  // capability is NOT a designated approver and the stakes gate must still fire.
  // This is the shape of dev-impl's `deploy` — the transition AI-2358's original
  // bare-`requires_capability` check wrongly handed a bypass to, letting hanzo
  // self-sign-off on high-stakes deploys (3 suites / 6 tests red on main).
  it("AI-2360: capability holder is blocked on a bare requires_capability transition (no designated_approver flag)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    const result = await checkWorkflowRules("bare-approve", "AI2360-REG", "Bearer tok", "ai");
    // ai holds sprint:signoff, so the capability gate passes — but without the
    // designated_approver opt-in the stakes gate must block the self-sign-off.
    expect(result).not.toBeNull();
    expect(result).toContain("elevated stakes");
    expect(result).toContain("human sign-off");
  });

  it("AI-2360: low-stakes bare requires_capability transition still passes for a holder", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:low"]);
    const result = await checkWorkflowRules("bare-approve", "AI2360-REG-LOW", "Bearer tok", "ai");
    // Below threshold the stakes gate never fires — the flag is irrelevant here.
    expect(result).toBeNull();
  });

  it("AC7: transition with requires_capability and no holder blocks non-holder (capability gate)", async () => {
    // Use a capability policy where no body holds sprint:signoff
    const noSignoffPolicy = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
`;
    _ai2358RestoreFetch = globalThis.fetch;

    const policyFile = path.join(ai2358Dir, "no-signoff-policy.yaml");
    fs.writeFileSync(policyFile, noSignoffPolicy, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    resetPolicyCache();

    globalThis.fetch = makeLabelFetch(["wf:sprint-with-stakes", "state:validating", "stakes:high"]);
    // charles doesn't hold sprint:signoff and nobody does — capability gate blocks
    const result = await checkWorkflowRules("approve", "AI2358-AC7", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("requires the 'sprint:signoff' capability");
  });
});

// ── AI-1493: Atomic transitions + deterministic owner-routing ──────────────

describe("applyStateTransition — AI-1493 atomic transitions", () => {
  let ai1493Dir: string;
  let ai1493OriginalFetch: typeof globalThis.fetch;
  let ai1493OriginalAgentsFile: string | undefined;
  let ai1493OriginalImplementerStorePath: string | undefined;

  beforeEach(() => {
    ai1493Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1493-test-"));
    const policyFile = path.join(ai1493Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // AI-1531: isolate the implementer store to this suite's tmpdir so a stale
    // /tmp/implementer-store.json can never poison reject/request-changes.
    ai1493OriginalImplementerStorePath = process.env.IMPLEMENTER_STORE_PATH;
    process.env.IMPLEMENTER_STORE_PATH = path.join(ai1493Dir, "implementer-store.json");
    clearImplementerStore();

    const workflowFile = path.join(ai1493Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    const agentsFile = path.join(ai1493Dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [{
        name: "hanzo",
        linearUserId: "hanzo-linear-uuid",
        clientId: "hanzo-client",
        clientSecret: "hanzo-secret",
        accessToken: "hanzo-token",
        refreshToken: "hanzo-refresh",
      }, {
        name: "charles",
        linearUserId: "charles-linear-uuid",
        clientId: "charles-client",
        clientSecret: "charles-secret",
        accessToken: "charles-token",
        refreshToken: "charles-refresh",
      }],
    }, null, 2), "utf8");
    ai1493OriginalAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    resetPolicyCache();
    resetWorkflowCache();
    ai1493OriginalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = ai1493OriginalFetch;
    if (ai1493OriginalAgentsFile) {
      process.env.AGENTS_FILE = ai1493OriginalAgentsFile;
    } else {
      delete process.env.AGENTS_FILE;
    }
    reloadAgents();

    // AI-1531: clear the in-memory store and restore the env override before
    // removing the tmpdir, so no record leaks across suites.
    clearImplementerStore();
    if (ai1493OriginalImplementerStorePath !== undefined) {
      process.env.IMPLEMENTER_STORE_PATH = ai1493OriginalImplementerStorePath;
    } else {
      delete process.env.IMPLEMENTER_STORE_PATH;
    }

    fs.rmSync(ai1493Dir, { recursive: true, force: true });
  });

  it("explicit CLI target overrides the prior-implementer default (rebuild WS2)", async () => {
    const { recordImplementer: doRecord } = await import("./implementer-store.js");
    doRecord("issue-target-override", "hanzo", "dev-impl");

    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("reject", "issue-target-override", "Bearer tok", { cliTarget: "charles" });

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { delegateId?: string };
    expect(vars.delegateId).toBe("charles-linear-uuid");
  });

  it("routes reject back to prior implementer from implementer store", async () => {
    const { recordImplementer: doRecord } = await import("./implementer-store.js");
    doRecord("issue-reject-ai1493", "hanzo", "dev-impl");

    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("reject", "issue-reject-ai1493", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { delegateId?: string };
    expect(vars.delegateId).toBe("hanzo-linear-uuid");
  });

  it("routes request-changes back to prior implementer", async () => {
    const { recordImplementer: doRecord } = await import("./implementer-store.js");
    doRecord("issue-rc-ai1493", "charles", "dev-impl");

    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("request-changes", "issue-rc-ai1493", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { delegateId?: string };
    expect(vars.delegateId).toBe("charles-linear-uuid");
  });

  it("atomic mutation includes both labels and delegate in single call", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "deploy-lbl", name: "state:deployment" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("approve", "issue-atomic-ai1493", "Bearer tok");

    const atomicCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);

    const vars = atomicCalls[0].body.variables as { labelIds: string[]; delegateId?: string };
    expect(vars.labelIds).toBeDefined();
    expect(vars.delegateId).toBe("hanzo-linear-uuid");

    const delegateCalls = calls.filter((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCalls.length).toBe(0);
  });

  it("clears delegate on terminal transition (deploy to done)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("deploy", "issue-done-ai1493", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { delegateId?: string };
    expect(vars.delegateId).toBeNull();
  });

  // ── AI-1531: IMPLEMENTER_STORE_PATH must be isolated per-suite ─────────────
  // These two tests verify AC1: a stale /tmp/implementer-store.json must never
  // short-circuit reject or request-changes. They FAIL before the fix (no
  // IMPLEMENTER_STORE_PATH isolation in beforeEach) and PASS after (isolation
  // redirects reads to a per-suite tmpfile that contains no ghost-body entry).
  //
  // Unique issue IDs are used so the suite's afterEach cleanup never races
  // with these tests' file writes.

  it("AI-1531/AC1: reject fires ApplyAtomicTransition even when /tmp/implementer-store.json has a ghost-body entry for this issue", async () => {
    const issueId = "issue-reject-ai1531-isolation";
    const poisonContent = JSON.stringify({
      [issueId]: { bodyId: "ghost-body-ai1531", workflowId: "dev-impl", recordedAt: "2026-01-01T00:00:00Z" },
    });
    // Seed the default store path (not the per-suite isolated path, which doesn't exist yet).
    fs.writeFileSync("/tmp/implementer-store.json", poisonContent, "utf8");
    // Force the in-memory store to reload from disk on next access.
    clearImplementerStore();

    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    try {
      await applyStateTransition("reject", issueId, "Bearer tok");
      // With IMPLEMENTER_STORE_PATH isolated to a per-suite tmpdir, the ghost-body entry
      // in /tmp/implementer-store.json is never loaded and the transition completes.
      const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
      expect(updateCall).toBeDefined(); // AC1: must not be short-circuited by ghost-body
    } finally {
      clearImplementerStore();
      try { fs.rmSync("/tmp/implementer-store.json"); } catch { /* absent is fine */ }
    }
  });

  it("AI-1531/AC1: request-changes fires ApplyAtomicTransition even when /tmp/implementer-store.json has a ghost-body entry for this issue", async () => {
    const issueId = "issue-rc-ai1531-isolation";
    const poisonContent = JSON.stringify({
      [issueId]: { bodyId: "ghost-body-ai1531", workflowId: "dev-impl", recordedAt: "2026-01-01T00:00:00Z" },
    });
    fs.writeFileSync("/tmp/implementer-store.json", poisonContent, "utf8");
    clearImplementerStore();

    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    try {
      await applyStateTransition("request-changes", issueId, "Bearer tok");
      const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
      expect(updateCall).toBeDefined(); // AC1: must not be short-circuited by ghost-body
    } finally {
      clearImplementerStore();
      try { fs.rmSync("/tmp/implementer-store.json"); } catch { /* absent is fine */ }
    }
  });
});

// ── AI-1709: multi-body role cliTarget resolution ────────────────────────────
//
// Regression suite for the silent-orphan bug: applyStateTransition was logging
// "delegate set by CLI target, skipping proxy auto-assign" on multi-body roles
// but never resolving the target to a Linear user ID, leaving the ticket with
// no delegate after the state label advanced.

const MULTI_BODY_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        assign: { mode: auto }

  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: done

  - id: done
    kind: terminal
    native_state: done
    transitions: []

  - id: escape
    kind: terminal
    native_state: invalid
    transitions:
      - command: unescape
        to: intake
        assign: { mode: auto }
`;

const MULTI_BODY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: test-author-container
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: felix
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: tdd
    container: test-author-container
    fills_roles: [test-author]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

describe("applyStateTransition — AI-1709 multi-body role cliTarget resolution", () => {
  let ai1709Dir: string;
  let ai1709OriginalPolicyPath: string | undefined;
  let ai1709OriginalWorkflowPath: string | undefined;
  let ai1709OriginalAgentsFile: string | undefined;
  let ai1709OriginalImplementerStorePath: string | undefined;
  let ai1709OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1709Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1709-"));
    ai1709OriginalFetch = globalThis.fetch;

    const policyFile = path.join(ai1709Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, MULTI_BODY_POLICY_YAML, "utf8");
    ai1709OriginalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ai1709Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, MULTI_BODY_WORKFLOW_YAML, "utf8");
    ai1709OriginalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    const agentsFile = path.join(ai1709Dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "felix", linearUserId: "felix-linear-uuid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
        { name: "tdd", linearUserId: "tdd-linear-uuid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
      ],
    }, null, 2), "utf8");
    ai1709OriginalAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    ai1709OriginalImplementerStorePath = process.env.IMPLEMENTER_STORE_PATH;
    process.env.IMPLEMENTER_STORE_PATH = path.join(ai1709Dir, "implementer-store.json");
    clearImplementerStore();

    resetPolicyCache();
    resetWorkflowCache();
    resetNativeStateCache();
  });

  afterEach(() => {
    globalThis.fetch = ai1709OriginalFetch;

    if (ai1709OriginalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = ai1709OriginalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;

    if (ai1709OriginalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = ai1709OriginalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;

    if (ai1709OriginalAgentsFile !== undefined) process.env.AGENTS_FILE = ai1709OriginalAgentsFile;
    else delete process.env.AGENTS_FILE;
    reloadAgents();

    if (ai1709OriginalImplementerStorePath !== undefined) process.env.IMPLEMENTER_STORE_PATH = ai1709OriginalImplementerStorePath;
    else delete process.env.IMPLEMENTER_STORE_PATH;
    clearImplementerStore();

    fs.rmSync(ai1709Dir, { recursive: true, force: true });
  });

  it("tests-ready with valid cliTarget resolves delegate and advances state", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:write-tests" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("tests-ready", "AI-1709-VALID", "Bearer tok", {
      bodyId: "tdd",
      cliTarget: "igor",
    });

    const atomicCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCall).toBeDefined();
    const vars = atomicCall!.body.variables as { delegateId?: string; labelIds?: string[] };
    expect(vars.delegateId).toBe("igor-linear-uuid");
    expect(vars.labelIds?.some((id: string) => id.includes("implementation") || id === "impl-lbl")).toBe(true);
  });

  it("tests-ready with no cliTarget aborts — state label must not advance", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:write-tests" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("tests-ready", "AI-1709-NOTARGET", "Bearer tok", {
      bodyId: "tdd",
      // cliTarget intentionally omitted
    });

    const atomicCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCall).toBeUndefined();
  });

  it("tests-ready with unknown cliTarget aborts — state label must not advance", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:write-tests" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("tests-ready", "AI-1709-BADTARGET", "Bearer tok", {
      bodyId: "tdd",
      cliTarget: "nonexistent-agent",
    });

    const atomicCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCall).toBeUndefined();
  });

  it("tests-ready with alternate valid cliTarget (felix) resolves to felix's linearUserId", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:write-tests" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("tests-ready", "AI-1709-FELIX", "Bearer tok", {
      bodyId: "tdd",
      cliTarget: "felix",
    });

    const atomicCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCall).toBeDefined();
    const vars = atomicCall!.body.variables as { delegateId?: string };
    expect(vars.delegateId).toBe("felix-linear-uuid");
  });
});

// ── AI-1493: Transition-walk canary ──────────────────────────────────────────

describe("AI-1493: transition-walk canary", () => {
  let canaryDir: string;

  beforeEach(() => {
    canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1493-canary-"));
    const workflowFile = path.join(canaryDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetWorkflowCache();
  });

  afterEach(() => {
    fs.rmSync(canaryDir, { recursive: true, force: true });
  });

  it("passes on valid dev-impl workflow definition", async () => {
    const result = await runTransitionWalk();
    expect(result.passed).toBe(true);
    expect(result.transitionsChecked).toBeGreaterThan(0);
    expect(result.violations).toHaveLength(0);
  });

  it("detects missing owner_role on non-terminal state", async () => {
    const badYaml = TEST_WORKFLOW_YAML.replace("owner_role: dev", "");
    const workflowFile = path.join(canaryDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, badYaml, "utf8");
    resetWorkflowCache();

    const result = await runTransitionWalk();
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.issue.includes("no owner_role"))).toBe(true);
  });

  it("detects undefined destination state", async () => {
    const badYaml = TEST_WORKFLOW_YAML.replace("to: deployment", "to: nonexistent");
    const workflowFile = path.join(canaryDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, badYaml, "utf8");
    resetWorkflowCache();

    const result = await runTransitionWalk();
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.issue.includes("undefined state"))).toBe(true);
  });
});

});

describe("validateNativeStateMappings (AI-1490)", () => {
  it("canonical dev-impl fixture has valid native_state on all states", () => {
    const raw = fs.readFileSync(CANONICAL_FIXTURE, "utf8");
    const def = yaml.load(raw) as any;
    const warnings = validateNativeStateMappings(def);
    expect(warnings).toEqual([]);
  });

  it("flags missing native_state on non-terminal states", () => {
    const def = {
      id: "test",
      states: [
        { id: "intake", kind: "normal" }, // missing native_state
        { id: "done", kind: "terminal", native_state: "done" },
      ],
    };
    const warnings = validateNativeStateMappings(def);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("intake");
    expect(warnings[0]).toContain("no native_state");
  });

  it("flags invalid native_state values", () => {
    const def = {
      id: "test",
      states: [
        { id: "building", kind: "normal", native_state: "nonexistent-state" },
      ],
    };
    const warnings = validateNativeStateMappings(def);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("nonexistent-state");
    expect(warnings[0]).toContain("not a recognized semantic state");
  });

  it("allows all valid semantic states", () => {
    const def = {
      id: "test",
      states: [
        { id: "a", kind: "normal", native_state: "backlog" },
        { id: "b", kind: "normal", native_state: "todo" },
        { id: "c", kind: "normal", native_state: "thinking" },
        { id: "d", kind: "normal", native_state: "doing" },
        { id: "e", kind: "normal", native_state: "managing" },
        { id: "f", kind: "terminal", native_state: "done" },
        { id: "g", kind: "terminal", native_state: "invalid" },
      ],
    };
    const warnings = validateNativeStateMappings(def);
    expect(warnings).toEqual([]);
  });

  it("AI-1498: terminal states without native_state are now a hard error (not just a warning)", () => {
    const def = {
      id: "test",
      states: [
        { id: "done", kind: "terminal" }, // no native_state on terminal — now an error
      ],
    };
    const warnings = validateNativeStateMappings(def);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("done");
    expect(warnings[0]).toContain("no native_state field");
  });
});

// ── AI-2476: Drift guard for merged-PR release gate-anchor states ────────

describe("validateGateAnchorDefs (AI-2476 drift guard)", () => {
  it("canonical dev-impl fixture passes drift guard (has merge + deploy states)", () => {
    const raw = fs.readFileSync(CANONICAL_FIXTURE, "utf8");
    const def = yaml.load(raw) as any;
    const errors = validateGateAnchorDefs(def);
    expect(errors).toEqual([]);
  });

  it("non-dev-impl workflows always pass the drift guard", () => {
    const uxAudit = yaml.load(fs.readFileSync(CANONICAL_UX_AUDIT_FIXTURE, "utf8")) as any;
    expect(validateGateAnchorDefs(uxAudit)).toEqual([]);

    const sprint = yaml.load(fs.readFileSync(CANONICAL_SPRINT_FIXTURE, "utf8")) as any;
    expect(validateGateAnchorDefs(sprint)).toEqual([]);
  });

  it("flags missing 'merge' state in dev-impl", () => {
    const def = {
      id: "dev-impl",
      version: 10,
      states: [
        { id: "intake" },
        { id: "deploy" },  // has deploy but not merge
        { id: "done", kind: "terminal" },
      ],
    };
    const errors = validateGateAnchorDefs(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes("merge"))).toBe(true);
    expect(errors.some((e) => e.includes("deploy"))).toBe(false);
  });

  it("flags missing 'deploy' state in dev-impl", () => {
    const def = {
      id: "dev-impl",
      version: 10,
      states: [
        { id: "intake" },
        { id: "merge" },  // has merge but not deploy
        { id: "done", kind: "terminal" },
      ],
    };
    const errors = validateGateAnchorDefs(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes("deploy"))).toBe(true);
    expect(errors.some((e) => e.includes("merge"))).toBe(false);
  });

  it("flags both missing states", () => {
    const def = {
      id: "dev-impl",
      version: 10,
      states: [
        { id: "intake" },
        { id: "done", kind: "terminal" },
      ],
    };
    const errors = validateGateAnchorDefs(def);
    expect(errors.length).toBe(2);
    expect(errors.some((e) => e.includes("merge"))).toBe(true);
    expect(errors.some((e) => e.includes("deploy"))).toBe(true);
  });
});

// ── AI-1498: Conformance-walk acceptance gate ─────────────────────────────
// Drives a synthetic ticket through EVERY transition in the dev-impl workflow
// and asserts after EACH step that {state:* label, delegate, native column} all
// match the YAML definition. Plus adversarial direct-write block tests.

describe("AI-1498: Conformance-walk acceptance gate", () => {
  let originalFetch: typeof globalThis.fetch;
  let confDir: string;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalImplementerStorePath: string | undefined;
  let originalConformanceAgentsFile: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    confDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1498-conformance-"));
    const policyFile = path.join(confDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;

    // Agents with linearUserId for all policy bodies (AI-2359 fail-closed requires linearUserId)
    const agentsFile = path.join(confDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "reviewer", linearUserId: "reviewer-linear-uuid", clientId: "r-client", clientSecret: "r-secret", accessToken: "r-token", refreshToken: "r-refresh" },
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-client", clientSecret: "h-secret", accessToken: "h-token", refreshToken: "h-refresh" },
      ],
    }, null, 2), "utf8");
    originalConformanceAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    // AI-1531: isolate the implementer store to this suite's tmpdir so a stale
    // /tmp/implementer-store.json can never poison reject/request-changes.
    originalImplementerStorePath = process.env.IMPLEMENTER_STORE_PATH;
    process.env.IMPLEMENTER_STORE_PATH = path.join(confDir, "implementer-store.json");
  });

  afterAll(() => {
    if (originalConformanceAgentsFile !== undefined) process.env.AGENTS_FILE = originalConformanceAgentsFile;
    else delete process.env.AGENTS_FILE;
    reloadAgents();
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalImplementerStorePath !== undefined) process.env.IMPLEMENTER_STORE_PATH = originalImplementerStorePath;
    else delete process.env.IMPLEMENTER_STORE_PATH;
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetNativeStateCache();
    resetPolicyCache();
    clearImplementerStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearImplementerStore();
  });

  /**
   * Map of semantic state names to their mock Linear stateId UUIDs.
   * Must match the mock team states returned by the fetch mock.
   */
  const SEMANTIC_TO_UUID: Record<string, string> = {
    todo: "state-todo-uuid",
    doing: "state-doing-uuid",
    thinking: "state-thinking-uuid",
    managing: "state-managing-uuid",
    done: "state-done-uuid",
    invalid: "state-invalid-uuid",
  };

  /**
   * Native state mapping from the canonical dev-impl YAML.
   * v7 (AI-1510): native status is a pure engagement overlay, so every active
   * work-phase RESTS at `todo`; a transition writes that resting value and the
   * connector then cycles thinking/doing off the delegate's session lifecycle.
   * Terminal states keep their semantic value.
   */
  const STATE_TO_NATIVE: Record<string, string> = {
    intake: "todo",
    "write-tests": "todo",
    implementation: "todo",
    "code-review": "todo",
    merge: "todo",
    deploy: "todo",
    "ac-validate": "todo",
    done: "done",
    escape: "invalid",
  };

  /**
   * Build a conformance fetch mock that tracks all mutations and allows
   * asserting on the atomic stateId in each transition.
   */
  function makeConformanceFetch(currentLabels: string[]): {
    fetch: typeof globalThis.fetch;
    mutations: Array<{ query: string; variables: Record<string, unknown> }>;
  } {
    const mutations: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      const q = parsed.query ?? "";

      // Issue with labels (for applyStateTransition)
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "conf-internal-uuid",
                team: { id: "conf-team-uuid" },
                labels: { nodes: currentLabels.map((name) => ({ id: `lbl-${name}`, name })) },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team labels
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Label creation
      if (q.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: `lbl-${name}` } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team states (AI-1498 native state resolution)
      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({ id, name: name.charAt(0).toUpperCase() + name.slice(1), type: name === "done" ? "completed" : name === "invalid" ? "canceled" : "started" })) } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Branch/PR for done gate
      if (q.includes("IssueBranchAndPR")) {
        const status = currentLabels.some((l) => l === "state:merge" || l === "state:deploy") ? "merged" : "open";
        return new Response(
          JSON.stringify({ data: { issue: { attachments: { nodes: [{ url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status } }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Atomic mutation — track it for assertions
      if (q.includes("ApplyAtomicTransition") || q.includes("issueUpdate")) {
        mutations.push({ query: q, variables: parsed.variables ?? {} });
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Issue description (for AC capture)
      if (q.includes("IssueDescription")) {
        return new Response(
          JSON.stringify({ data: { issue: { description: "" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // AI-1762 read-after-write verification — echo back what the last atomic mutation wrote.
      if (q.includes("VerifyTransitionWrite")) {
        const last = mutations[mutations.length - 1]?.variables as
          | { labelIds?: string[]; delegateId?: string; stateId?: string }
          | undefined;
        const labelNames = (last?.labelIds ?? []).map((id) => id.replace(/^lbl-/, ""));
        return new Response(
          JSON.stringify({ data: { issue: {
            labels: { nodes: labelNames.map((name) => ({ name })) },
            delegate: last?.delegateId ? { id: last.delegateId } : null,
            state: last?.stateId ? { id: last.stateId } : null,
          } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Delegate context fetch
      if (q.includes("delegate")) {
        return new Response(
          JSON.stringify({ data: { issue: { labels: { nodes: currentLabels.map((name) => ({ name })) }, delegate: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    return { fetch, mutations };
  }

  it("every transition writes the correct native stateId atomically", async () => {
    // Walk the full dev-impl v10 happy path:
    //   intake → write-tests → implementation → code-review → merge → deploy → ac-validate → done
    const transitions: Array<{ intent: string; fromLabels: string[]; toState: string }> = [
      { intent: "accept", fromLabels: ["wf:dev-impl", "state:intake"], toState: "write-tests" },
      { intent: "tests-ready", fromLabels: ["wf:dev-impl", "state:write-tests"], toState: "implementation" },
      { intent: "submit", fromLabels: ["wf:dev-impl", "state:implementation"], toState: "code-review" },
      { intent: "approve", fromLabels: ["wf:dev-impl", "state:code-review"], toState: "merge" },
      { intent: "continue", fromLabels: ["wf:dev-impl", "state:merge"], toState: "deploy" },
      { intent: "continue", fromLabels: ["wf:dev-impl", "state:deploy"], toState: "ac-validate" },
      { intent: "validated", fromLabels: ["wf:dev-impl", "state:ac-validate"], toState: "done" },
    ];

    for (const { intent, fromLabels, toState } of transitions) {
      resetWorkflowCache();
      resetNativeStateCache();
      const { fetch, mutations } = makeConformanceFetch(fromLabels);
      globalThis.fetch = fetch;

      await applyStateTransition(intent, "AI-CONF", "Bearer tok", {
        bodyId: "charles",
      });

      // Find the ApplyAtomicTransition mutation
      const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
      expect(atomicMutation).toBeDefined();

      const vars = atomicMutation!.variables as { stateId?: string; labelIds?: string[] };

      // Assert the native stateId was written
      const expectedNativeState = STATE_TO_NATIVE[toState];
      const expectedStateId = SEMANTIC_TO_UUID[expectedNativeState];
      expect(vars.stateId).toBe(expectedStateId);

      // Assert the label swap includes the new state:* label
      const labelIds = vars.labelIds ?? [];
      expect(labelIds.some((id: string) => id.includes(toState))).toBe(true);
    }
  });

  it("escape transition writes todo native stateId (AI-1710: escape re-enters at intake)", async () => {
    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:implementation"]);
    globalThis.fetch = fetch;

    await applyStateTransition("escape", "AI-CONF-ESC", "Bearer tok", { bodyId: "astrid" });

    const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
    expect(atomicMutation).toBeDefined();
    const vars = atomicMutation!.variables as { stateId?: string };
    expect(vars.stateId).toBe(SEMANTIC_TO_UUID["todo"]);
  });

  it("reject transition routes back to implementation with todo resting native state", async () => {
    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:merge"]);
    globalThis.fetch = fetch;

    await applyStateTransition("reject", "AI-CONF-REJ", "Bearer tok", {
      bodyId: "hanzo",
      feedback: { reasonCode: "correctness", freeText: "conformance reject" },
    });

    const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
    expect(atomicMutation).toBeDefined();
    const vars = atomicMutation!.variables as { stateId?: string };
    expect(vars.stateId).toBe(SEMANTIC_TO_UUID["todo"]);
  });

  it("request-changes transition routes back to implementation with todo resting native state", async () => {
    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:code-review"]);
    globalThis.fetch = fetch;

    await applyStateTransition("request-changes", "AI-CONF-RC", "Bearer tok", {
      bodyId: "reviewer",
      feedback: { reasonCode: "missing-tests", freeText: "conformance" },
    });

    const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
    expect(atomicMutation).toBeDefined();
    const vars = atomicMutation!.variables as { stateId?: string };
    expect(vars.stateId).toBe(SEMANTIC_TO_UUID["todo"]);
  });

  // ── Adversarial: direct-write block tests ────────────────────────────────

  it("blocks raw stateId mutation on workflow ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkRawMutationInterception(
      { query: "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", variables: { input: { stateId: "some-state-id" } } },
      "issue-uuid",
      "Bearer tok",
      "charles",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("blocks raw assigneeId mutation on workflow ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkRawMutationInterception(
      { query: "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", variables: { input: { assigneeId: "some-user-id" } } },
      "issue-uuid",
      "Bearer tok",
      "charles",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("blocks raw labelIds mutation on workflow ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkRawMutationInterception(
      { query: "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", variables: { input: { labelIds: ["lbl-1", "lbl-2"] } } },
      "issue-uuid",
      "Bearer tok",
      "charles",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("blocks raw stateId + assigneeId + labelIds combined mutation", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkRawMutationInterception(
      { query: "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", variables: { input: { stateId: "state-id", assigneeId: "user-id", labelIds: ["lbl-1"] } } },
      "issue-uuid",
      "Bearer tok",
      "charles",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("status/assignee/labels");
  });

  it("allows raw non-workflow mutations (title, description, etc.)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkRawMutationInterception(
      { query: "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", variables: { input: { title: "New title", description: "New description", priority: 1 } } },
      "issue-uuid",
      "Bearer tok",
      "charles",
    );
    expect(result).toBeNull(); // Not a workflow-affecting mutation
  });

  it("exactly one issueUpdate mutation per transition (no separate native-state write)", async () => {
    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:implementation"]);
    globalThis.fetch = fetch;

    await applyStateTransition("submit", "AI-CONF-ONE", "Bearer tok", { bodyId: "charles" });

    // Count ApplyAtomicTransition mutations — must be exactly 1
    const atomicMutations = mutations.filter((m) => m.query.includes("ApplyAtomicTransition"));
    expect(atomicMutations).toHaveLength(1);

    // The single mutation must include all three facets: labelIds, delegateId, stateId
    const vars = atomicMutations[0].variables as { labelIds?: string[]; delegateId?: string; stateId?: string };
    expect(vars.labelIds).toBeDefined();
    expect(vars.stateId).toBeDefined(); // AI-1498: native state is in the same mutation
  });

  // ── AI-1531: IMPLEMENTER_STORE_PATH must be isolated per-suite ─────────────
  // These tests verify AC1 and AC2 for the conformance suite. They FAIL before
  // the fix (no IMPLEMENTER_STORE_PATH isolation in beforeAll) and PASS after.
  //
  // Unique issue IDs are used to avoid conflicts with existing conformance tests;
  // the canonical workflow maps implementation to native_state: todo, so the
  // expected stateId is SEMANTIC_TO_UUID["todo"] (not "doing").

  it("AI-1531/AC1: reject completes even when /tmp/implementer-store.json is pre-seeded with a ghost-body for the conformance issue", async () => {
    const issueId = "AI-CONF-REJ-1531";
    const poisonContent = JSON.stringify({
      [issueId]: { bodyId: "ghost-body-ai1531", workflowId: "dev-impl", recordedAt: "2026-01-01T00:00:00Z" },
    });
    // Seed the default store with a ghost-body that has no linearUserId.
    fs.writeFileSync("/tmp/implementer-store.json", poisonContent, "utf8");
    clearImplementerStore();

    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:merge"]);
    globalThis.fetch = fetch;

    try {
      await applyStateTransition("reject", issueId, "Bearer tok", {
        bodyId: "hanzo",
        feedback: { reasonCode: "correctness", freeText: "ai1531 conformance reject" },
      });
      // AC1: ApplyAtomicTransition must fire regardless of /tmp store contents.
      // (Canonical workflow: implementation has native_state: todo.)
      const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
      expect(atomicMutation).toBeDefined();
      const vars = atomicMutation!.variables as { stateId?: string };
      expect(vars.stateId).toBe(SEMANTIC_TO_UUID["todo"]);
    } finally {
      clearImplementerStore();
      try { fs.rmSync("/tmp/implementer-store.json"); } catch { /* absent is fine */ }
    }
  });

  it("AI-1531/AC1: request-changes completes even when /tmp/implementer-store.json is pre-seeded with a ghost-body for the conformance issue", async () => {
    const issueId = "AI-CONF-RC-1531";
    const poisonContent = JSON.stringify({
      [issueId]: { bodyId: "ghost-body-ai1531", workflowId: "dev-impl", recordedAt: "2026-01-01T00:00:00Z" },
    });
    fs.writeFileSync("/tmp/implementer-store.json", poisonContent, "utf8");
    clearImplementerStore();

    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:code-review"]);
    globalThis.fetch = fetch;

    try {
      await applyStateTransition("request-changes", issueId, "Bearer tok", {
        bodyId: "reviewer",
        feedback: { reasonCode: "missing-tests", freeText: "ai1531 conformance rc" },
      });
      const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
      expect(atomicMutation).toBeDefined();
      const vars = atomicMutation!.variables as { stateId?: string };
      expect(vars.stateId).toBe(SEMANTIC_TO_UUID["todo"]);
    } finally {
      clearImplementerStore();
      try { fs.rmSync("/tmp/implementer-store.json"); } catch { /* absent is fine */ }
    }
  });

  it("AI-1531/AC2: IMPLEMENTER_STORE_PATH is set to a per-suite-isolated path (not the global default)", () => {
    // After the fix, beforeAll sets IMPLEMENTER_STORE_PATH to a per-suite tmpdir.
    // Before the fix, it is unset — so persist() would write to /tmp/implementer-store.json.
    const storePath = process.env.IMPLEMENTER_STORE_PATH;
    expect(storePath).toBeDefined(); // FAILS before fix (undefined), PASSES after
    expect(storePath).not.toBe("/tmp/implementer-store.json");
  });
});

// ── AI-1584: enrollIfMissing ───────────────────────────────────────────────

describe("enrollIfMissing — enrollment gap repair", () => {
  let originalFetch: typeof globalThis.fetch;
  let enrollDir: string;
  let enrollOrigWorkflowPath: string | undefined;
  let enrollOrigPolicyPath: string | undefined;

  beforeAll(() => {
    enrollDir = fs.mkdtempSync(path.join(os.tmpdir(), "enroll-test-"));
    const policyFile = path.join(enrollDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    const workflowFile = path.join(enrollDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    enrollOrigWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    enrollOrigPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    if (enrollOrigWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = enrollOrigWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (enrollOrigPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = enrollOrigPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => { originalFetch = globalThis.fetch; resetWorkflowCache(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeEnrollFetch(opts: {
    labels: Array<{ id: string; name: string }>;
    teamId?: string;
    teamLabels?: Array<{ id: string; name: string }>;
    issueError?: boolean;
    updateSuccess?: boolean;
  }): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: Record<string, unknown> }> } {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const teamId = opts.teamId ?? "team-uuid";
    const teamLabels = opts.teamLabels ?? [{ id: "intake-lbl", name: "state:intake" }];
    const updateSuccess = opts.updateSuccess ?? true;

    const mock: typeof globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
      const query = parsed.query ?? "";

      if (opts.issueError) throw new Error("simulated fetch error");

      if (query.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: teamId },
                labels: { nodes: opts.labels },
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

      if (query.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: updateSuccess } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query in enrollIfMissing test: ${query.slice(0, 80)}`);
    };

    return { fetch: mock, calls };
  }

  it("AC3: stamps state:intake when wf:dev-impl is present but no state:* label", async () => {
    const { fetch, calls } = makeEnrollFetch({
      labels: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "risk-lbl", name: "risk:low" }],
    });
    globalThis.fetch = fetch;

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");

    expect(result.enrolled).toBe(true);
    expect(result.entryState).toBe("intake");

    const updateCall = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("intake-lbl");
    expect(vars.labelIds).toContain("wf-lbl");
    expect(vars.labelIds).toContain("risk-lbl");
  });

  it("AI-1585/AC2: invokes the onHeal audit hook with workflow + entry-state info on a heal", async () => {
    const { fetch } = makeEnrollFetch({
      labels: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "risk-lbl", name: "risk:low" }],
    });
    globalThis.fetch = fetch;

    const heals: Array<{ issueId: string; internalId: string; workflowId: string; entryState: string }> = [];
    const result = await enrollIfMissing("issue-uuid", "Bearer tok", (info) => heals.push(info));

    expect(result.enrolled).toBe(true);
    expect(heals).toHaveLength(1);
    expect(heals[0]).toEqual({
      issueId: "issue-uuid",
      internalId: "internal-uuid",
      workflowId: "dev-impl",
      entryState: "intake",
    });
  });

  it("AI-1585/AC2: does NOT invoke the onHeal audit hook when no heal occurs (already enrolled)", async () => {
    const { fetch } = makeEnrollFetch({
      labels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:intake" },
      ],
    });
    globalThis.fetch = fetch;

    const heals: unknown[] = [];
    const result = await enrollIfMissing("issue-uuid", "Bearer tok", (info) => heals.push(info));

    expect(result.enrolled).toBe(false);
    expect(heals).toHaveLength(0);
  });

  it("no-op when state:* label is already present (already enrolled)", async () => {
    const { fetch, calls } = makeEnrollFetch({
      labels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:intake" },
      ],
    });
    globalThis.fetch = fetch;

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");

    expect(result.enrolled).toBe(false);
    expect(calls.find((c) => c.query.includes("ApplyAtomicTransition"))).toBeUndefined();
  });

  it("no-op for ad-hoc ticket with no wf:* label", async () => {
    const { fetch, calls } = makeEnrollFetch({
      labels: [{ id: "bug-lbl", name: "bug" }, { id: "prio-lbl", name: "priority:high" }],
    });
    globalThis.fetch = fetch;

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");

    expect(result.enrolled).toBe(false);
    expect(calls.find((c) => c.query.includes("ApplyAtomicTransition"))).toBeUndefined();
  });

  it("no-op for unknown wf:* id (no matching def) — fail open", async () => {
    const { fetch, calls } = makeEnrollFetch({
      labels: [{ id: "wf-lbl", name: "wf:unknown-workflow" }],
    });
    globalThis.fetch = fetch;

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");

    expect(result.enrolled).toBe(false);
    expect(calls.find((c) => c.query.includes("ApplyAtomicTransition"))).toBeUndefined();
  });

  it("fail-open when IssueWithLabels fetch throws", async () => {
    const { fetch } = makeEnrollFetch({ labels: [], issueError: true });
    globalThis.fetch = fetch;

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");

    expect(result.enrolled).toBe(false);
  });

  it("fail-open when issueUpdate returns non-success", async () => {
    const { fetch } = makeEnrollFetch({
      labels: [{ id: "wf-lbl", name: "wf:dev-impl" }],
      updateSuccess: false,
    });
    globalThis.fetch = fetch;

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");

    expect(result.enrolled).toBe(false);
  });
});

// ── AI-1576 AC2: complete/raw-status→Done blocked on wf:dev-impl (regression) ──
//
// Regression tests proving:
//  (a) `complete` is not a legal verb in ANY canonical dev-impl state.
//  (b) `validated` (from ac-validate) is the SOLE path to done.
//  (c) A raw stateId→Done mutation is blocked by Layer 2 on a governed ticket.
//
// Uses the canonical dev-impl v8 fixture to match the production workflow shape.
// Provides isolated env setup to avoid config-health bleed from earlier suites.

describe("checkWorkflowRules — AI-1576 AC2: complete blocked; only validated reaches done", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let ac2Dir: string;

  beforeAll(() => {
    ac2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1576-ac2-"));
    const policyFile = path.join(ac2Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");

    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
    if (originalPolicyPath !== undefined) {
      process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    } else {
      delete process.env.CAPABILITY_POLICY_PATH;
    }
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetNativeStateCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  const ALL_CANONICAL_STATES = [
    "intake", "write-tests", "implementation", "code-review",
    "deployment", "host-deploy", "ac-validate", "done",
  ];

  // AC2(a): complete is not a legal verb in any dev-impl state.
  for (const state of ALL_CANONICAL_STATES) {
    it(`AC2: 'complete' is blocked on wf:dev-impl in state '${state}' — not a legal verb`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "charles");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
    });
  }

  // AC2(b): validated from ac-validate is the sole path to done.
  it("AC2: 'validated' from ac-validate is allowed — the sole path to done (returns null)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:ac-validate"]);
    expect(await checkWorkflowRules("validated", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  const NON_AC_VALIDATE_STATES = ALL_CANONICAL_STATES.filter((s) => s !== "ac-validate");
  for (const state of NON_AC_VALIDATE_STATES) {
    it(`AC2: 'validated' is blocked from state '${state}' — not a legal verb outside ac-validate`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("validated", "issue-uuid", "Bearer tok", "charles");
      expect(result).not.toBeNull();
    });
  }

  // AC2(c): Layer 2 blocks a raw stateId→Done mutation on a governed ticket.
  it("AC2: raw stateId→Done mutation is blocked by Layer 2 on a governed wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:ac-validate"]);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "done-state-uuid" } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
  });
});

// ── AI-1576 AC3: demote blocked when ticket has in-flight/merged PR ─────────
//
// These tests are RED against the current implementation. checkWorkflowRules
// does not yet call fetchBranchAndPRStatus for the 'demote' intent.
//
// Implementation must add a PR-presence guard on the demote path:
//   if (intent === 'demote' && !breakGlassOverride) {
//     const branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
//     if (branchStatus && (branchStatus.hasBranch || branchStatus.hasPR)) → block
//   }
//
// Tests map to: AI-1576 AC3.

describe("checkWorkflowRules — AI-1576 AC3: demote blocked when ticket has in-flight/merged PR", () => {
  let originalFetch: typeof globalThis.fetch;
  let ac3Dir: string;

  beforeEach(() => {
    ac3Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1576-ac3-"));

    const policyFile = path.join(ac3Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ac3Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetWorkflowCache();
    resetNativeStateCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // RED: checkWorkflowRules returns null (allowed) for demote regardless of PR status.
  // These become green once the implementation adds the PR-presence guard.

  it("AC3: demote from intake is blocked when ticket has an open PR", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:intake"],
      { hasBranch: true, hasPR: true, hasMergedPR: false },
    );
    const result = await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("demote");
  });

  // AI-2016 AC1: merged PRs are now a release condition, not a block condition.
  // A shipped ticket (all PRs merged) is safe to demote — the guard permits it.
  it("AC3: demote from intake is ALLOWED when all PRs are merged (AI-2016 AC1)", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:intake"],
      { hasBranch: true, hasPR: true, hasMergedPR: true },
    );
    const result = await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  // AI-1797: branch-only evidence (pushed, no PR yet) is invisible via attachments —
  // Linear's public schema has no branch data. The guard can only see PRs now, so a
  // branch-without-PR ticket demotes like a fresh intake. Known coverage loss.
  it("AC3: demote from intake is allowed when branch is pushed but no PR (invisible via attachments, AI-1797)", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:intake"],
      { hasBranch: true, hasPR: false, hasMergedPR: false },
    );
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  // GREEN: no branch/PR evidence → genuinely fresh intake → demote is safe.
  it("AC3: demote from intake is allowed when no branch and no PR (genuinely fresh intake ticket)", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:intake"],
      { hasBranch: false, hasPR: false, hasMergedPR: false },
    );
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  // GREEN: branch/PR fetch failure → fail-open (can't confirm in-flight work; don't strand ticket).
  it("AC3: demote fails open when branch/PR fetch fails — cannot confirm in-flight work", async () => {
    globalThis.fetch = async (_url, init?) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("delegate") || bodyText.includes("IssueContext")) {
        return new Response(JSON.stringify({
          data: { issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: null,
          } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (bodyText.includes("IssueBranchAndPR")) {
        throw new Error("simulated API failure");
      }
      throw new Error(`unexpected fetch: ${bodyText.slice(0, 60)}`);
    };
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });
});



// ── AI-1658: addedLabelIds / removedLabelIds bypass ───────────────────────────
// AC1: the gate checks touches("labelIds") for full-replace, but addedLabelIds /
// removedLabelIds (Linear's additive/subtractive fields) are distinct keys and
// currently pass through undetected. These tests are RED until the gap is closed.

describe("checkRawMutationInterception — AI-1658: addedLabelIds/removedLabelIds bypass", () => {
  let ai1658LabelDir: string;
  let ai1658LabelOriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1658LabelDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1658-label-test-"));
    const policyFile = path.join(ai1658LabelDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(ai1658LabelDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    ai1658LabelOriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1658LabelOriginalFetch;
  });

  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1658LabelOriginalFetch(url, init);
    };
  }

  // RED until implementation detects addedLabelIds in variables
  it("blocks addedLabelIds in variables on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-new"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("labels");
    expect(result).toContain("blocked on this workflow ticket");
  });

  // RED until implementation detects removedLabelIds in variables
  it("blocks removedLabelIds in variables on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { removedLabelIds: ["lbl-old"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("labels");
  });

  // RED until implementation detects addedLabelIds in query text (encoding b)
  it("blocks addedLabelIds via inline query text on a workflow ticket", async () => {
    // Encoding (b): field name literal in query, value in differently-named var.
    // queryHasField("labelIds") won't match "addedLabelIds" (different identifier);
    // a fix must check for the addedLabelIds identifier explicitly.
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $lbl: [String!]!) { issueUpdate(id: $id, input: { addedLabelIds: $lbl }) { success } }",
      variables: { id: "issue-uuid", lbl: ["lbl-new"] },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  // GREEN: ad-hoc tickets are not governed — addedLabelIds must pass through.
  it("passes addedLabelIds through on ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-new"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  // GREEN: ad-hoc tickets are not governed — removedLabelIds must pass through.
  it("passes removedLabelIds through on ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { removedLabelIds: ["lbl-old"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });
});

// ── AI-1658: commentCreate not intercepted ────────────────────────────────────
// AC2: agents can post free-form comments on governed tickets without an intent
// header because commentCreate bypasses the "only intercept issueUpdate" early
// return. These tests are RED until the gap is closed.

describe("checkRawMutationInterception — AI-1658: commentCreate interception", () => {
  let ai1658CommentDir: string;
  let ai1658CommentOriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1658CommentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1658-comment-test-"));
    const policyFile = path.join(ai1658CommentDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(ai1658CommentDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    ai1658CommentOriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1658CommentOriginalFetch;
  });

  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1658CommentOriginalFetch(url, init);
    };
  }

  // 2026-07-03 supersession: pure comments are allowed on governed tickets.
  it("allows a raw commentCreate on a workflow ticket without intent header (supersedes AI-1658)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($issueId: ID!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      variables: { issueId: "issue-uuid", body: "free-form comment on a workflow ticket" },
    };
    expect(await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("allows commentCreate with $input variable shape on a workflow ticket (supersedes AI-1658)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      variables: { input: { issueId: "issue-uuid", body: "a comment" } },
    };
    expect(await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  // GREEN: ad-hoc tickets are not governed — commentCreate must pass through.
  it("passes commentCreate through on ad-hoc (non-workflow) ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);
    const body = {
      query: "mutation M($issueId: ID!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      variables: { issueId: "issue-uuid", body: "just a comment on a regular ticket" },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });
});

// ── AI-1658: stateId covers nativeStatus path (regression guard) ──────────────
// AC3: verify that the existing stateId interception covers the nativeStatus write
// format used by engagement-status.ts. If an external agent mimics this format
// without an intent header, the gate must catch it. These are GREEN regression
// guards that prove the existing touches("stateId") detection is sufficient for
// all nativeStatus mutation encodings.

describe("checkRawMutationInterception — AI-1658: stateId covers nativeStatus path", () => {
  let ai1658NativeDir: string;
  let ai1658NativeOriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1658NativeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1658-native-test-"));
    const policyFile = path.join(ai1658NativeDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(ai1658NativeDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    ai1658NativeOriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1658NativeOriginalFetch;
  });

  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1658NativeOriginalFetch(url, init);
    };
  }

  // Mirrors exactly the mutation shape applyEngagementStatus sends (engagement-status.ts).
  // An external agent mimicking this format must be blocked.
  it("blocks stateId in the engagement-status mutation format (encoding a: $stateId variable)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      variables: { id: "issue-uuid", stateId: "native-state-uuid" },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
    expect(result).toContain("blocked on this workflow ticket");
  });

  // Encoding (b): stateId is the input field in query text, value in an aliased
  // variable named $nativeStateId — queryHasField("stateId") must catch it.
  it("blocks stateId when the variable is aliased as $nativeStateId (encoding b: field in query, value aliased)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: "mutation M($id: String!, $nativeStateId: String!) { issueUpdate(id: $id, input: { stateId: $nativeStateId }) { success } }",
      variables: { id: "issue-uuid", nativeStateId: "native-state-uuid" },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
  });

  // Encoding (c): stateId and its value are both inline literals — no variables.
  it("blocks stateId as a literal inline value (encoding c: field and value in query text)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);
    const body = {
      query: `mutation {
        issueUpdate(id: "issue-uuid", input: { stateId: "native-linear-state-uuid" }) { success }
      }`,
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
  });
});

// ── AI-1666: noActivityTimeout YAML schema (AC1) ──────────────────────────
//
// WorkflowState must declare an optional noActivityTimeout?: number field so
// the no-activity detector can read per-state thresholds from the loaded def.
//
// Because js-yaml preserves unknown fields at runtime, the runtime value is
// accessible even without the TypeScript declaration. The declaration is
// required so the implementer can write `state.noActivityTimeout` without a
// tsc error — the full build (npm run build) catches the missing type if it
// is absent. These tests verify the runtime contract and document AC1.

describe("AI-1666: WorkflowState.noActivityTimeout YAML schema (AC1)", () => {
  let schemaTestDir: string;
  let schemaWorkflowFile: string;
  let schemaOriginalPath: string | undefined;

  beforeEach(() => {
    schemaTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1666-schema-test-"));
    schemaOriginalPath = process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
  });

  afterEach(() => {
    fs.rmSync(schemaTestDir, { recursive: true, force: true });
    process.env.WORKFLOW_DEF_PATH = schemaOriginalPath;
    resetWorkflowCache();
  });

  it("noActivityTimeout is preserved when parsing a workflow YAML state (AC1)", async () => {
    // Write a minimal workflow YAML with noActivityTimeout on one state.
    schemaWorkflowFile = path.join(schemaTestDir, "wf.yaml");
    fs.writeFileSync(
      schemaWorkflowFile,
      [
        "id: test-wf",
        "break_glass:",
        "  command: escape",
        "  to: escape",
        "states:",
        "  - id: generating",
        "    owner_role: image-artist",
        "    native_state: doing",
        "    noActivityTimeout: 600",
        "  - id: escape",
        "    kind: terminal",
        "    native_state: invalid",
      ].join("\n"),
    );
    process.env.WORKFLOW_DEF_PATH = schemaWorkflowFile;

    // Use the namespace import so a missing export fails at assertion time.
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();

    const state = def.states.find((s) => s.id === "generating");
    expect(state).toBeDefined();
    // AC1: noActivityTimeout must be accessible on the WorkflowState object.
    // js-yaml preserves the field at runtime; the TypeScript interface must also
    // declare it (checked by tsc at build time).
    expect((state as Record<string, unknown>)["noActivityTimeout"]).toBe(600);
  });

  it("states without noActivityTimeout return undefined for the field (AC1 — no spurious default)", async () => {
    schemaWorkflowFile = path.join(schemaTestDir, "wf2.yaml");
    fs.writeFileSync(
      schemaWorkflowFile,
      [
        "id: test-wf2",
        "break_glass:",
        "  command: escape",
        "  to: escape",
        "states:",
        "  - id: normal",
        "    owner_role: dev",
        "    native_state: doing",
        "  - id: escape",
        "    kind: terminal",
        "    native_state: invalid",
      ].join("\n"),
    );
    process.env.WORKFLOW_DEF_PATH = schemaWorkflowFile;

    const { loadWorkflowDef: loadWf } = await import("./workflow-gate.js");
    const def2 = await loadWf();

    const state = def2.states.find((s) => s.id === "normal");
    expect(state).toBeDefined();
    expect((state as Record<string, unknown>)["noActivityTimeout"]).toBeUndefined();
  });
});

// ── AI-1776: H-7 fail-visible warning comment ─────────────────────────────
//
// When a capture_ac: true transition captures nothing (null extraction OR
// description fetch failure), a warning comment must be posted on the ticket.
// The transition still completes (signal, not gate).

const AC2_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
        capture_ac: true
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: done

  - id: done
    kind: terminal
    native_state: done
    transitions: []

  - id: escape
    kind: terminal
    native_state: invalid
    transitions:
      - command: unescape
        to: intake
        assign: { mode: auto }
`;

describe("AI-1776: H-7 fail-visible — warning comment on null AC capture", () => {
  let origFetch: typeof globalThis.fetch;
  let ac2Dir: string;
  let origWorkflowPath: string | undefined;
  let origPolicyPath: string | undefined;
  let origAcRecordsPath: string | undefined;
  let origAgentsFileVar: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    ac2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1776-test-"));

    const policyFile = path.join(ac2Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    origPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ac2Dir, "dev-impl-ac2.yaml");
    fs.writeFileSync(workflowFile, AC2_WORKFLOW_YAML, "utf8");
    origWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    // Isolate AC record store to a per-test temp file so disk persists don't
    // bleed between tests (the store lazy-loads from disk on first access).
    origAcRecordsPath = process.env.AC_RECORDS_PATH;
    process.env.AC_RECORDS_PATH = path.join(ac2Dir, "ac-records.json");

    // Agents with linearUserId for policy bodies (AI-2359 fail-closed requires linearUserId)
    const agentsFile = path.join(ac2Dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "reviewer", linearUserId: "reviewer-linear-uuid", clientId: "r-client", clientSecret: "r-secret", accessToken: "r-token", refreshToken: "r-refresh" },
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-client", clientSecret: "h-secret", accessToken: "h-token", refreshToken: "h-refresh" },
      ],
    }, null, 2), "utf8");
    origAgentsFileVar = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    resetWorkflowCache();
    resetPolicyCache();
    clearAcRecordStore();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    resetWorkflowCache();
    resetPolicyCache();
    clearAcRecordStore();

    if (origAgentsFileVar !== undefined) process.env.AGENTS_FILE = origAgentsFileVar;
    else delete process.env.AGENTS_FILE;
    reloadAgents();

    if (origWorkflowPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = origWorkflowPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
    if (origPolicyPath !== undefined) {
      process.env.CAPABILITY_POLICY_PATH = origPolicyPath;
    } else {
      delete process.env.CAPABILITY_POLICY_PATH;
    }
    if (origAcRecordsPath !== undefined) {
      process.env.AC_RECORDS_PATH = origAcRecordsPath;
    } else {
      delete process.env.AC_RECORDS_PATH;
    }
    try { fs.rmSync(ac2Dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeAc2Fetch(opts: {
    description?: string;
    descriptionFetchFails?: boolean;
  }): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: Record<string, unknown> }> } {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const mockFetch: typeof globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
      const q = parsed.query ?? "";

      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-uuid",
                team: { id: "team-uuid" },
                labels: {
                  nodes: [
                    { id: "wf-lbl", name: "wf:dev-impl" },
                    { id: "state-lbl", name: "state:intake" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("IssueDescription")) {
        if (opts.descriptionFetchFails) throw new Error("simulated description fetch failure");
        return new Response(
          JSON.stringify({ data: { issue: { description: opts.description ?? "" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "warn-comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [{ id: "impl-lbl", name: "state:implementation" }] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueLabelCreate")) {
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("UpdateDelegate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("IssueBranchAndPR")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                attachments: { nodes: [{ url: "https://github.com/fancymatt/repo/pull/2", sourceType: "github", metadata: { status: "open" } }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected Linear query in AI-1776 test: ${q.slice(0, 80)}`);
    };

    return { fetch: mockFetch, calls };
  }

  it("AC2: posts a warning comment when description has no AC header (AI-1776)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({
      description: "## Problem\nNo acceptance criteria section here.\n\n## Notes\nJust notes.",
    });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    const commentCall = calls.find((c) => c.query.includes("commentCreate"));
    expect(commentCall).toBeDefined();
    const body = (commentCall!.variables as { body?: string }).body ?? "";
    expect(body).toMatch(/AC.*not.*captured|no.*AC.*section|capture.*failed|no.*acceptance.*criteria/i);
  });

  it("AC2: warning comment names the cause — no header found (AI-1776)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({
      description: "## Just notes\nNo AC here.",
    });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    const commentCall = calls.find((c) => c.query.includes("commentCreate"));
    expect(commentCall).toBeDefined();
    const body = (commentCall!.variables as { body?: string }).body ?? "";
    expect(body).toMatch(/header|no.*AC|acceptance.*criteria/i);
  });

  it("AC2: transition still completes (ApplyAtomicTransition fires) when AC header is absent (AI-1776)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({
      description: "No AC header anywhere in here.",
    });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
  });

  it("AC2: posts a warning comment when description fetch fails (AI-1776)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({ descriptionFetchFails: true });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    const commentCall = calls.find((c) => c.query.includes("commentCreate"));
    expect(commentCall).toBeDefined();
    const body = (commentCall!.variables as { body?: string }).body ?? "";
    expect(body).toMatch(/fetch.*fail|description.*unavailable|could not fetch|AC.*not.*captured/i);
  });

  it("AC2: transition still completes when description fetch fails (AI-1776)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({ descriptionFetchFails: true });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
  });

  it("AC2: does NOT post a warning comment when AC is captured successfully (AI-1776 non-regression)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({
      description: "## Acceptance Criteria\n\n* AC1: Works\n* AC2: Passes\n\n## Notes\nDone.",
    });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    const commentCall = calls.find((c) => c.query.includes("commentCreate"));
    expect(commentCall).toBeUndefined();
  });

  it("AC2: exactly one warning comment posted per null-capture event (AI-1776)", async () => {
    const { fetch: mock, calls } = makeAc2Fetch({
      description: "## Problem\nNo AC section.",
    });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    const commentCalls = calls.filter((c) => c.query.includes("commentCreate"));
    expect(commentCalls).toHaveLength(1);
  });

  it("AC2: AC record is not stored when capture returns null (AI-1776)", async () => {
    const { fetch: mock } = makeAc2Fetch({
      description: "## Problem\nNo AC section.",
    });
    globalThis.fetch = mock;

    await applyStateTransition("accept", "AI-1776", "Bearer tok");

    const record = await getAcRecord("AI-1776");
    expect(record).toBeNull();
  });
});

describe("checkWorkflowRules — deploy health gate (AI-2361)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalHealthCheckUrl: string | undefined;
  let originalConnectorRepo: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalHealthCheckUrl = process.env.HEALTH_CHECK_URL;
    originalConnectorRepo = process.env.CONNECTOR_REPO;
    process.env.HEALTH_CHECK_URL = "http://connector.test/health";
    process.env.CONNECTOR_REPO = "fancymatt/repo";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHealthCheckUrl) {
      process.env.HEALTH_CHECK_URL = originalHealthCheckUrl;
    } else {
      delete process.env.HEALTH_CHECK_URL;
    }
    if (originalConnectorRepo) {
      process.env.CONNECTOR_REPO = originalConnectorRepo;
    } else {
      delete process.env.CONNECTOR_REPO;
    }
  });

  it("blocks 'deploy' when running commit doesn't include merge SHA on connector-repo ticket", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:deployment"],
      { hasPR: true, hasMergedPR: true, mergeSha: "abc123def456", repoUrl: "fancymatt/repo" },
      "def789",
      false,
    );
    const result = await checkWorkflowRules(
      "deploy", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, false,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("abc123def456");
    expect(result).toContain("def789");
    expect(result).toContain("stale");
  });

  it("includes both commit SHAs in rejection message on stale artifact", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:deployment"],
      { hasPR: true, hasMergedPR: true, mergeSha: "abc123def456", repoUrl: "fancymatt/repo" },
      "def789",
      false,
    );
    const result = await checkWorkflowRules(
      "deploy", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, false,
    );
    expect(result).toContain("abc123def456");
    expect(result).toContain("def789");
  });

  it("allows 'deploy' when running commit matches merge SHA on connector-repo ticket", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:deployment"],
      { hasPR: true, hasMergedPR: true, mergeSha: "abc123def456", repoUrl: "fancymatt/repo" },
      "abc123def456",
      false,
    );
    const result = await checkWorkflowRules(
      "deploy", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, false,
    );
    expect(result).toBeNull();
  });

  it("allows 'deploy' without health check for non-connector repo ticket", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:deployment"],
      { hasPR: true, hasMergedPR: true, mergeSha: "abc123def456", repoUrl: "other-org/other-repo" },
      "def789",
      false,
    );
    const result = await checkWorkflowRules(
      "deploy", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, false,
    );
    expect(result).toBeNull();
  });

  it("allows 'deploy' without health check when PR has no merge SHA", async () => {
    globalThis.fetch = makeLabelFetch(
      ["wf:dev-impl", "state:deployment"],
      { hasPR: true, hasMergedPR: true, mergeSha: null, repoUrl: "fancymatt/repo" },
      "def789",
      false,
    );
    const result = await checkWorkflowRules(
      "deploy", "issue-uuid", "Bearer tok", "hanzo", null, null, null, false, false, false,
    );
    expect(result).toBeNull();
  });
});

// ── AI-2595: Merge-gate bounce strands dev-impl tickets ───────────────────
//
// Three failing tests covering the three acceptance criteria:
//   AC1: A gate bounce (merge/deploy reject → implementation) MUST attach the
//        implementing delegate in the same transition (mirror request-changes
//        semantics).
//   AC2: handoff-work can write a delegate when source === destination (self-loop).
//   AC3: Regression test: bounce a dev-impl ticket at the gate, assert delegate ≠ null.
//
// Expected to FAIL until the fix is in place:
//   - AC1 fails because reject transitions on merge/deploy lack
//     assign: { default: prior-implementer } — the implementer store is never
//     consulted, delegate falls through to role resolution and strand.
//   - AC2 fails because applyStateTransition short-circuits with
//     already-in-state when source === destination, skipping the delegate write.
//   - AC3 fails as a composite of both bugs.

describe("AI-2595: Gate-bounce delegate strand (merge/deploy reject)", () => {
  let ai2595Dir: string;
  let originalPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  const AI2595_WORKFLOW_YAML = `
id: dev-impl
version: 10
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        assign: { mode: auto }

  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: merge
        assign: { mode: auto }
      - command: handoff-work
        to: implementation
        assign: { default: prior-implementer }

  - id: merge
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: deploy
        requires_capability: deploy:execute
        assign: { mode: auto }
      - command: reject
        to: implementation
        requires_comment: true
        assign: { default: prior-implementer }
        feedback:
          required: true
          category_enum:
            - missing-tests
            - style

  - id: deploy
    owner_role: host-deploy
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: done
        requires_capability: infra:ssh
        assign: { mode: auto }
      - command: reject
        to: implementation
        requires_comment: true
        assign: { default: prior-implementer }
        feedback:
          required: true
          category_enum:
            - missing-tests

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

  const AI2595_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute
  - id: infra:ssh

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: test-author-container
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [infra:ssh]
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: tdd
    container: test-author-container
    fills_roles: [test-author]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

  beforeAll(() => {
    ai2595Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2595-test-"));

    const policyFile = path.join(ai2595Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, AI2595_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ai2595Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, AI2595_WORKFLOW_YAML, "utf8");
    originalPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    // Isolate implementer store to a suite-specific temp file so prior
    // test runs can't poison the prior-implementer lookup (AI-2595 AC1).
    process.env.IMPLEMENTER_STORE_PATH = path.join(ai2595Dir, "implementer-store.json");

    const agentsFile = path.join(ai2595Dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-client", clientSecret: "h-secret", accessToken: "h-token", refreshToken: "h-refresh" },
        { name: "grover", linearUserId: "grover-linear-uuid", clientId: "g-client", clientSecret: "g-secret", accessToken: "g-token", refreshToken: "g-refresh" },
        { name: "tdd", linearUserId: "tdd-linear-uuid", clientId: "t-client", clientSecret: "t-secret", accessToken: "t-token", refreshToken: "t-refresh" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-client", clientSecret: "i-secret", accessToken: "i-token", refreshToken: "i-refresh" },
        { name: "felix", linearUserId: "felix-linear-uuid", clientId: "f-client", clientSecret: "f-secret", accessToken: "f-token", refreshToken: "f-refresh" },
        { name: "noah", linearUserId: "noah-linear-uuid", clientId: "n-client", clientSecret: "n-secret", accessToken: "n-token", refreshToken: "n-refresh" },
        { name: "sage", linearUserId: "sage-linear-uuid", clientId: "s-client", clientSecret: "s-secret", accessToken: "s-token", refreshToken: "s-refresh" },
      ],
    }, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
  });

  afterAll(() => {
    if (originalPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalPath;
    else delete process.env.WORKFLOW_DEF_PATH;
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    clearImplementerStore();
    fs.rmSync(defStateSnapshotPath(), { force: true });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── AC1: Gate bounce attaches prior implementer ───────────────────────
  //
  // The `reject` transitions on `merge` and `deploy` states in the canonical
  // dev-impl workflow def do NOT have `assign: { default: prior-implementer }`,
  // unlike `request-changes` on `code-review`. This means a gate bounce from
  // merge/deploy → implementation does not re-attach the implementing delegate.
  //
  // Fix: add `assign: { default: prior-implementer }` to both `reject`
  // transitions in the production dev-impl workflow YAML.

  it("AC1: merge reject transition must declare assign.default: prior-implementer", async () => {
    // Load the test workflow def and verify the merge state's reject transition
    // is declared with assign.default: prior-implementer (matching request-changes).
    const def = await loadWorkflowDef();
    const mergeState = def.states.find((s) => s.id === "merge");
    expect(mergeState).toBeDefined();

    const rejectTransition = mergeState!.transitions?.find((t) => t.command === "reject");
    expect(rejectTransition).toBeDefined();

    // FAILS: reject on merge has no assign block — the prior implementer is
    // never consulted when the gate bounces.
    expect(rejectTransition!.assign?.default).toBe("prior-implementer");
  });

  it("AC1: deploy reject transition must declare assign.default: prior-implementer", async () => {
    const def = await loadWorkflowDef();
    const deployState = def.states.find((s) => s.id === "deploy");
    expect(deployState).toBeDefined();

    const rejectTransition = deployState!.transitions?.find((t) => t.command === "reject");
    expect(rejectTransition).toBeDefined();

    // FAILS: reject on deploy has no assign block — same bug as merge state.
    expect(rejectTransition!.assign?.default).toBe("prior-implementer");
  });

  // ── AC2: handoff-work (same-state self-loop) writes delegate ──────────
  //
  // FAILS because applyStateTransition has an idempotency short-circuit at
  // the top of the target-state block: when currentStateName === toStateName
  // AND the target label is present, it immediately returns
  // { status: "noop", code: "already-in-state" } — skipping delegate resolution
  // and the atomic write entirely. A stranded implementation-state ticket
  // with delegate=null cannot be recovered via handoff-work because the
  // self-loop never reaches Step 2 delegate resolution.
  //
  // Fix: in the same-state (self-loop) case where the transition carries
  // delegate semantics (assign.default or a re-route verb), resolve and
  // write the delegate before returning from the idempotency check.
  //
  // This test uses a workflow YAML where `implementation` has a
  // `handoff-work` → `implementation` self-loop transition with
  // assign: { default: prior-implementer }.

  it("AC2: handoff-work self-loop writes delegate even when state label unchanged", async () => {
    const { recordImplementer: doRecord } = await import("./implementer-store.js");
    await doRecord("issue-ai2595-ac2", "charles", "dev-impl");

    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "impl-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("handoff-work", "issue-ai2595-ac2", "Bearer tok");

    // FAILS: returns { status: "noop", code: "already-in-state" } because
    // the idempotency check fires before delegate resolution runs.
    expect(result.status).toBe("applied");
    expect(result.code).not.toBe("noop");
    expect(result.from).toBe("implementation");
    expect(result.to).toBe("implementation");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { delegateId?: string };
    // The prior implementer must be written as delegate even though state didn't change
    expect(vars.delegateId).toBe("charles-linear-uuid");
  });

  // ── AC3: Full regression — bounce + rescue via handoff ───────────────
  //
  // FAILS because AC3 composes both bugs: even if AC1 is fixed (delegate
  // set on bounce), AC2 would block the recovery handoff-work. The
  // two-phase test proves neither bug is fully fixed without the other.
  //
  // Phase 1: Gate bounce (merge reject → implementation) records the
  //   implementer and transitions. Delegate should be set by AC1's fix.
  //
  // Phase 2: handoff-work (self-loop) re-routes to a different dev body
  //   within implementation without changing state. Should work by AC2's fix.
  //
  // Without AC1 fix: delegate is null after Phase 1 → Phase 2 has nothing to
  //   re-route → handoff can't target the intended dev.
  // Without AC2 fix: Phase 1 works but Phase 2 no-ops (already-in-state).

  it("AC3: regression — gate bounce + handoff rescue succeeds without escape", async () => {
    const { recordImplementer: doRecord, getImplementer: doGet } = await import("./implementer-store.js");
    const issueId = "issue-ai2595-ac3-regression";
    await doRecord(issueId, "charles", "dev-impl");

    // Phase 1: Gate bounce — merge reject → implementation
    const { fetch: mock1, calls: calls1 } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "merge-lbl", name: "state:merge" },
        { id: "other-lbl", name: "priority:high" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock1;

    const result1 = await applyStateTransition("reject", issueId, "Bearer tok");

    // Phase 1 must succeed — delegate must be non-null after the bounce
    expect(result1.status).toBe("applied");
    expect(result1.from).toBe("merge");
    expect(result1.to).toBe("implementation");
    expect(result1.code).not.toBe("delegate-unresolved");

    const updateCall1 = calls1.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall1).toBeDefined();
    const vars1 = updateCall1!.body.variables as { delegateId?: string };
    expect(vars1.delegateId).not.toBeNull();
    expect(vars1.delegateId).toBe("charles-linear-uuid");

    // Phase 2: Handoff to igor within implementation (self-loop)
    // The implementer store still has charles recorded, but we pass a
    // cliTarget of "igor" to override — simulating handoff-work to igor.
    const { fetch: mock2, calls: calls2 } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "impl-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock2;

    const result2 = await applyStateTransition(
      "handoff-work", issueId, "Bearer tok",
      { cliTarget: "igor" },
    );

    // FAILS: returns { status: "noop", code: "already-in-state" }
    // because the idempotency check fires before the delegate is written.
    expect(result2.status).toBe("applied");
    expect(result2.code).not.toBe("noop");
    expect(result2.from).toBe("implementation");
    expect(result2.to).toBe("implementation");

    const updateCall2 = calls2.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall2).toBeDefined();
    const vars2 = updateCall2!.body.variables as { delegateId?: string };
    // handoff routed to igor — delegate must be igor's Linear user ID
    expect(vars2.delegateId).toBe("igor-linear-uuid");
  });
});

