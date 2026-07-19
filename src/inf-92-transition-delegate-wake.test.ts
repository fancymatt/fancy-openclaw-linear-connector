/**
 * INF-92 — Transition-stamped delegate does not fire a wake — only external delegate-mutation does
 *
 * AC mapping:
 *   AC1 — A state transition that stamps a new delegate on a work-eligible state
 *         dispatches a wake to that delegate's container.
 *   AC2 — The external delegate-mutation path continues to wake exactly as it
 *         does today (no regression).
 *   AC3 — No double-wake when a transition and an oob-reconcile both land the
 *         same delegate on the same ticket in quick succession (idempotency
 *         preserved by dispatchLeaseStore).
 *   AC4 — Regression test reproducing LIF-54: transition stamps delegate →
 *         assert exactly one wake dispatched.
 *
 * @jest-environment node
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: worker
    grants: [linear:transition]
roles:
  - id: dev
  - id: reviewer
bodies:
  - id: igor
    container: worker
    fills_roles: [dev]
  - id: cra
    container: worker
    fills_roles: [reviewer]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: continue-workflow
        to: code-review

  - id: code-review
    owner_role: reviewer
    kind: normal
    native_state: doing
    transitions:
      - command: approve
        to: done
      - command: reject
        to: implementation
        assign:
          default: prior-implementer

  - id: done
    kind: terminal
    native_state: done
`;

/**
 * Agents fixture. igor and cra are the test subjects:
 *   igor → dev role (implementation state)
 *   cra  → reviewer role (code-review state)
 */
const AGENTS_JSON = {
  agents: [
    { name: "igor", linearUserId: "user-igor", clientId: "c", clientSecret: "s", accessToken: "lin_igor", refreshToken: "r", host: "local" },
    { name: "cra",  linearUserId: "user-cra",  clientId: "c", clientSecret: "s", accessToken: "lin_cra",  refreshToken: "r", host: "local" },
    { name: "ai", linearUserId: "user-ai", clientId: "c", clientSecret: "s", accessToken: "lin_ai", refreshToken: "r", host: "local" },
  ],
};

const ISSUE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEST_IDENTIFIER = "LIF-54";
const TEAM_ID = "team-uuid";

// ── Test helpers ─────────────────────────────────────────────────────────────

let dir: string;
let policyFile: string;
let wfFile: string;
let agentsFile: string;

const ORIG_ENV: Record<string, string | undefined> = {};

/** Track what was written to the Linear API during a test. */
interface CapturedWrites {
  issueUpdates: Array<{ id: string; delegateId: string | null; labelIds: string[] }>;
  commentCreates: Array<{ issueId: string; body: string }>;
}

/**
 * Create a stateful Linear API mock that tracks issue state across
 * mutations so post-write verification reads reflect the updates.
 */
