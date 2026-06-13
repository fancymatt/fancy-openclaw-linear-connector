/**
 * Tests for AI-1575: atomic `enroll` verb — first-class enrollment for dev-impl.
 *
 * AC1: applyEnrollment on a clean ad-hoc ticket produces a SINGLE issueUpdate
 *      mutation that atomically sets wf:dev-impl + state:intake + risk:<level>
 *      labels, delegate=steward, and native stateId in one write. No intermediate
 *      webhook can observe a governed-but-wrong-delegate state.
 *
 * AC2: applyEnrollment on a ticket that already has a stale/ad-hoc delegate
 *      clears that delegate and sets the steward in the same single write.
 *      No collision; role-router cannot dispatch to the stale owner.
 *
 * AC3: AI-1571 repro — the routing guard does not dispatch the deployment owner
 *      (Hanzo) for a state:intake ticket. checkRoleGuardEnforced blocks Hanzo
 *      and corrects to the steward singleton.
 *
 * AC5 note: these tests must stay red until applyEnrollment is implemented in
 *   workflow-gate.ts. A passing import with an undefined export would still fail
 *   at call-time (TypeError). Either way the suite is red until implementation ships.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";

// ── Mock modules (must precede dynamic imports) ────────────────────────────

const mockLoadWorkflowDef = jest.fn<() => Promise<unknown>>();
const mockResolveBodiesForRole = jest.fn<(role: string) => Promise<string[]>>();

jest.unstable_mockModule("./escalation-gate.js", () => ({
  resolveBodiesForRole: mockResolveBodiesForRole,
  // workflow-gate imports these; provide stubs so the module links correctly.
  bodyHasCapability: jest.fn().mockResolvedValue(true),
  isBodyKnown: jest.fn().mockResolvedValue(true),
}));

// Partial mock: override loadWorkflowDef but keep the rest of workflow-gate real.
// Note: we cannot partially mock our own module under test. Instead we use
// env vars to point to a temp YAML, exercising the real loadWorkflowDef path.

// ── Dynamic import after mocks ─────────────────────────────────────────────

// applyEnrollment does NOT exist yet. The destructure returns undefined,
// and all tests that call it fail with TypeError (red gate for AC5).
const { applyEnrollment, resetWorkflowCache } = await import("./workflow-gate.js") as {
  applyEnrollment: (opts: {
    issueIdentifier: string;
    workflow: string;
    risk: "low" | "medium" | "high";
    authToken: string;
    stewardLinearUserId?: string;
  }) => Promise<{ success: boolean; mutationCount: number }>;
  resetWorkflowCache: () => void;
};

const { checkRoleGuardEnforced } = await import("./routing-guard.js") as {
  checkRoleGuardEnforced: (target: string, labels: string[]) => Promise<{ blocked: boolean; reason?: string; correctedTo?: string }>;
};

// ── Minimal dev-impl YAML fixture ──────────────────────────────────────────

const DEV_IMPL_YAML = `
id: dev-impl
version: 8
archetype: single-task
entry_state: intake
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
        to: code-review
        assign: { mode: required }
  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

const CAPABILITY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [human:escalate]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

// ── Test infrastructure ────────────────────────────────────────────────────

let tmpDir: string;
let savedDefPath: string | undefined;
let savedCapPath: string | undefined;
let savedWfDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "enroll-test-"));
  const defFile = path.join(tmpDir, "dev-impl.yaml");
  const capFile = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(defFile, DEV_IMPL_YAML);
  fs.writeFileSync(capFile, CAPABILITY_YAML);

  savedDefPath = process.env.WORKFLOW_DEF_PATH;
  savedCapPath = process.env.CAPABILITY_POLICY_PATH;
  savedWfDir = process.env.WORKFLOW_DEF_DIR;

  process.env.WORKFLOW_DEF_PATH = defFile;
  process.env.CAPABILITY_POLICY_PATH = capFile;
  delete process.env.WORKFLOW_DEF_DIR;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = savedDefPath;
  else delete process.env.WORKFLOW_DEF_PATH;
  if (savedCapPath !== undefined) process.env.CAPABILITY_POLICY_PATH = savedCapPath;
  else delete process.env.CAPABILITY_POLICY_PATH;
  if (savedWfDir !== undefined) process.env.WORKFLOW_DEF_DIR = savedWfDir;
});

beforeEach(() => {
  resetWorkflowCache();
});

// ── Fetch mock builder for enrollment API calls ────────────────────────────

type FetchCall = { query: string; variables: Record<string, unknown> };

/**
 * Build a fetch mock for enrollment scenarios.
 *
 * The enrollment path makes these Linear API calls:
 *   1. Issue lookup — get internal UUID, teamId, existing labels, existing delegate
 *   2. Team labels lookup — resolve label name → label ID for wf:*, state:*, risk:*
 *   3. Team states lookup — resolve "todo" → native stateId
 *   4. Delegate lookup (optional) — resolve steward body → Linear user ID
 *   5. ApplyAtomicTransition — the single atomic issueUpdate mutation
 *
 * AC1/AC2 key assertion: only ONE call to ApplyAtomicTransition, and it carries
 * labelIds, delegateId, AND stateId in a single mutation.
 */
