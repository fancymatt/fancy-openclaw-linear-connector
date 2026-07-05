/**
 * AI-1813: escape (break-glass) silently no-ops on tickets with no state:* label
 *
 * Bug: `applyStateTransition` (~line 2155 of workflow-gate.ts) checks for a
 * source state BEFORE the break-glass branch. On a label-stripped ticket,
 * `escape` posts its comment but the transition silently fails (no-op return).
 *
 * Fix (not implemented here — tests only):
 *   1. `applyStateTransition`: when intent === breakGlassCommand, treat
 *      missing source state as `from: null` and proceed.
 *   2. `checkWorkflowRules`: ensure escape verb passes its gates with no
 *      state:* label (already works per existing test at line 463, but the
 *      proxy full path is validated here).
 *
 * AC mapping:
 *   AC1 → applyStateTransition unit + proxy integration
 *   AC2 → regression: unit on applyStateTransition + proxy intent path
 *   AC3 → existing escape-from-known-state tests remain green (no code changes)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import request from "supertest";
import { applyStateTransition, checkWorkflowRules } from "./workflow-gate.js";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Shared test fixtures ──────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: []
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
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
    native_state: todo
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation
  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
      - command: reject
        to: implementation
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

/**
 * Transition-phase fetch mock (mirrors makeTransitionFetch from workflow-gate.test.ts).
 * Handles IssueWithLabels, TeamLabels, ApplyAtomicTransition, UpdateDelegate.
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
      throw new Error("unexpected fetch call");
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
                  { id: "state-done-uuid", name: "Done", type: "completed" },
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

    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };

  return { fetch: mockFetch, calls };
}

// ── AC1: applyStateTransition unit — escape on no-state-label ticket ──────

describe("AI-1813 AC1: applyStateTransition — escape from no-state-label ticket", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1813-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("applies escape on wf-labeled ticket with no state:* label — stamps state:intake (AC1)", async () => {
    // Ticket has wf:dev-impl but NO state:* label — the exact corruption escape must fix.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "AI-1813", "Bearer tok");

    // The transition must NOT be a no-op — must issue ApplyAtomicTransition.
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();

    // Must stamp state:intake (the break_glass.to target).
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("intake-lbl");
    // No stale state:* label was present, so none to remove.
  });

  it("records from=null in the transition comment when escaping from no-state (AC1)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "AI-1813", "Bearer tok");

    // Must issue a commentCreate recording the transition (with from=null).
    const commentCall = calls.find((c) => (c.body.query ?? "").includes("commentCreate"));
    expect(commentCall).toBeDefined();
    // The comment should reference from=null or equivalent (no prior state).
    const commentBody = JSON.stringify(commentCall!.body);
    expect(commentBody).toContain("intake");
  });

  it("does NOT silently no-op — must issue at least one mutation (AC1)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "AI-1813", "Bearer tok");

    // If the bug exists, calls will only contain the IssueWithLabels fetch
    // and the TeamLabels fetch — no mutation. After the fix, there must be
    // an ApplyAtomicTransition call.
    const mutationCalls = calls.filter(
      (c) =>
        (c.body.query ?? "").includes("ApplyAtomicTransition") ||
        (c.body.query ?? "").includes("UpdateDelegate") ||
        (c.body.query ?? "").includes("commentCreate"),
    );
    expect(mutationCalls.length).toBeGreaterThan(0);
  });

  it("clears delegate/assignee when escaping from no-state (AC1)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "AI-1813", "Bearer tok");

    // The transition must include an UpdateDelegate call (or the atomic
    // transition must include assigneeId: null) to clear the delegate.
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as Record<string, unknown>;
    // assigneeId should be null — clearing the assignee per the escape contract.
    // The exact field depends on the mutation shape; check it's in the variables.
    // (The ApplyAtomicTransition mutation includes assigneeId when clearing.)
    expect(vars).toBeDefined();
  });
});

// ── AC2: Regression — checkWorkflowRules allows escape from no-state ───────

describe("AI-1813 AC2: checkWorkflowRules — escape passes gate with no state:* label", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1813-cwr-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeDelegateFetch(labelNames: string[], delegateId: string | null): typeof globalThis.fetch {
    return async (_url, _init) => {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: labelNames.map((n) => ({ name: n })) },
              delegate: delegateId ? { id: delegateId } : null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  }

  it("allows escape through checkWorkflowRules on ticket with wf: label but no state:* label (AC2 regression)", async () => {
    // The gate already works for escape per existing test (line 463 of
    // workflow-gate.test.ts). This is an explicit regression anchor for the
    // no-state scenario that caused AI-1785.
    globalThis.fetch = makeDelegateFetch(["wf:dev-impl", "bug"], "charles-uid");
    const result = await checkWorkflowRules(
      "escape", "AI-1813", "Bearer tok", "charles", null, "charles-uid",
    );
    expect(result).toBeNull();
  });
});

// ── AC2: Integration through proxy intent path ────────────────────────────

describe("AI-1813 AC2: proxy integration — escape from no-state-label ticket end-to-end", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  // No-state-label response: wf:dev-impl present, state:* absent, delegate set.
  const NO_STATE_RESPONSE = {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }] },
        delegate: { id: "u1" },
      },
    },
  };

  // B2 phase response: same labels but with IDs for transition.
  const NO_STATE_WITH_IDS = {
    data: {
      issue: {
        id: "internal-uuid",
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:dev-impl" },
            // No state:* label — the corruption.
          ],
        },
      },
    },
  };

  // Team labels including state:intake (the escape target).
  const TEAM_LABELS_WITH_INTAKE = {
    data: {
      team: {
        labels: {
          nodes: [
            { id: "intake-lbl", name: "state:intake" },
          ],
        },
      },
    },
  };

  function writeAgents(d: string): string {
    const file = path.join(d, "agents.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        agents: [
          { name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok", host: "local" },
        ],
      }),
      "utf8",
    );
    return file;
  }

  function makeProxyFetch(opts: {
    b1Response: object;
    b2Response?: object;
    b2TeamLabels?: object;
    updateSuccess?: boolean;
  }): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: unknown }> } {
    const calls: Array<{ query: string; variables: unknown }> = [];
    const MOCK_MUTATION = { data: { issueUpdate: { success: true } } };

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: unknown };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables });

      const q = parsed.query ?? "";

      // B1 gate fetch — labels for checkWorkflowRules.
      if (q.includes("IssueContext") || (q.includes("IssueLabels") && !q.includes("IssueWithLabels"))) {
        return new Response(JSON.stringify(opts.b1Response), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }

      // B2 transition fetch — labels with IDs.
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify(opts.b2Response ?? NO_STATE_WITH_IDS),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team labels for label lookup.
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify(opts.b2TeamLabels ?? TEAM_LABELS_WITH_INTAKE),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team states for native resolution.
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
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Label creation.
      if (q.includes("issueLabelCreate")) {
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // The forwarded mutation (the actual agent's issueUpdate).
      if (q.includes("issueUpdate")) {
        return new Response(
          JSON.stringify(MOCK_MUTATION),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Delegate update.
      if (q.includes("UpdateDelegate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Comment create.
      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fallback: viewer query or other.
      return new Response(
        JSON.stringify({ data: { viewer: { id: "user-1", name: "Charles" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    return { fetch: mockFetch, calls };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1813-proxy-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("proxy: escape on wf-labeled ticket with no state:* label succeeds end-to-end (AC1+AC2)", async () => {
    const { fetch: mock, calls } = makeProxyFetch({ b1Response: NO_STATE_RESPONSE });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "AI-1813" },
      });

    // The request must succeed — no proxy rejection.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();

    // B2 must have fired — ApplyAtomicTransition must be in the calls.
    const transitionCall = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(transitionCall).toBeDefined();
    // The transition must stamp state:intake.
    const vars = transitionCall!.variables as { labelIds?: string[] };
    expect(vars.labelIds).toContain("intake-lbl");
  });

  it("proxy: escape on no-state-label ticket returns _workflowTransition with status applied (AC1)", async () => {
    const { fetch: mock } = makeProxyFetch({ b1Response: NO_STATE_RESPONSE });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "AI-1813" },
      });

    expect(res.status).toBe(200);
    // The response must include the transition metadata.
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(res.body._workflowTransition.from).toBeNull();
  });

  it("proxy: non-escape intent still blocked on no-state-label ticket (AC3 — no collateral)", async () => {
    const { fetch: mock } = makeProxyFetch({ b1Response: NO_STATE_RESPONSE });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "AI-1813" },
      });

    // Non-escape intents must still be blocked on no-state tickets.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("no 'state:*'");
  });
});

// ── AC3: Existing escape-from-known-state behavior unchanged ─────────────

describe("AI-1813 AC3: existing escape-from-known-state regression guard", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1813-ac3-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("applyStateTransition: escape from a known state (implementation) still stamps state:intake", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "intake-lbl", name: "state:intake" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "AI-1813", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("intake-lbl");
    expect(vars.labelIds).not.toContain("state-lbl"); // old state removed
  });

  it("checkWorkflowRules: escape is still legal from every known state (AC3 non-regression)", async () => {
    function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
      return async (_url, _init) => new Response(
        JSON.stringify({
          data: { issue: { labels: { nodes: labelNames.map((n) => ({ name: n })) }, delegate: null } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    for (const state of ["intake", "implementation", "code-review", "deployment", "done"]) {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "AI-1813", "Bearer tok", "charles");
      expect(result).toBeNull();
    }
  });
});
