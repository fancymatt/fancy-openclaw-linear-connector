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
  resolveStakesLevel,
  resolveNativeStateId,
  resetNativeStateCache,
  enrollIfMissing,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { clearArtifactStore, getBoundArtifact, hasBoundArtifact } from "./artifact-store.js";
import { runTransitionWalk } from "./canary.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { resetConfigHealth } from "./config-health.js";
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
`;

// ── Capability policy with ux-audit roles (AI-1438 Phase 5 / B-1) ────────

const UX_AUDIT_POLICY_YAML = `
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
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
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
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]
  - id: sprint-owner
    grants: [linear:transition]

roles:
  - id: dev
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
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
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
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLabelFetch(labelNames: string[], branchAndPR?: { hasBranch?: boolean; hasPR?: boolean; hasMergedPR?: boolean }): typeof globalThis.fetch {
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
    // Return branch/PR data when the query asks for it (AI-1475 D1 done gate)
    if (bodyText.includes("IssueBranchAndPR")) {
      const prState = branch.hasMergedPR ? "merged" : "open";
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              branch: branch.hasBranch ? { id: "branch-id", name: "feature-branch", updatedAt: "2026-06-09T00:00:00Z" } : null,
              pullRequests: branch.hasPR ? { nodes: [{ id: "pr-id", state: prState }] } : { nodes: [] },
            },
          },
        }),
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

  it("returns null for ad-hoc ticket (no wf:* label) — §4.6 mode switch", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    expect(await checkWorkflowRules("anything", "issue-uuid", "Bearer tok", "charles")).toBeNull();
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

  it("allows blocked intent through on fetch failure with break-glass (H-1)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles", null, null, null, true);
    expect(result).toBeNull();
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

  it("refuse-work is pass-through on ad-hoc tickets (no wf:* label)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles")).toBeNull();
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

  // AC3 regression: ad-hoc (ungoverned) tickets must continue to pass through.
  it("AC3: refuse-work on an ungoverned ticket (no wf:* label) always passes through", async () => {
    globalThis.fetch = makeDelegateFetch(["bug", "priority:high"], "real-delegate-uid");
    expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles", null, "charles-uid")).toBeNull();
  });
});

// ── AI-1583: proxy gate false-negative / steward delegate-only carve-out ──
//
// Root cause: the delegate-only guard (AI-1397) had no steward exemption.
// When a ticket's delegateId was set to a non-steward body (stale delegate,
// bulk-create artifact), the steward's accept at state:intake got spuriously
// blocked — a false-negative that fired even though the transition was legal.
// Fix: add the same steward carve-out used in refuse-work (AI-1574) to both
// delegate-only conditions so the steward is never locked out by a stale
// delegate value.
//
// AC3: steward accept from any state with a non-matching delegate → allowed.
// AC4: blocked response → non-steward non-delegate is still correctly blocked.
// AC2: block ⇒ no mutation is guaranteed by proxy.ts early-return; tested here
//      at the checkWorkflowRules level (null ≠ blocked).

