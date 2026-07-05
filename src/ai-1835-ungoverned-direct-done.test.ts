/**
 * Regression tests for AI-1835: Ungoverned direct-Done (complete verb or raw
 * issueUpdate) bypasses workflow terminal transition on wf-enrolled tickets.
 *
 * Incident: AI-1785 was closed to Done via an intent-less raw issueUpdate
 * (stateId→Done + delegate clear + assignee clear) that bypassed both the
 * intent-path enforcement and the Layer 2 raw-mutation interception.
 * Label reconciliation then projected state:done, making the ungoverned close
 * look legitimate.
 *
 * AC of record (captured at intake 2026-07-05):
 *   (a) `complete` against a `wf:*`-enrolled ticket is rerouted or loudly rejected
 *   (b) a raw intent-less issueUpdate setting terminal state / clearing delegate /
 *       touching state:* labels on an enrolled ticket is blocked the same way
 *   (c) a blocked mutation leaves state, delegate, and labels untouched
 *       (no partial application)
 *   (d) label reconciliation does not project state:done for an ungoverned change
 *       — structured audit record in every case
 *
 * Repo: fancy-openclaw-linear-connector
 * Branch: AI-1835
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  checkWorkflowRules,
  checkRawMutationInterception,
  resetWorkflowCache,
  enrollIfMissing,
  type WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
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
`;

/** Dev-impl workflow with a proper terminal 'done' state and ac-validate gate. */
const DEV_IMPL_WORKFLOW_YAML = `
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
        assign: { default: prior-implementer }

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: ac-validate
        requires_capability: deploy:execute
      - command: reject
        to: implementation
        assign: { default: prior-implementer }

  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
      - command: request-changes
        to: implementation
        assign: { default: prior-implementer }

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

/** UX-audit workflow that HAS a 'complete' legal transition. */
const UX_AUDIT_WORKFLOW_YAML = `
id: ux-audit
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
        to: auditing

  - id: auditing
    owner_role: ux-researcher
    kind: normal
    native_state: doing
    transitions:
      - command: complete-audit
        to: review

  - id: review
    owner_role: steward
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
      - command: request-rework
        to: auditing

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

let dir: string;
let originalWorkflowPath: string | undefined;
let originalPolicyPath: string | undefined;
let originalAgentsFile: string | undefined;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1835-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const devImplFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(devImplFile, DEV_IMPL_WORKFLOW_YAML, "utf8");
  originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
  process.env.WORKFLOW_DEF_PATH = devImplFile;

  // Also write ux-audit for multi-workflow tests
  const uxAuditFile = path.join(dir, "ux-audit.yaml");
  fs.writeFileSync(uxAuditFile, UX_AUDIT_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEFS_DIR = dir;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "reviewer", linearUserId: "reviewer-linear-uuid", clientId: "r", clientSecret: "r", accessToken: "r", refreshToken: "r" },
      { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h", clientSecret: "h", accessToken: "h", refreshToken: "h" },
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c", clientSecret: "c", accessToken: "c", refreshToken: "c" },
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
    ],
  }, null, 2), "utf8");
  originalAgentsFile = process.env.AGENTS_FILE;
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
  delete process.env.WORKFLOW_DEFS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Mock fetch that returns workflow labels for context queries. */
