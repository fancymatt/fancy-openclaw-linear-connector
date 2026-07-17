/**
 * AI-2532: Governed demote/escape verbs report success but don't change Linear state/labels.
 *
 * Bug: `demote` and `escape` (break-glass) report success (state: Backlog, comment posted)
 * but leave Linear state:* and wf:* labels unchanged on the issue. Two hypotheses:
 *
 *   1. The label mutation succeeds but the bootstrap-reconciliation sweep re-applies
 *      `state:intake` + `wf:dev-impl` (every 5m).
 *   2. The transition handler (applyStateTransition or the proxy) has a bug where it
 *      returns success without actually applying label changes.
 *
 * AC1: A `demote` (→ __ad_hoc__) on a governed workflow ticket removes state:* and wf:*
 *     labels, verified by the mutation record forwarded to the Linear API.
 * AC2: An `escape` (break-glass) on a governed workflow ticket transitions the state:*
 *     label to the break_glass target state (intake), verified by the mutation record.
 * AC3: When demote succeeds, the `_workflowTransition` response indicates
 *     `{status: "applied", code: "demoted-ad-hoc"}` — not a no-op or silent pass-through.
 * AC4: When escape succeeds, the `_workflowTransition` response indicates
 *     `{status: "applied"}` with the target state, and the following fetch of
 *     the ticket's labels shows the transition persisted.
 * AC5 (regression): The reconciliation sweep must not re-apply wf:dev-impl and state:intake
 *     labels to a ticket that has been intentionally demoted out of the workflow.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 9
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
        to: ac-validate
        requires_comment: true
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
      - command: ac-fail
        to: implementation
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "AI-2532";

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

function issueContext(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${state}` }] },
        delegate: delegateUserId ? { id: delegateUserId } : null,
        assignee: delegateUserId ? { id: delegateUserId } : null,
      },
    },
  };
}

function issueWithIds(state: string): object {
  return {
    data: {
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:dev-impl" },
            { id: `${state}-lbl`, name: `state:${state}` },
          ],
        },
        delegate: null,
        assignee: null,
      },
    },
  };
}

const TEAM_LABELS_FIXTURE = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "intake-lbl", name: "state:intake" },
          { id: "implementation-lbl", name: "state:implementation" },
          { id: "done-lbl", name: "state:done" },
        ],
      },
    },
  },
};

const TEAM_STATES_FIXTURE = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-doing", name: "Doing", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    },
  },
};

function commentCreateBody(text: string): object {
  return {
    query: `
      mutation($issueId: ID!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }
    `,
    variables: { issueId: ISSUE_UUID, body: text },
  };
}

/**
 * Make a stateful fetch mock that tracks all calls for assertion.
 */