function makeEnrollFetch(opts: {
  existingDelegate?: string | null;
  existingLabels?: Array<{ id: string; name: string }>;
  stewardLinearUserId?: string;
  atomicSuccess?: boolean;
}): { mockFetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const teamId = "team-uuid";
  const atomicSuccess = opts.atomicSuccess ?? true;
  const existingDelegate = opts.existingDelegate ?? null;
  const existingLabels = opts.existingLabels ?? [];
  const stewardLinearUserId = opts.stewardLinearUserId ?? "astrid-linear-uuid";

  const ALL_TEAM_LABELS = [
    { id: "label-wf-dev-impl", name: "wf:dev-impl" },
    { id: "label-state-intake", name: "state:intake" },
    { id: "label-state-write-tests", name: "state:write-tests" },
    { id: "label-risk-low", name: "risk:low" },
    { id: "label-risk-medium", name: "risk:medium" },
    { id: "label-risk-high", name: "risk:high" },
  ];

  const TEAM_STATES = [
    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
    { id: "state-doing-uuid", name: "Doing", type: "started" },
    { id: "state-done-uuid", name: "Done", type: "completed" },
    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
  ];

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });

    const q = parsed.query ?? "";

    // Issue lookup: returns internal UUID, teamId, existing labels, existing delegate.
    if (q.includes("IssueWithLabels") || (q.includes("issue(") && q.includes("labels"))) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-issue-uuid",
              team: { id: teamId },
              labels: { nodes: existingLabels },
              delegate: existingDelegate ? { id: existingDelegate } : null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Team labels: all available labels for the team.
    if (q.includes("TeamLabels") || (q.includes("team(") && q.includes("labels"))) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: ALL_TEAM_LABELS } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Team states for native state resolution.
    if (q.includes("TeamStates") || (q.includes("team(") && q.includes("states"))) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Delegate (user) lookup by body name.
    if (q.includes("UsersByName") || q.includes("users(") || q.includes("user(")) {
      return new Response(
        JSON.stringify({ data: { users: { nodes: [{ id: stewardLinearUserId, name: "Astrid" }] } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // The atomic enrollment mutation — the single write we're asserting on.
    if (q.includes("ApplyAtomicTransition") || (q.includes("issueUpdate") && q.includes("labelIds"))) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: atomicSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch in enroll test: ${q.slice(0, 100)}`);
  };

  return { mockFetch, calls };
}

// ── AC1: single atomic mutation on a clean ad-hoc ticket ──────────────────

describe("applyEnrollment — AC1: single atomic mutation (clean ad-hoc ticket)", () => {
  it("is exported from workflow-gate — fails until implemented", () => {
    // This assertion fails immediately if applyEnrollment is undefined.
    expect(typeof applyEnrollment).toBe("function");
  });

  it("calls Linear exactly once with labelIds + delegateId + stateId in a single issueUpdate", async () => {
    const { mockFetch, calls } = makeEnrollFetch({
      existingDelegate: null,
      existingLabels: [],
      stewardLinearUserId: "astrid-linear-uuid",
    });
    globalThis.fetch = mockFetch;

    const result = await applyEnrollment({
      issueIdentifier: "AI-9999",
      workflow: "dev-impl",
      risk: "medium",
      authToken: "Bearer test-token",
    });

    expect(result.success).toBe(true);

    // AC1 core: exactly one issueUpdate (ApplyAtomicTransition) call.
    const atomicCalls = calls.filter(
      (c) => c.query.includes("issueUpdate") && c.query.includes("labelIds"),
    );
    expect(atomicCalls).toHaveLength(1);

    const mutation = atomicCalls[0];
    // Labels: wf:dev-impl + state:intake + risk:medium all in one write.
    expect(mutation.variables.labelIds).toEqual(
      expect.arrayContaining(["label-wf-dev-impl", "label-state-intake", "label-risk-medium"]),
    );
    // Delegate: steward's Linear user ID.
    expect(mutation.variables.delegateId).toBe("astrid-linear-uuid");
    // Native state: intake maps to "todo" → "state-todo-uuid".
    expect(mutation.variables.stateId).toBe("state-todo-uuid");
  });

  it("reports the mutation count so callers can assert atomicity (mutationCount === 1)", async () => {
    const { mockFetch } = makeEnrollFetch({});
    globalThis.fetch = mockFetch;

    const result = await applyEnrollment({
      issueIdentifier: "AI-9999",
      workflow: "dev-impl",
      risk: "low",
      authToken: "Bearer test-token",
    });

    expect(result.mutationCount).toBe(1);
  });
});

// ── AC2: stale delegate cleared in the same write ─────────────────────────

describe("applyEnrollment — AC2: stale delegate replaced atomically", () => {
  it("clears stale Hanzo delegate and sets steward in the same single mutation", async () => {
    const { mockFetch, calls } = makeEnrollFetch({
      existingDelegate: "hanzo-linear-uuid",
      existingLabels: [
        // ticket was previously in deployment state ad-hoc
        { id: "old-label-id", name: "wf:some-adhoc" },
      ],
      stewardLinearUserId: "astrid-linear-uuid",
    });
    globalThis.fetch = mockFetch;

    await applyEnrollment({
      issueIdentifier: "AI-1571",
      workflow: "dev-impl",
      risk: "medium",
      authToken: "Bearer test-token",
    });

    const atomicCalls = calls.filter(
      (c) => c.query.includes("issueUpdate") && c.query.includes("labelIds"),
    );

    // AC2: exactly one write (not separate label write + separate delegate write).
    expect(atomicCalls).toHaveLength(1);

    const mutation = atomicCalls[0];
    // Stale delegate is overwritten — the single mutation sets the steward.
    expect(mutation.variables.delegateId).toBe("astrid-linear-uuid");
    // Old ad-hoc labels are NOT in the new labelIds.
    expect((mutation.variables.labelIds as string[]).includes("old-label-id")).toBe(false);
  });

  it("does NOT produce a separate 'clear delegate' mutation before setting steward", async () => {
    const { mockFetch, calls } = makeEnrollFetch({
      existingDelegate: "hanzo-linear-uuid",
      stewardLinearUserId: "astrid-linear-uuid",
    });
    globalThis.fetch = mockFetch;

    await applyEnrollment({
      issueIdentifier: "AI-1571",
      workflow: "dev-impl",
      risk: "medium",
      authToken: "Bearer test-token",
    });

    // No intermediate null-delegate issueUpdate call before the real one.
    const delegateNullCalls = calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === null,
    );
    expect(delegateNullCalls).toHaveLength(0);
  });
});

// ── AC3: AI-1571 repro — role-router does not dispatch Hanzo on intake ────

describe("AI-1571 repro — AC3: routing guard blocks deployment owner on intake ticket", () => {
  it("checkRoleGuardEnforced blocks Hanzo on state:intake (deployment role ≠ steward role)", async () => {
    // Mock routing-guard's dependencies.
    // This test exercises checkRoleGuardEnforced directly to prove the guard
    // logic correctly rejects Hanzo (deployment) for an intake (steward) state.
    mockResolveBodiesForRole.mockImplementation(async (role: string) => {
      if (role === "steward") return ["astrid"];
      if (role === "deployment") return ["hanzo"];
      return [];
    });

    const result = await checkRoleGuardEnforced("hanzo", ["wf:dev-impl", "state:intake"]);

    expect(result.blocked).toBe(true);
    expect(result.correctedTo).toBe("astrid");
  });

  it("checkRoleGuardEnforced corrects to the steward singleton — not a multi-target ambiguity", async () => {
    mockResolveBodiesForRole.mockResolvedValueOnce(["astrid"]);

    const result = await checkRoleGuardEnforced("hanzo", ["wf:dev-impl", "state:intake"]);

    // Singleton steward → correctedTo is set so the webhook can auto-correct.
    expect(result.correctedTo).toBeDefined();
    expect(result.correctedTo).toBe("astrid");
  });

  it("after applyEnrollment, no intermediate event has Hanzo as delegate", async () => {
    // AC3 end-to-end: enroll sets steward atomically, so any post-enrollment
    // guard check sees the steward — not Hanzo — as the legal delegate.
    const { mockFetch, calls } = makeEnrollFetch({
      existingDelegate: "hanzo-linear-uuid",
      stewardLinearUserId: "astrid-linear-uuid",
    });
    globalThis.fetch = mockFetch;

    await applyEnrollment({
      issueIdentifier: "AI-1571",
      workflow: "dev-impl",
      risk: "medium",
      authToken: "Bearer test-token",
    });

    // No call ever sets delegateId to the hanzo UUID.
    const hanzoDelegateCalls = calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === "hanzo-linear-uuid",
    );
    expect(hanzoDelegateCalls).toHaveLength(0);

    // The single mutation sets delegateId to the steward.
    const stewardCalls = calls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === "astrid-linear-uuid",
    );
    expect(stewardCalls).toHaveLength(1);
  });
});