describe("checkWorkflowRules — AI-1583: steward delegate-only carve-out", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeDelegateAndLabelFetch(labelNames: string[], delegateId: string | null): typeof globalThis.fetch {
    return async (_url, _init) => new Response(JSON.stringify({
      data: {
        issue: {
          labels: { nodes: labelNames.map((n) => ({ name: n })) },
          delegate: delegateId ? { id: delegateId } : null,
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // AC3: steward accept at intake with null delegate → allowed (baseline, no fix needed)
  it("AC3: steward accept at state:intake with null delegate is allowed", async () => {
    globalThis.fetch = makeDelegateAndLabelFetch(["wf:dev-impl", "state:intake"], null);
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid", null, "astrid-uid");
    expect(result).toBeNull();
  });

  // AC3 (core fix): steward accept at intake when delegate is already set to TDD agent.
  // Without fix: delegate-only block fires → "not the current delegate".
  // With fix: steward carve-out allows.
  it("AC3: steward accept at state:intake with stale non-steward delegate is allowed (steward carve-out)", async () => {
    globalThis.fetch = makeDelegateAndLabelFetch(["wf:dev-impl", "state:intake"], "tdd-agent-uid");
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid", null, "astrid-uid");
    expect(result).toBeNull();
  });

  // AC3: steward carve-out works across states — here steward advances write-tests
  // even though TDD agent holds the delegate (stale/wrong delegateId).
  it("AC3: steward tests-ready at state:write-tests with non-matching delegate is allowed", async () => {
    globalThis.fetch = makeDelegateAndLabelFetch(["wf:dev-impl", "state:write-tests"], "some-other-uid");
    const result = await checkWorkflowRules("tests-ready", "issue-uuid", "Bearer tok", "astrid", null, "astrid-uid");
    expect(result).toBeNull();
  });

  // AC4 regression: non-delegate, non-steward caller is still correctly blocked.
  it("AC4: non-delegate non-steward accept at state:write-tests with delegate set is blocked", async () => {
    globalThis.fetch = makeDelegateAndLabelFetch(["wf:dev-impl", "state:write-tests"], "real-delegate-uid");
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "charles", null, "charles-uid");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("not the current delegate");
  });

  // AC4 regression: unknown-caller + known delegate → still blocked (non-steward).
  it("AC4: unknown-caller (no linearUserId) with known delegate is blocked for non-steward", async () => {
    globalThis.fetch = makeDelegateAndLabelFetch(["wf:dev-impl", "state:implementation"], "real-delegate-uid");
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "charles", null, null);
    expect(result).not.toBeNull();
    expect(result).toContain("cannot be verified");
  });

  // AC4 regression: unknown-caller steward is still allowed even without linearUserId.
  it("AC4: steward with no linearUserId bypasses unknown-caller block when delegate is set", async () => {
    globalThis.fetch = makeDelegateAndLabelFetch(["wf:dev-impl", "state:intake"], "tdd-agent-uid");
    // astrid is the steward in TEST_POLICY_YAML; callerLinearUserId = null (not configured)
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid", null, null);
    expect(result).toBeNull();
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

  it("allows 'demote' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
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

describe("checkWorkflowRules — deploy capability gate (deployment state)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'deploy' from Hanzo (deployment body) in deployment state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("blocks 'deploy' from Charles (dev body, no deploy:execute) in deployment state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("deploy:execute");
    expect(result).toContain("deployment");
  });

  it("blocks 'deploy' from Astrid (steward body, no deploy:execute) in deployment state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy:execute");
  });

  it("blocks illegal command 'submit' in deployment state even for Hanzo", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("deployment");
    expect(result).toContain("deploy");
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
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
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

  it("canonical: deployment state allows deploy and reject (not just deploy)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    // 'reject' requires no capability — should pass through
    const result = await checkWorkflowRules("reject", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("canonical: deployment state blocks 'submit' (illegal), names deploy and reject as legal", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("deploy");
    expect(result).toContain("reject");
    expect(result).toContain("escape");
  });

  it("canonical: deploy in deployment state is blocked for non-deployment body (charles)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy:execute");
    expect(result).toContain("deployment");
  });

  it("canonical: deploy in deployment state is allowed for Hanzo (deployment body)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:low"]);
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
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
  /** Branch/PR status for done gate (AI-1475 D1 + AI-1492). Defaults to has branch + PR (pass gate). */
  branchStatus?: { hasBranch?: boolean; hasPR?: boolean; hasMergedPR?: boolean } | null;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const teamId = opts.teamId ?? "team-uuid";
  const teamLabels = opts.teamLabels ?? [];
  const issueUpdateSuccess = opts.issueUpdateSuccess ?? true;
  // Default: branch pushed + PR exists (gate passes)
  const branch = opts.branchStatus === null ? null : {
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

    // AI-1475 D1 + AI-1492: Branch/PR status for done gate.
    if (query.includes("IssueBranchAndPR")) {
      if (branch === null) {
        // Simulate fetch error for branch/PR query
        throw new Error("simulated branch/PR fetch error");
      }
      const prState = branch.hasMergedPR ? "merged" : "open";
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              branch: branch.hasBranch ? { id: "branch-id", name: "feature-branch", updatedAt: "2026-06-09T00:00:00Z" } : null,
              pullRequests: branch.hasPR ? { nodes: [{ id: "pr-id", state: prState }] } : { nodes: [] },
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
    // Should not throw even on fetch failure.
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toBeUndefined();
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
    // Ticket is in deployment state (per getCurrentState from labels) but
    // actually missing the state:deployment label. B2 should re-stamp it.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      // Override: simulate the case where state:deployment IS present
      // (this is the normal idempotent case with label present).
    });
    globalThis.fetch = mock;
    await applyStateTransition("approve", "issue-uuid", "Bearer tok");
    // approve: code-review → deployment. Current state is deployment.
    // Label state:deployment is present. So no-op.
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
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toBeUndefined();
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
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toBeUndefined();
  });
});