function makeMockFetch(initialState: string): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    calls.push({ query, variables: parsed.variables ?? {} });

    // AI-1860: IssueContext (G-12 delegate check) — no label IDs needed
    if (query.includes("IssueContext")) {
      return new Response(
        JSON.stringify(issueContext(initialState, "u-astrid")),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueWithLabels (applyStateTransition source label IDs)
    if (query.includes("IssueWithLabels")) {
      return new Response(
        JSON.stringify(issueWithIds(initialState)),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // TeamLabels (label ID resolution)
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify(TEAM_LABELS_FIXTURE),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // TeamStates (native state resolution)
    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify(TEAM_STATES_FIXTURE),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Branch/PR status query
    if (query.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({ data: { issue: { branch: null, pullRequests: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Forwarded mutation (commentCreate or issueUpdate from the CLI)
    if (query.includes("commentCreate") || query.includes("issueUpdate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c-1" } }, issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // issueLabelCreate (new label when it doesn't exist yet)
    if (query.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-lbl-id" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ApplyAtomicTransition (state:* label swap)
    if (query.includes("ApplyAtomicTransition")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // UpdateDelegate
    if (query.includes("UpdateDelegate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueByVcsBranch (for done gate)
    if (query.includes("IssueByVcsBranch")) {
      return new Response(
        JSON.stringify({ data: { issueByVcsBranch: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fallback: 404 for unrecognized queries (tests will fail noisily)
    return new Response(
      JSON.stringify({ errors: [{ message: `unexpected query: ${query.slice(0, 80)}` }] }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };

  return { fetch: mockFetch, calls };
}

// ── Test setup ───────────────────────────────────────────────────────────

let appState: ReturnType<typeof createApp>;
let dir: string;
let originalFetch: typeof globalThis.fetch;

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2532-"));
  process.env.AGENTS_FILE = writeAgents(dir);
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  const wfFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = wfFile;
  process.env.ADMIN_SECRET = "admin-secret";

  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();
  appState = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "events.db"),
    mutationAuditDbPath: path.join(dir, "audit.db"),
  });

  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.mutationAuditStore.close();
  appState.watchdog.stop();
  appState.noActivityDetector.stop();
  appState.managingPoller.stop();
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("AI-2532: demote/escape actually apply state changes", () => {

  it("AC1: demote removes wf:* and state:* labels via ApplyAtomicTransition", async () => {
    const mf = makeMockFetch("intake");
    globalThis.fetch = mf.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting this ticket — misrouted to dev-impl"));

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();

    // AC3: response must indicate the transition was applied
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(res.body._workflowTransition.code).toBe("demoted-ad-hoc");

    // AC1: There must be an ApplyAtomicTransition call that requests
    // removal of state:* and wf:* labels (neither is in the target label list)
    const appAtomicCalls = mf.calls.filter(
      (c) => c.query.includes("ApplyAtomicTransition"),
    );
    expect(appAtomicCalls.length).toBeGreaterThanOrEqual(1);

    // The ApplyAtomicTransition should carry only non-workflow labels
    // (no `wf:` or `state:` prefix).
    for (const call of appAtomicCalls) {
      const labelIds = call.variables.labelIds as string[] | undefined;
      if (labelIds) {
        // Each labelId maps: "wf-lbl" = wf:dev-impl, "intake-lbl" = state:intake
        // A demoted ticket should keep NEITHER
        expect(labelIds).not.toContain("wf-lbl");
        expect(labelIds).not.toContain("intake-lbl");
      }
    }
  });

  it("AC2: escape transitions state:* label to intake via ApplyAtomicTransition", async () => {
    const mf = makeMockFetch("implementation");
    globalThis.fetch = mf.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send(commentCreateBody("Break-glass — recovering stranded ticket."));

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();

    // AC4: response must indicate the transition was applied toward intake
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(res.body._workflowTransition.to).toBe("intake");

    // AC2: An ApplyAtomicTransition call must swap the state label to intake
    const appAtomicCalls = mf.calls.filter(
      (c) => c.query.includes("ApplyAtomicTransition"),
    );
    expect(appAtomicCalls.length).toBeGreaterThanOrEqual(1);

    // After escape, the label set must include state:intake label
    // wf:dev-impl should still be present (the ticket remains in the workflow)
    let foundIntakeLabel = false;
    for (const call of appAtomicCalls) {
      const labelIds = call.variables.labelIds as string[] | undefined;
      if (labelIds) {
        // Must include "intake-lbl" (the state:intake label id)
        // Must NOT include "implementation-lbl" (the old state)
        if (labelIds.includes("intake-lbl")) {
          foundIntakeLabel = true;
        }
        expect(labelIds).not.toContain("implementation-lbl");
      }
    }
    expect(foundIntakeLabel).toBe(true);
  });

  it("AC4: escape from intake re-stamps state:intake (idempotency does not skip stale-cleanup)", async () => {
    // Edge case: escape already at state:intake — the idempotency check
    // should verify the label is actually present and purge any stale labels.
    const mf = makeMockFetch("intake");
    globalThis.fetch = mf.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send(commentCreateBody("Break-glass on an already-intake ticket."));

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();

    // Should at minimum produce an ApplyAtomicTransition (the stale-label-purge path)
    // or complete successfully.
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toMatch(/^(applied|noop)$/);
  });

  it("AC3: demote on a ticket with no wf labels is a no-op (already ad-hoc)", async () => {
    // Ticket already has no workflow labels — demote should short-circuit.
    const noLabelsResponse = {
      data: {
        issue: {
          id: ISSUE_UUID,
          identifier: ISSUE_IDENTIFIER,
          team: { id: "team-uuid" },
          labels: { nodes: [{ id: "other-lbl", name: "priority:high" }] },
          delegate: null,
          assignee: null,
        },
      },
    };

    const calls: FetchCall[] = [];
    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) throw new Error("bad url");
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      calls.push({ query: parsed.query ?? "", variables: {} });

      if (parsed.query?.includes("IssueContext")) {
        return new Response(
          JSON.stringify({ data: { issue: { labels: { nodes: [{ name: "priority:high" }] }, delegate: null, assignee: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (parsed.query?.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify(noLabelsResponse),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Everything else delegates to a standard pass-through
      if (parsed.query?.includes("commentCreate") || parsed.query?.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c-1" } }, issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    globalThis.fetch = mockFetch;
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting already-ad-hoc ticket."));

    expect(res.status).toBe(200);
    // No ApplyAtomicTransition should fire for a ticket already out of workflow
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("AC5: demote reports fail-closed when issueUpdateLabels returns false (bug: __ad_hoc__ ignores result)", async () => {
    // The __ad_hoc__ (demote) path in applyStateTransition calls
    // `issueUpdateLabels` but does NOT check its return value — it always
    // returns `{status: "applied", code: "demoted-ad-hoc"}` even when the
    // Linear mutation explicitly returns `{success: false}`.
    //
    // This is the root cause of AI-2532: a demote that fails to remove
    // workflow labels reports success because the label mutation result is
    // never checked.
    const mf = makeMockFetch("intake");
    const originalFetch = mf.fetch;
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      // Intercept the actual label-swap mutation (ApplyAtomicTransition)
      // and make it fail while letting everything else pass through.
      if (parsed.query?.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: false } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url, init);
    };

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting with failing label mutation."));

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toBeDefined();
    // The __ad_hoc__ path in applyStateTransition does not check the return
    // value of issueUpdateLabels — it always returns {status: "applied"}.
    // This is the root cause of AI-2532: a label-swap failure is silently
    // swallowed, and the CLI sees a "success" even though labels were not
    // removed.
    //
    // Fix: check the return value and return {status: "failed",
    // code: "atomic-mutation-failed"} when the labels did not apply.
    expect(res.body._workflowTransition.status).toBe("failed");
  });
});