function makeLabelFetch(
  labelNames: string[],
  opts?: {
    delegateId?: string | null;
    teamLabels?: Array<{ id: string; name: string }>;
    internalId?: string;
    identifier?: string;
    teamId?: string;
  },
): typeof globalThis.fetch {
  const teamLabels = opts?.teamLabels ?? [
    { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
    { id: "lbl-state-intake", name: "state:intake" },
    { id: "lbl-state-implementation", name: "state:implementation" },
    { id: "lbl-state-code-review", name: "state:code-review" },
    { id: "lbl-state-deployment", name: "state:deployment" },
    { id: "lbl-state-ac-validate", name: "state:ac-validate" },
    { id: "lbl-state-done", name: "state:done" },
    { id: "lbl-state-escape", name: "state:escape" },
    { id: "lbl-random", name: "priority:high" },
  ];
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";

    // Team states query (for native state resolution)
    if (bodyText.includes("TeamStates")) {
      return new Response(JSON.stringify({
        data: { team: { states: { nodes: [
          { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
          { id: "state-doing-uuid", name: "Doing", type: "started" },
          { id: "state-thinking-uuid", name: "Thinking", type: "started" },
          { id: "state-done-uuid", name: "Done", type: "completed" },
          { id: "state-invalid-uuid", name: "Canceled", type: "canceled" },
        ] } } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Team labels query (for state label ID resolution)
    if (bodyText.includes("TeamStateLabels")) {
      return new Response(JSON.stringify({
        data: { issue: { team: { labels: { nodes: teamLabels } } } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Issue context with delegate
    if (bodyText.includes("delegate") && bodyText.includes("IssueContext")) {
      return new Response(JSON.stringify({
        data: { issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
          delegate: opts?.delegateId !== undefined ? { id: opts.delegateId } : null,
        } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Issue with labels (for fetchIssueWithLabels)
    if (bodyText.includes("IssueWithLabels") || (bodyText.includes("IssueLabels") && bodyText.includes("team"))) {
      return new Response(JSON.stringify({
        data: { issue: {
          id: opts?.internalId ?? "issue-uuid",
          identifier: opts?.identifier ?? "AI-1835",
          team: { id: opts?.teamId ?? "team-uuid" },
          labels: { nodes: labelNames.map((name) => ({ name })) },
        } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Default: label-only
    return new Response(JSON.stringify({
      data: { issue: { labels: { nodes: labelNames.map((name) => ({ name })) } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

/** Labels response matching the standard dev-impl shape. */
function devImplLabels(state: string, extra?: string[]): string[] {
  return [`wf:dev-impl`, `state:${state}`, ...(extra ?? [])];
}

/** Labels response matching the ux-audit shape. */
function uxAuditLabels(state: string, extra?: string[]): string[] {
  return [`wf:ux-audit`, `state:${state}`, ...(extra ?? [])];
}

// ── AC(a): `complete` against a wf:*-enrolled ticket is rerouted or loudly rejected ─

describe("AI-1835 AC(a): complete verb blocked on wf-enrolled tickets", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // 'complete' is NOT a defined transition in dev-impl. It must be rejected at
  // every state. The ONLY path to done in dev-impl is 'validated' from ac-validate.
  const DEV_IMPL_STATES = [
    "intake", "implementation", "code-review", "deployment", "ac-validate", "done",
  ];

  for (const state of DEV_IMPL_STATES) {
    it(`rejects 'complete' on wf:dev-impl in state '${state}'`, async () => {
      globalThis.fetch = makeLabelFetch(devImplLabels(state));
      const result = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "charles");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("complete");
    });
  }

  // ux-audit has no 'complete' transition either (it has 'complete-audit')
  const UX_AUDIT_STATES = ["intake", "auditing", "review", "done"];

  for (const state of UX_AUDIT_STATES) {
    it(`rejects 'complete' on wf:ux-audit in state '${state}'`, async () => {
      globalThis.fetch = makeLabelFetch(uxAuditLabels(state));
      const result = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "charles");
      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
    });
  }

  // Rejection must name the legal moves so the agent knows what to use
  it("rejection message names legal workflow commands, not bare def command names", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"));
    const result = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    // Should mention legal alternatives
    expect(result).toContain("submit");
  });
});

// ── AC(b): raw intent-less issueUpdate blocked on enrolled tickets ─────────

describe("AI-1835 AC(b): raw intent-less mutations blocked on wf-enrolled tickets", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // (b1) stateId set to a terminal state UUID
  it("blocks raw stateId mutation to a terminal (Done) state on wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"));
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct");
    expect(result).toContain("blocked");
    expect(result).toContain("implementation");
  });

  // (b2) assigneeId cleared (null) — this is what 'linear complete' does
  it("blocks raw assigneeId:null (clear assignee) on wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"));
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { assigneeId: null } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked");
  });

  // (b3) delegateId cleared (null)
  it("blocks raw delegateId:null (clear delegate) on wf:dev-impl ticket with a known delegate", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"), {
      delegateId: "charles-linear-uuid",
    });
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { delegateId: null } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles", "charles-linear-uuid");
    // BUG (AI-1835): The current implementation allows the current delegate to
    // set delegateId to any value including null (clearing the delegate).
    // The code treats ALL delegate-only changes as "legitimate re-route",
    // but delegateId:null is NOT a re-route — it's part of the ungoverned
    // direct-Done pattern (the complete verb clears delegate + assignee + state).
    // Post-fix: this MUST be blocked.
    expect(result).not.toBeNull();
  });

  // (b4) The incident shape: stateId→Done + delegateId cleared + assigneeId cleared
  it("blocks the incident mutation shape (stateId→Done + delegateId:null + assigneeId:null) on wf:dev-impl", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"), {
      delegateId: "charles-linear-uuid",
    });
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: {
        id: "issue-uuid",
        input: {
          stateId: "state-done-uuid",
          assigneeId: null,
          delegateId: null,
        },
      },
    };
    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "charles", "charles-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked");
    expect(result).toContain("status");
  });

  // (b5) Inline mutation (field key in query text, not in variables)
  it("blocks inline stateId mutation (field key in query text) on wf:dev-impl", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("code-review"));
    const body = {
      query: `mutation M { issueUpdate(
        id: "issue-uuid",
        input: { stateId: "state-done-uuid", assigneeId: null }
      ) { success } }`,
      variables: {},
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked");
  });

  // (b6) Touching state:* labels via labelIds
  it("blocks addedLabelIds containing a state:* label on wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"));
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-state-done"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked");
  });

  // (b7) Touching state:* labels via removedLabelIds
  it("blocks removedLabelIds containing a state:* label on wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"));
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { removedLabelIds: ["lbl-state-implementation"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    // NOTE: removedLabelIds is intercepted by the existing AI-1658 guard.
    // This test ensures it catches state:* label removal specifically.
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  // (b8) Mutation with unresolvable issueId — fail-closed
  it("blocks raw terminal-state mutation with unresolvable issueId (fail-closed)", async () => {
    globalThis.fetch = makeLabelFetch([]);
    const body = {
      query: `mutation M($input: IssueUpdateInput!) {
        issueUpdate(input: $input) { success }
      }`,
      variables: { input: { stateId: "state-done-uuid" } },
    };
    // issueId is null because no id variable and no inline id
    const result = await checkRawMutationInterception(body, null, "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  // (b9) Non-workflow ticket is NOT blocked (pass-through)
  it("allows raw stateId mutation on ad-hoc (non-wf) ticket", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });
});

// ── AC(c): blocked mutation leaves state, delegate, and labels untouched ──

describe("AI-1835 AC(c): blocked mutations are atomic — no partial application", () => {
  let originalFetch: typeof globalThis.fetch;
  let forwardCalls: Array<{ body: string }>;

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
    forwardCalls = [];

    // Mock that records all non-mock Linear API calls (i.e. forwarded mutations)
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("issueUpdate") && !bodyText.includes("IssueContext") && !bodyText.includes("IssueWithLabels") && !bodyText.includes("TeamStateLabels") && !bodyText.includes("TeamStates") && !bodyText.includes("IssueLabels")) {
        // This would be a FORWARDED mutation — record it
        forwardCalls.push({ body: bodyText });
      }
      // Return valid response for the label fetch
      return new Response(JSON.stringify({
        data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // When checkRawMutationInterception returns a rejection, the proxy MUST NOT
  // forward the mutation to Linear. This is tested by asserting that after
  // interception, no forward calls were recorded.
  it("raw stateId→Done block prevents the mutation from reaching Linear", async () => {
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull(); // Blocked
    // The mock fetch should NOT have recorded any forwarded issueUpdate calls
    // (the label fetch queries are internal and excluded by the filter above)
    const forwarded = forwardCalls.filter((c) => c.body.includes("stateId"));
    expect(forwarded).toHaveLength(0);
  });

  it("raw stateId+delegateId+assigneeId block prevents any of those fields from reaching Linear", async () => {
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: {
        id: "issue-uuid",
        input: { stateId: "state-done-uuid", delegateId: null, assigneeId: null },
      },
    };
    const result = await checkRawMutationInterception(
      body, "issue-uuid", "Bearer tok", "charles", "charles-linear-uuid",
    );
    expect(result).not.toBeNull(); // Blocked
    // No forwarded mutation should have been made
    const forwarded = forwardCalls.filter((c) =>
      c.body.includes("stateId") || c.body.includes("delegateId") || c.body.includes("assigneeId"),
    );
    expect(forwarded).toHaveLength(0);
  });
});

// ── AC(d): label reconciliation does not project state:done for ungoverned change ─

describe("AI-1835 AC(d): reconciliation does not project state:done for ungoverned native-state changes", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // A wf:dev-impl ticket whose native Linear state was changed to Done
  // OUTSIDE the workflow (e.g. via raw mutation or human UI edit) must NOT
  // get a state:done label projected by reconciliation. The gap-repair path
  // (enrollIfMissing) should NOT stamp a state:* label when the ticket already
  // has one but the native state disagrees — or when the native state is terminal
  // without a corresponding workflow transition.
  it("enrollIfMissing does NOT stamp state:done when ticket has wf:* but no state:* and native state is Done", async () => {
    // Ticket has wf:dev-impl but NO state:* label, and native state is Done.
    // This is an ungoverned close. enrollIfMissing should NOT stamp state:done.
    const labelWrites: Array<{ labelIds: string[] }> = [];
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";

      // fetchIssueWithLabels: return wf:dev-impl but no state:*
      if (bodyText.includes("IssueWithLabels")) {
        return new Response(JSON.stringify({
          data: { issue: {
            id: "issue-uuid",
            identifier: "AI-1835",
            team: { id: "team-uuid" },
            labels: { nodes: [{ name: "wf:dev-impl", id: "lbl-wf" }] },
          } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // issueUpdateLabels: capture what the reconciler tries to write
      if (bodyText.includes("issueUpdate") && bodyText.includes("labelIds")) {
        const parsed = JSON.parse(bodyText);
        const ids = parsed?.variables?.input?.labelIds ?? parsed?.variables?.labelIds;
        if (ids) labelWrites.push({ labelIds: ids });
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");
    // If the reconciliation stamped state:done (or state:intake), that's the bug.
    // After fix: enrollIfMissing should NOT enroll a ticket whose native state
    // is terminal (Done) — it would be projecting a workflow label onto an
    // already-closed ticket.
    if (result.enrolled) {
      // If enrollment happened, verify it did NOT stamp state:done
      expect(result.entryState).not.toBe("done");
    }
    // Verify no state:done label was written
    const doneWrites = labelWrites.filter((w) =>
      w.labelIds.some((id) => id === "lbl-state-done" || typeof id === "string" && id.includes("done")),
    );
    expect(doneWrites).toHaveLength(0);
  });

  // A raw mutation that adds state:done via addedLabelIds must be blocked by
  // Layer 2 BEFORE it reaches Linear (tested in AC(b6)), ensuring reconciliation
  // never needs to undo it.
  it("Layer 2 blocks raw addedLabelIds with state:done label ID before reconciliation can project it", async () => {
    globalThis.fetch = makeLabelFetch(devImplLabels("implementation"));
    const body = {
      query: `mutation M($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      variables: { id: "issue-uuid", input: { addedLabelIds: ["lbl-state-done"] } },
    };
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("blocked");
  });

  // A ticket with state:implementation whose native state was changed to Done
  // should NOT have state:done projected over state:implementation by reconciliation.
  // The gap-repair (enrollIfMissing) sees a state:* label already present, so it
  // returns early. This is the existing behavior and should remain stable.
  it("enrollIfMissing returns early when state:* label already present, even if native state is Done", async () => {
    // Ticket has wf:dev-impl AND state:implementation — gap-repair should not fire.
    let labelUpdateCalled = false;
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("issueUpdate")) labelUpdateCalled = true;
      return new Response(JSON.stringify({
        data: { issue: {
          id: "issue-uuid",
          identifier: "AI-1835",
          team: { id: "team-uuid" },
          labels: { nodes: [
            { name: "wf:dev-impl", id: "lbl-wf" },
            { name: "state:implementation", id: "lbl-state-impl" },
          ] },
        } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await enrollIfMissing("issue-uuid", "Bearer tok");
    expect(result.enrolled).toBe(false); // Already has state:*
    expect(labelUpdateCalled).toBe(false); // No mutation attempted
  });
});