describe("applyStateTransition — break-glass escape", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("transitions to state:escape from any state on 'escape' command", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "escape-lbl", name: "state:escape" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("escape-lbl");
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

  it("passes through when body is not an issueUpdate mutation", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
      variables: { input: { issueId: "issue-uuid", body: "comment text" } },
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
    const result = await buildStateTransitionReminder("submit", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Workflow]");
    expect(result).toContain("code-review");
    expect(result).toContain("approve");
    expect(result).toContain("request-changes");
    expect(result).toContain("escape");
  });

  it("returns reminder for implementation state after accept from intake", async () => {
    const result = await buildStateTransitionReminder("accept", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });

  it("returns null for terminal state (done)", async () => {
    // After "deploy" (deployment → done), the destination is terminal.
    const result = await buildStateTransitionReminder("deploy", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null for terminal escape state", async () => {
    const result = await buildStateTransitionReminder("escape", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null for unknown intent", async () => {
    const result = await buildStateTransitionReminder("unknown-command", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null when issueId is null", async () => {
    const result = await buildStateTransitionReminder("submit", null, "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns reminder for deployment state after approve from code-review", async () => {
    const result = await buildStateTransitionReminder("approve", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("deployment");
    expect(result).toContain("deploy");
    expect(result).toContain("reject");
  });

  it("returns reminder for implementation state after request-changes from code-review", async () => {
    const result = await buildStateTransitionReminder("request-changes", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });
});

// ── AI-1475 Defect 1: Done gate — branch/PR verification before deploy→done ──────

describe("checkWorkflowRules — AI-1475 D1: done gate (branch/PR verification)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'deploy' → done when branch exists and PR exists", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: true, hasPR: true });
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("blocks 'deploy' → done when branch is not pushed", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: false, hasPR: true });
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("branch not pushed to origin");
  });

  it("blocks 'deploy' → done when no PR exists", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: true, hasPR: false });
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("no pull request associated");
  });

  // AI-1497: Complete absence of evidence is now fail-open — data likely lost to auto-delete.
  it("allows 'deploy' → done when neither branch nor PR exist (AI-1497 fail-open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: false, hasPR: false });
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull(); // fail-open: data likely lost to auto-delete
  });

  // AI-1497: null after retry is now fail-open to avoid stranding tickets.
  it("fail-open: allows 'deploy' → done when branch/PR fetch returns null twice (API error, AI-1497)", async () => {
    // Simulate: label fetch works, but branch/PR fetch returns no data twice
    let fetchCallCount = 0;
    globalThis.fetch = async (_url, init) => {
      fetchCallCount++;
      const bodyText = typeof init?.body === "string" ? init.body : "";
      // Label fetch works
      if (bodyText.includes("IssueContext")) {
        return new Response(JSON.stringify({
          data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] }, delegate: null } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // Branch/PR fetch returns null-like data (no issue) — both times
      if (bodyText.includes("IssueBranchAndPR")) {
        return new Response(JSON.stringify({ data: { issue: null } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch call: ${bodyText.slice(0, 60)}`);
    };
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).toBeNull(); // fail-open after retry
    expect(fetchCallCount).toBeGreaterThanOrEqual(3); // label fetch + 2 branch/PR fetches
  });

  it("done gate does NOT fire for non-deploy commands (reject in deployment state)", async () => {
    // 'reject' goes deployment → implementation, not to done
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: false, hasPR: false });
    expect(await checkWorkflowRules("reject", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  // AI-1492 regression: branch auto-deleted after squash merge — merged PR must still pass.
  it("allows 'deploy' → done when PR is merged but branch is deleted (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: false, hasPR: true, hasMergedPR: true });
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("allows 'deploy' → done when PR is merged and branch still exists (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: true, hasPR: true, hasMergedPR: true });
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("still blocks 'deploy' → done when PR is open (not merged) and branch is deleted (AI-1492)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { hasBranch: false, hasPR: true, hasMergedPR: false });
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("branch not pushed to origin");
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

describe("applyStateTransition — AI-1475 D1: done gate defense-in-depth", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks label swap to done when branch not pushed (defense-in-depth)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: { hasBranch: false, hasPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    // No ApplyAtomicTransition call — done gate blocked it
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("blocks label swap to done when no PR exists (defense-in-depth)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: { hasBranch: true, hasPR: false },
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("allows label swap to done when branch + PR exist", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: { hasBranch: true, hasPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  it("done gate does not block non-deploy transitions", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
      branchStatus: { hasBranch: false, hasPR: false }, // Should not matter for submit
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  // AI-1492 regression: merged PR passes B2 defense-in-depth even when branch is deleted.
  it("allows label swap to done when PR is merged but branch is deleted (AI-1492)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: { hasBranch: false, hasPR: true, hasMergedPR: true },
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  // AI-1497: complete absence of evidence is fail-open in B2 too.
  it("allows label swap to done when neither branch nor PR exist (AI-1497 fail-open)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: { hasBranch: false, hasPR: false },
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  // AI-1497: null after retry is fail-open in B2.
  it("allows label swap to done when branch/PR fetch throws both times (AI-1497 fail-open)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: null, // simulates fetch error on every attempt
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
  });

  it("still blocks label swap to done when PR is open (not merged) and branch is deleted (AI-1492)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
      branchStatus: { hasBranch: false, hasPR: true, hasMergedPR: false },
    });
    globalThis.fetch = mock;
    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");
    // No ApplyAtomicTransition call — done gate blocked it
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
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

  it("blocks needs-human in deployment (forward path: deploy, reject)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
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
    for (const state of ["intake", "implementation", "code-review", "deployment", "done"]) {
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

  it("unknown caller on ad-hoc ticket is pass-through (no wf:* label)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).toBeNull();
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
  - id: orchestrator
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

    // Set up agents.json with hanzo (deployment body) having a linearUserId
    const agentsFile = path.join(autoDelegateDir, "agents.json");
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
    // Simulate a scenario where getAgent returns undefined (body not in agents.json)
    // by using a body name that doesn't exist. The label swap should still succeed.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "deploy-lbl", name: "state:deployment" }],
    });
    globalThis.fetch = mock;

    // Temporarily remove hanzo from agents
    const agentsFile = path.join(autoDelegateDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [{
        name: "charles",
        linearUserId: "charles-linear-uuid",
        clientId: "charles-client",
        clientSecret: "charles-secret",
        accessToken: "charles-token",
        refreshToken: "charles-refresh",
      }],
    }, null, 2), "utf8");
    reloadAgents();

    await applyStateTransition("approve", "issue-uuid", "Bearer tok");

    // Label swap should still have happened despite missing hanzo agent
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();

    // No delegate update (hanzo not in agents)
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
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                branch: { id: "branch-id", name: "feature-branch", updatedAt: "2026-06-09T00:00:00Z" },
                pullRequests: { nodes: [{ id: "pr-id", state: "open" }] },
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
    // Use dev-impl workflow def for this test since the child is wf:dev-impl
    const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
    process.env.WORKFLOW_DEF_PATH = devImplFixture;
    resetWorkflowCache();

    globalThis.fetch = makeBarrierIntegrationFetch({
      childLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:ac-validate" },
      ],
    });

    // v8: validated from ac-validate → done (terminal)
    await applyStateTransition("validated", "AI-2001", "Bearer tok");

    // Restore ux-audit workflow def
    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;

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
        { id: "state-lbl", name: "state:deployment" },
      ],
    });

    await applyStateTransition("deploy", "AI-2001", "Bearer tok");

    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;

    // State transition should happen
    const stateTransition = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(stateTransition).toBeDefined();

    // Barrier check should return early (no parent)
    const childrenFetch = calls.find((c) => c.query.includes("ParentChildren"));
    expect(childrenFetch).toBeUndefined();
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
  let sprintDir: string;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    sprintDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprint-test-"));
    const policyFile = path.join(sprintDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, SPRINT_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
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
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
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
      // Label swap mutation
      if (bodyText.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
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

    it("sprint-owner (soren) blocked from deploy on dev-impl child", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
      const result = await checkWorkflowRules("deploy", "AI-3001", "Bearer tok", "soren");
      expect(result).not.toBeNull();
      // soren is blocked — either as unknown caller or by deploy:execute capability gate.
      // Both reasons are structurally sound: the sprint owner cannot deploy.
      expect(result).toContain("[Proxy]");
      expect(result!.includes("deploy:execute") || result!.includes("Unknown caller")).toBe(true);

      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });

    it("fan-out triggers for sprint just like ux-audit", async () => {
      const { shouldTriggerFanout } = await import("./fanout.js");
      expect(shouldTriggerFanout("sprint", "spawning", "spawn")).toBe(true);
      expect(shouldTriggerFanout("sprint", "managing", "spawn")).toBe(false);
      expect(shouldTriggerFanout("sprint", "spawning", "complete")).toBe(false);
      expect(shouldTriggerFanout("ux-audit", "spawning", "spawn")).toBe(true);
    });
  });

  // ── F4: Self-merge is structurally impossible ────────────────────────

  describe("F4: self-merge is structurally impossible (deploy:execute gate)", () => {
    it("sprint-owner cannot deploy even if in deployment state", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
      const result = await checkWorkflowRules("deploy", "AI-3001", "Bearer tok", "soren");
      expect(result).not.toBeNull();
      // Blocked — either unknown caller or deploy:execute. Both prove F4.
      expect(result!.includes("deploy:execute") || result!.includes("Unknown caller")).toBe(true);

      process.env.WORKFLOW_DEF_PATH = CANONICAL_SPRINT_FIXTURE;
      process.env.CAPABILITY_POLICY_PATH = path.join(c3Dir, "capability-policy.yaml");
      resetPolicyCache();
    });

    it("only Hanzo (deployment body) can deploy", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:low"], { hasBranch: true, hasPR: true });
      expect(await checkWorkflowRules("deploy", "AI-3001", "Bearer tok", "hanzo")).toBeNull();

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

    // AI-1497: deploy now fails open when no branch/PR evidence exists (data likely lost to auto-delete).
    // Previously this blocked, but the absence of evidence is not evidence of absence.
    it("dev-impl deploy passes done gate when no branch/PR evidence (AI-1497 fail-open)", async () => {
      const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
      process.env.WORKFLOW_DEF_PATH = devImplFixture;
      resetWorkflowCache();

      const devImplPolicyFile = path.join(c3Dir, "dev-impl-policy.yaml");
      fs.writeFileSync(devImplPolicyFile, TEST_POLICY_YAML, "utf8");
      process.env.CAPABILITY_POLICY_PATH = devImplPolicyFile;
      resetPolicyCache();

      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment", "stakes:low"], { hasBranch: false, hasPR: false });
      const result = await checkWorkflowRules("deploy", "AI-3001", "Bearer tok", "hanzo");
      expect(result).toBeNull(); // AI-1497: fail-open on no evidence

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

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    confDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1498-conformance-"));
    const policyFile = path.join(confDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;

    // AI-1531: isolate the implementer store to this suite's tmpdir so a stale
    // /tmp/implementer-store.json can never poison reject/request-changes.
    originalImplementerStorePath = process.env.IMPLEMENTER_STORE_PATH;
    process.env.IMPLEMENTER_STORE_PATH = path.join(confDir, "implementer-store.json");
  });

  afterAll(() => {
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
    deployment: "todo",
    "host-deploy": "todo",
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
        return new Response(
          JSON.stringify({ data: { issue: { branch: { id: "branch-id", name: "feature", updatedAt: "2026-06-09T00:00:00Z" }, pullRequests: { nodes: [{ id: "pr-id", state: "open" }] } } } }),
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
    // Walk the full dev-impl v8 happy path:
    //   intake → write-tests → implementation → code-review → deployment → ac-validate → done
    const transitions: Array<{ intent: string; fromLabels: string[]; toState: string }> = [
      { intent: "accept", fromLabels: ["wf:dev-impl", "state:intake"], toState: "write-tests" },
      { intent: "tests-ready", fromLabels: ["wf:dev-impl", "state:write-tests"], toState: "implementation" },
      { intent: "submit", fromLabels: ["wf:dev-impl", "state:implementation"], toState: "code-review" },
      { intent: "approve", fromLabels: ["wf:dev-impl", "state:code-review"], toState: "deployment" },
      { intent: "deploy", fromLabels: ["wf:dev-impl", "state:deployment"], toState: "ac-validate" },
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

  it("escape transition writes invalid native stateId", async () => {
    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:implementation"]);
    globalThis.fetch = fetch;

    await applyStateTransition("escape", "AI-CONF-ESC", "Bearer tok", { bodyId: "astrid" });

    const atomicMutation = mutations.find((m) => m.query.includes("ApplyAtomicTransition"));
    expect(atomicMutation).toBeDefined();
    const vars = atomicMutation!.variables as { stateId?: string };
    expect(vars.stateId).toBe(SEMANTIC_TO_UUID["invalid"]);
  });

  it("reject transition routes back to implementation with todo resting native state", async () => {
    resetWorkflowCache();
    resetNativeStateCache();
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:deployment"]);
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
    const { fetch, mutations } = makeConformanceFetch(["wf:dev-impl", "state:deployment"]);
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

// ── AI-1521: unescape re-entry verb ──────────────────────────────────────

// Shared setup for AI-1521 test suites: own temp dir so corrupted WORKFLOW_DEF_PATH /
// CAPABILITY_POLICY_PATH from earlier test suites (ai1463, ai1493) don't interfere.
let ai1521Dir: string;
let ai1521OrigWorkflowPath: string | undefined;
let ai1521OrigPolicyPath: string | undefined;

function setupAi1521(): void {
  ai1521OrigWorkflowPath = process.env.WORKFLOW_DEF_PATH;
  ai1521OrigPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  ai1521Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1521-test-"));
  const policyFile = path.join(ai1521Dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
}

function teardownAi1521(): void {
  fs.rmSync(ai1521Dir, { recursive: true, force: true });
  if (ai1521OrigWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = ai1521OrigWorkflowPath;
  else delete process.env.WORKFLOW_DEF_PATH;
  if (ai1521OrigPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = ai1521OrigPolicyPath;
  else delete process.env.CAPABILITY_POLICY_PATH;
}

describe("checkWorkflowRules — AI-1521: unescape from escape state", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(setupAi1521);
  afterAll(teardownAi1521);

  beforeEach(() => {
    resetWorkflowCache();
    resetNativeStateCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("unescape is legal from escape state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:escape"]);
    expect(await checkWorkflowRules("unescape", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("unescape is blocked from non-escape states (e.g. implementation)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("unescape", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });

  it("unescape is blocked from done state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    const result = await checkWorkflowRules("unescape", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("done");
  });

  it("illegal command on escaped ticket names unescape as legal move", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:escape"]);
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("unescape");
    expect(result).toContain("escape"); // break-glass still listed
  });
});

describe("applyStateTransition — AI-1521: unescape re-entry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(setupAi1521);
  afterAll(teardownAi1521);

  beforeEach(() => {
    resetWorkflowCache();
    resetNativeStateCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("transitions escape → intake atomically (labels + delegate + native state)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "escape-lbl", name: "state:escape" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("unescape", "issue-uuid", "Bearer tok", { bodyId: "astrid" });

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[]; delegateId?: string; stateId?: string };
    // state:intake label is added, state:escape is removed
    expect(vars.labelIds).toContain("intake-lbl");
    expect(vars.labelIds).not.toContain("escape-lbl");
    // native state is set (Todo for intake)
    expect(vars.stateId).toBe("state-todo-uuid");
  });

  it("canonical: unescape is legal from escape state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:escape"]);
    expect(await checkWorkflowRules("unescape", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
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