function makeStatefulMock(captured: CapturedWrites): {
  fetch: typeof globalThis.fetch;
  /** Set the initial issue state before a test. */
  setIssue: (id: string, labels: string[], delegateId: string | null, delegateName: string | null) => void;
  /** Get the current delegate for an issue. */
  getDelegate: (id: string) => string | null;
} {
  // In-memory issue state
  const issues = new Map<string, {
    identifier: string;
    labels: Array<{ id: string; name: string }>;
    delegateId: string | null;
    delegateName: string | null;
    stateId: string;
    stateName: string;
    stateType: string;
  }>();

  // The label name → label id mapping (team-scoped)
  const teamLabels = new Map<string, string>([
    ["state:implementation", "label-state-impl"],
    ["state:code-review", "label-state-review"],
    ["state:done", "label-state-done"],
  ]);

  const stateIdMap = new Map<string, string>([
    ["state:implementation", "state-impl"],
    ["state:code-review", "state-review"],
    ["state:done", "state-done"],
  ]);

  const stateNameMap = new Map<string, string>([
    ["state:implementation", "In Progress"],
    ["state:code-review", "Review"],
    ["state:done", "Done"],
  ]);

  const stateTypeMap = new Map<string, string>([
    ["state:implementation", "started"],
    ["state:code-review", "review"],
    ["state:done", "completed"],
  ]);

  function setIssue(
    id: string,
    labelNames: string[],
    delegateId: string | null,
    delegateName: string | null,
    identifierOverride?: string,
  ) {
    const labels = labelNames.map((name) => ({
      id: teamLabels.get(name) ?? `label-${name}`,
      name,
    }));

    // Find the state:* label
    const stateLabel = labels.find((l) => l.name.startsWith("state:"));
    const stateLabelName = stateLabel?.name ?? "state:implementation";

    issues.set(id, {
      identifier: identifierOverride ?? id,
      labels,
      delegateId,
      delegateName,
      stateId: stateIdMap.get(stateLabelName) ?? "state-impl",
      stateName: stateNameMap.get(stateLabelName) ?? "In Progress",
      stateType: stateTypeMap.get(stateLabelName) ?? "started",
    });
  }

  function getDelegate(id: string): string | null {
    return issues.get(id)?.delegateId ?? null;
  }

  // Initialize a default issue — internal GraphQL id is ISSUE_UUID but
  // the human-readable identifier is TEST_IDENTIFIER ("LIF-54"), matching
  // how the Linear API returns both the UUID internal id and a short
  // human-friendly identifier.
  setIssue(ISSUE_UUID, ["wf:dev-impl", "state:implementation"], "user-igor", "igor", TEST_IDENTIFIER);

  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes("api.linear.app/graphql")) {
      return new Response(null, { status: 200 });
    }

    let body: { query?: string; variables?: Record<string, unknown> } = {};
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { /* ignore */ }
    }
    const query = body.query ?? "";
    const vars = (body.variables ?? {}) as Record<string, unknown>;

    const js = <T>(data: T) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    // ── issueUpdate mutation ────────────────────────────────────────────
    // The issueUpdate can come in two shapes:
    //   a) Raw GraphQL with { input: { delegateId, labelIds } } — from proxy forward
    //   b) issueUpdateAtomic with flat vars: { issueId, labelIds, delegateId, stateId }
    if (query.includes("issueUpdate")) {
      const issueId = (vars.id ?? vars.issueId ?? "") as string;

      // Support both shapes
      const inputOrNull = vars.input as Record<string, unknown> | undefined;
      const delegateId =
        (inputOrNull?.delegateId as string | null | undefined) ??
        (vars.delegateId as string | null | undefined) ??
        null;
      const labelIds =
        (inputOrNull?.labelIds as string[] | undefined) ??
        (vars.labelIds as string[] | undefined) ??
        [];
      const stateId = vars.stateId as string | null | undefined;

      captured.issueUpdates.push({ id: issueId, delegateId, labelIds });

      // Update in-memory state
      const issue = issues.get(issueId);
      if (issue) {
        // Update delegate
        if (delegateId !== null) {
          issue.delegateId = delegateId;
          const agent = AGENTS_JSON.agents.find((a) => a.linearUserId === delegateId);
          issue.delegateName = agent?.name ?? delegateId;
        } else if (delegateId === null && inputOrNull?.delegateId === null) {
          issue.delegateId = null;
          issue.delegateName = null;
        }

        // Update labels if labelIds provided (atomic state swap)
        if (labelIds.length > 0) {
          const idToName = new Map<string, string>();
          for (const [name, id] of teamLabels) idToName.set(id, name);

          issue.labels = labelIds.map((lid) => ({
            id: lid,
            name: idToName.get(lid) ?? `unknown:${lid}`,
          }));

          const stateLabel = issue.labels.find((l) => l.name.startsWith("state:"));
          if (stateLabel) {
            issue.stateId = stateIdMap.get(stateLabel.name) ?? issue.stateId;
            issue.stateName = stateNameMap.get(stateLabel.name) ?? issue.stateName;
            issue.stateType = stateTypeMap.get(stateLabel.name) ?? issue.stateType;
          }
        }

        if (stateId) {
          issue.stateId = stateId;
        }
      }

      return js({ data: { issueUpdate: { success: true, issue: { id: issueId } } } });
    }

    // ── commentCreate mutation ──────────────────────────────────────────
    if (query.includes("commentCreate")) {
      const issueId = (vars.issueId ?? "") as string;
      const commentBody = (vars.body ?? "") as string;
      captured.commentCreates.push({ issueId, body: commentBody });

      return js({
        data: { commentCreate: { success: true, comment: { id: "comment-id" } } },
      });
    }

    // ── VerifyTransitionWrite (post-write verification read, AI-1762) ─
    // This is the read-back that checks whether the mutation actually persisted.
    // Must reflect the latest issue state (updated by issueUpdate handler above).
    if (query.includes("VerifyTransitionWrite")) {
      const rawId = (vars.id ?? "") as string;
      const id = rawId || ISSUE_UUID;
      const issue = issues.get(id);
      if (!issue) {
        return js({ data: { issue: null } });
      }
      const delegateResp = issue.delegateId
        ? { id: issue.delegateId, name: issue.delegateName ?? issue.delegateId }
        : null;
      return js({
        data: {
          issue: {
            id,
            labels: { nodes: issue.labels },
            delegate: delegateResp,
            state: issue.stateId ? { id: issue.stateId, name: issue.stateName } : null,
          },
        },
      });
    }

    // ── Issue query (for routing checks / label fetch / other queries) ──
    if (query.includes("query IssueRouting") ||
        query.includes("query CommentRouting") || query.includes("query CurrentDelegate")) {
      const rawId = (vars.id ?? "") as string;
      const id = rawId || ISSUE_UUID;
      const issue = issues.get(id) ?? issues.get(ISSUE_UUID);

      if (!issue) {
        return js({ data: { issue: null } });
      }

      // Build the delegate info for the response
      const delegateResp = issue.delegateId
        ? { id: issue.delegateId, name: issue.delegateName ?? issue.delegateId, app: false }
        : null;

      // Check query shape: if it asks for delegate/assignee specifically
      // vs. full issue context
      if (query.includes("delegate { id }")) {
        return js({
          data: {
            issue: {
              id,
              delegate: delegateResp,
              assignee: null,
              identifier: issue.identifier,
            },
          },
        });
      }

      // Full issue context (for fetchIssueWithLabels)
      return js({
        data: {
          issue: {
            id,
            identifier: issue.identifier,
            title: "Test ticket",
            description: "Test",
            labels: { nodes: issue.labels },
            delegate: delegateResp,
            assignee: null,
            state: { id: issue.stateId, name: issue.stateName, type: issue.stateType },
            team: { id: TEAM_ID },
            project: null,
            relations: { nodes: [] },
          },
        },
      });
    }

    // ── Team query (for label IDs) ──────────────────────────────────────
    if (query.includes("team(")) {
      return js({
        data: {
          team: {
            id: TEAM_ID,
            states: {
              nodes: [
                { id: "state-impl", name: "In Progress", type: "started" },
                { id: "state-review", name: "Review", type: "review" },
                { id: "state-done", name: "Done", type: "completed" },
              ],
            },
            labels: {
              nodes: [
                { id: "label-state-impl", name: "state:implementation" },
                { id: "label-state-review", name: "state:code-review" },
                { id: "label-state-done", name: "state:done" },
              ],
            },
          },
        },
      });
    }

    // ── CreateLabel / findOrCreateLabel mutation ────────────────────────
    if (query.includes("CreateLabel") || query.includes("labelCreate")) {
      return js({
        data: { labelCreate: { success: true, label: { id: "new-label-id" } } },
      });
    }

    // ── FindLabel query ─────────────────────────────────────────────────
    if (query.includes("FindLabel")) {
      return js({
        data: {
          labels: { nodes: [{ id: "label-state-review", name: "state:code-review" }] },
        },
      });
    }

    // ── Generic issue query (IssueLabels, IssueWithLabels, issue(id:) pattern) ──
    // Catches all issue read queries that don't have a specific named handler above.
    // The query must contain "issue(" (which matches issue(id:...) but NOT issueUpdate).
    if (!query.includes("mutation") && /\bissue\(/.test(query)) {
      const rawId = (vars.id ?? "") as string;
      const id = rawId || ISSUE_UUID;
      const issue = issues.get(id);
      if (!issue) {
        return js({ data: { issue: null } });
      }
      const delegateResp = issue.delegateId
        ? { id: issue.delegateId, name: issue.delegateName ?? issue.delegateId }
        : null;
      // Shape depends on the query fields, but the minimum contract is:
      // labels { nodes { name } }, delegate { id }, state { id name type }
      return js({
        data: {
          issue: {
            id,
            identifier: issue.identifier,
            title: "Test ticket",
            description: "Test",
            labels: { nodes: issue.labels },
            delegate: delegateResp,
            assignee: null,
            state: { id: issue.stateId, name: issue.stateName, type: issue.stateType },
            team: { id: TEAM_ID },
            project: null,
            relations: { nodes: [] },
          },
        },
      });
    }

    // ── History query (delegation-reconciliation) ───────────────────────
    if (query.includes("TicketDelegateHistory")) {
      return js({
        data: {
          issue: {
            history: { nodes: [] },
          },
        },
      });
    }

    // ── Issues query (batch) ────────────────────────────────────────────
    if (query.includes("issues") && query.includes("wf:")) {
      return js({ data: { issues: { nodes: [] } } });
    }

    // ── Branch/PR query ─────────────────────────────────────────────────
    if (query.includes("BranchAndPR") || query.includes("branch")) {
      return js({
        data: {
          issue: {
            branch: { name: "test-branch", url: "https://github.com/test" },
            pullRequests: { nodes: [{ merged: true }] },
          },
        },
      });
    }

    // ── Issue description query (H-7) ───────────────────────────────────
    if (query.includes("description")) {
      return js({
        data: {
          issue: { id: ISSUE_UUID, description: "Test description" },
        },
      });
    }

    return js({ data: {} });
  };

  return { fetch, setIssue, getDelegate };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-92-"));

  policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");

  wfFile = path.join(dir, "workflow.yaml");
  fs.writeFileSync(wfFile, TEST_WORKFLOW_YAML, "utf8");

  agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");

  ORIG_ENV.CAPABILITY_POLICY_PATH = process.env.CAPABILITY_POLICY_PATH;
  ORIG_ENV.WORKFLOW_DEF_PATH = process.env.WORKFLOW_DEF_PATH;
  ORIG_ENV.AGENTS_FILE = process.env.AGENTS_FILE;

  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.WORKFLOW_DEF_PATH = wfFile;
  process.env.AGENTS_FILE = agentsFile;
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  jest.resetModules();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("INF-92: transition-stamped delegate dispatch", () => {
  // ── AC4 + AC1: LIF-54 regression — transition stamps delegate → wake dispatched ──

  it("AC4: transition stamps delegate — wake is dispatched (LIF-54 regression)", async () => {
    const captured: CapturedWrites = { issueUpdates: [], commentCreates: [] };

    // Create stateful mock with default issue (igor delegated, implementation)
    const mock = makeStatefulMock(captured);
    jest.spyOn(globalThis, "fetch").mockImplementation(mock.fetch);
    const onTransitionWake = jest.fn();

    const { applyStateTransition, resetWorkflowCache } = await import("./workflow-gate.js");
    const { resetPolicyCache } = await import("./escalation-gate.js");
    const { reloadAgents } = await import("./agents.js");

    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();

    // AC4: Perform a transition from implementation → code-review.
    // This stamps delegate = cra (reviewer role) on the ticket.
    const result = await applyStateTransition(
      "continue-workflow",
      ISSUE_UUID,
      "Bearer lin_igor",
      {
        bodyId: "igor",
        sourceStateOverride: "implementation",
        cliTarget: "cra",
        delegateOverride: "user-cra",
        onTransitionWake,
      } as Parameters<typeof applyStateTransition>[3] & {
        onTransitionWake: typeof onTransitionWake;
      },
    );

    // The transition itself must succeed
    expect(result.status).toBe("applied");

    // Verify the Linear API received the delegate write
    const delegateUpdates = captured.issueUpdates.filter(
      (u) => u.delegateId === "user-cra",
    );
    expect(delegateUpdates.length).toBeGreaterThanOrEqual(1);

    // Verify the mock actually tracked the state change
    const newDelegate = mock.getDelegate(ISSUE_UUID);
    expect(newDelegate).toBe("user-cra");

    // Failing assertion until INF-92 is fixed: the transition-stamped
    // delegate must be woken immediately, not only after an external
    // delegate mutation or oob-reconcile repair.
    expect(onTransitionWake).toHaveBeenCalledTimes(1);
    expect(onTransitionWake).toHaveBeenCalledWith({
      agentName: "cra",
      ticketIdentifier: TEST_IDENTIFIER,
      workflowState: "code-review",
      source: "transition",
    });
  });

  // ── AC2: External delegate-mutation still wakes (no regression) ──────────

  it("AC2: external delegate-mutation path dispatches a wake (regression guard)", async () => {
    // The external path: a Linear webhook fires for a delegate-only change.
    // This is what happens when a human edits the delegate in Linear UI.
    // RouteEventAll → dispatchRoute must still produce a route for the delegate.
    // This path already works and must not regress.

    // Build a delegate-change Linear webhook event
    const { normalizeLinearEvent } = await import("./webhook/normalize.js");
    const { routeEvent } = await import("./router.js");

    const delegateChangeEvent = {
      action: "update" as const,
      type: "Issue" as const,
      data: {
        id: ISSUE_UUID,
        identifier: TEST_IDENTIFIER,
        delegate: { id: "user-cra" },
        assignee: null,
        updatedAt: new Date().toISOString(),
      },
      updatedFrom: {
        delegateId: "user-igor",
      },
      actor: { id: "human-user-id" },
    };

    const event = normalizeLinearEvent(delegateChangeEvent);
    const route = routeEvent(event);

    // The external path MUST route correctly to cra
    expect(route).not.toBeNull();
    if (route && !("suppressed" in route)) {
      expect(route.agentId).toBe("cra");
      expect(route.routingReason).toBe("delegate");
    } else {
      // If suppressed, the test fails — external mut must not be suppressed
      expect(route).not.toHaveProperty("suppressed", true);
    }
  });

  // ── AC3: No double-wake when transition + oob-reconcile land same delegate ──

  it("AC3: dispatch lease prevents double-wake from transition + oob-reconcile", async () => {
    // When a transition stamps delegate = cra AND the oob-reconcile sweep
    // also tries to dispatch the same (agent, ticket), the dispatch lease
    // store must refuse the second attempt.
    //
    // This test verifies the lease mechanism works. The fix must ensure
    // the transition path goes through the same dispatch lease check.

    const { DispatchLeaseStore } = await import(
      "./store/dispatch-lease-store.js"
    );

    const leaseDbPath = path.join(dir, "dispatch-lease.db");
    const store = new DispatchLeaseStore(leaseDbPath);

    // First acquisition — simulates the transition path dispatching first
    const updatedAt = new Date().toISOString();
    const firstLease = store.acquire("cra", "linear-LIF-54", { updatedAt });
    expect(firstLease.refused).toBe(false);

    // Second acquisition — simulates oob-reconcile path trying immediately after
    const secondLease = store.acquire("cra", "linear-LIF-54", { updatedAt });

    // AC3: The second acquisition must be refused (lease still active)
    expect(secondLease.refused).toBe(true);

    // After lease expiry, a fresh acquisition should succeed
    // (the lease TTL has passed — TTL is default 5min)
    const farFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const staleLease = store.acquire("cra", "linear-LIF-54", {
      updatedAt: farFuture,
    });
    expect(staleLease.refused).toBe(false);
  });

  // ── AC1: State transition stamps delegate → wake dispatched ───────────────

  it("AC1: state transition stamps delegate on work-eligible state dispatches wake (no manual clear needed)", async () => {
    // This test verifies the end-to-end behavior: when a governed state
    // transition (e.g. continue-workflow) stamps delegate=cra on a
    // work-eligible state (code-review), a wake is dispatched WITHOUT
    // requiring a manual delegate-clear.
    //
    // The "no manual delegate-clear required" part is load-bearing: the
    // oob-reconcile workaround (clear + let reconcile re-attach) must not
    // be the only path that works.

    const captured: CapturedWrites = { issueUpdates: [], commentCreates: [] };
    const mock = makeStatefulMock(captured);
    jest.spyOn(globalThis, "fetch").mockImplementation(mock.fetch);
    const onTransitionWake = jest.fn();

    const { applyStateTransition, resetWorkflowCache } = await import("./workflow-gate.js");
    const { resetPolicyCache } = await import("./escalation-gate.js");
    const { reloadAgents } = await import("./agents.js");

    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();

    // Run a transition from implementation → code-review with delegate=cra
    const result = await applyStateTransition(
      "continue-workflow",
      ISSUE_UUID,
      "Bearer lin_igor",
      {
        bodyId: "igor",
        sourceStateOverride: "implementation",
        cliTarget: "cra",
        delegateOverride: "user-cra",
        onTransitionWake,
      } as Parameters<typeof applyStateTransition>[3] & {
        onTransitionWake: typeof onTransitionWake;
      },
    );

    expect(result.status).toBe("applied");

    // Verify delegate was written
    const delegateUpdates = captured.issueUpdates.filter(
      (u) => u.delegateId === "user-cra",
    );
    expect(delegateUpdates.length).toBeGreaterThanOrEqual(1);

    // Verify the mock's in-memory state reflects the change
    expect(mock.getDelegate(ISSUE_UUID)).toBe("user-cra");

    // Failing assertion until INF-92 is fixed: no manual delegate-clear or
    // oob-reconcile repair should be required to wake the newly stamped owner.
    expect(onTransitionWake).toHaveBeenCalledTimes(1);
    expect(onTransitionWake.mock.calls[0]?.[0]).toMatchObject({
      agentName: "cra",
      ticketIdentifier: TEST_IDENTIFIER,
      workflowState: "code-review",
      source: "transition",
    });
  });
});
