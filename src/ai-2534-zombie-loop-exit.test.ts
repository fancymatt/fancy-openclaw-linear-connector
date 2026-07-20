/**
 * AI-2534: Connector zombie-loop — dev-impl workflow misapplied to ops-only
 * ticket, escape loop prevents closure.
 *
 * FAILING integration tests (TDD, write-tests state). These tests drive the
 * production entry-point app factory and real webhook/proxy paths, then grade
 * only observable Linear API mutations and /health output. They intentionally
 * do not import or name any future suppression API.
 *
 * ── The zombie loop ──────────────────────────────────────────────────────────
 *
 * An ops-only ticket (credential cleanup, no code changes) enters dev-impl
 * via autoEnrollByTeam. All attempts to exit fail because the connector's
 * re-enrollment paths re-apply wf:dev-impl + state:intake within seconds.
 *
 * Fix options (one or more):
 *   1. Pre-entry guard: detect ops-only tickets and skip dev-impl enrollment
 *   2. Exit valve: demote/escape permanently prevents re-enrollment
 *   3. Operational override: explicit label removal capability
 *
 * AC coverage map:
 *   AC1 — "Running `linear demote <ID>` or `linear escape <ID>` on a
 *          `wf:dev-impl` + `state:intake` ticket permanently exits the ticket
 *          from the dev-impl spine: the connector does NOT re-apply
 *          `wf:dev-impl` or `state:intake` labels within 5 minutes of the
 *          command completing"
 *          → describe("AC1 …") demotes/escapes through /proxy/graphql,
 *            confirms the removal mutation, posts follow-up webhooks (Issue,
 *            IssueLabel), advances time past 5 minutes, and asserts no
 *            re-stamp mutation for that same issue.
 *   AC2 — "A ticket demoted or escaped from dev-impl can subsequently be
 *          closed (`complete`) without re-entering the dev-impl dispatch loop"
 *          → describe("AC2 …") demotes then completes an issue through the
 *            proxy, asserts the complete transition does not trigger a re-
 *            bootstrap or re-enrollment mutation.
 *   AC3 — "The fix is verified against an AI-2307-equivalent scenario: a
 *          ticket with no pending implementation work can be cleanly closed
 *          after accidentally entering dev-impl."
 *          → describe("AC3 …") simulates the exact AI-2307 flow: Issue
 *            created → auto-enrolled → demote → Issue echo webhook →
 *            IssueLabel echo webhook → complete, with assertions at each
 *            step that no governance labels are reapplied.
 *   AC4 — "If a pre-entry guard is introduced (fix option 1), the guard's
 *          activation is observable: a startup log line, label, or audit trail
 *          entry confirms it is registered and active at boot — not just
 *          unit-testable in isolation."
 *          → describe("AC4 …") checks /health for a pre-entry guard
 *            registration field, and/or verifies a startup log line via the
 *            admin-stream or operational events, and/or asserts a label exists
 *            on a guarded ticket.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]

roles:
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
  to: __ad_hoc__
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
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-ai-2534-internal-uuid";
const ISSUE_IDENTIFIER = "AI-2534";
const TEAM_ID = "team-ai";

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "ai",
          linearUserId: "u-ai",
          openclawAgent: "ai",
          accessToken: "tok-ai",
          host: "local",
        },
        {
          name: "astrid",
          linearUserId: "u-astrid",
          openclawAgent: "astrid",
          accessToken: "tok-astrid",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function makeMockFetch(): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
  labelsForIssue: Map<string, Array<{ id: string; name: string }>>;
} {
  const calls: FetchCall[] = [];
  const labelNamesById = new Map<string, string>([
    ["wf-lbl", "wf:dev-impl"],
    ["intake-lbl", "state:intake"],
    ["implementation-lbl", "state:implementation"],
    ["done-lbl", "state:done"],
  ]);
  const labelsByIssue = new Map<string, Array<{ id: string; name: string }>>();

  const labelsForIssue = (issueId: string): Array<{ id: string; name: string }> => {
    const existing = labelsByIssue.get(issueId);
    if (existing) return existing;
    // New issues start with no workflow labels
    const initial = [
      { id: `${issueId}-other-lbl`, name: "component:ops" },
    ];
    labelsByIssue.set(issueId, initial);
    return initial;
  };

  const setIssueLabels = (issueId: string, labelIds: string[]): void => {
    labelsByIssue.set(
      issueId,
      labelIds.map((id) => ({ id, name: labelNamesById.get(id) ?? `label:${id}` })),
    );
  };

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }

    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables });

    // IssueContext — used by proxy route guard (G-12 delegate check)
    if (query.includes("IssueContext")) {
      const id = String(variables.id ?? ISSUE_UUID);
      return jsonResponse({
        data: {
          issue: {
            identifier: id.includes("ai2307") ? "AI-2307" : id.includes("fresh") ? "AI-2534-FRESH" : ISSUE_IDENTIFIER,
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "u-astrid" },
            assignee: { id: "u-astrid" },
          },
        },
      });
    }

    // IssueWithLabels — used by bootstrap and auto-enroll
    if (query.includes("IssueWithLabels")) {
      const id = String(variables.id ?? ISSUE_UUID);
      // Determine identifier from the mock labels map or fall back
      const existingLabels = labelsForIssue(id);
      const identFromLabels = existingLabels.find((l) => l.id.startsWith(id + "-ident-"));
      const identifier = identFromLabels
        ? identFromLabels.name
        : id.includes("later")
          ? "AI-2534-LATER"
          : id.includes("fresh")
            ? "AI-2534-FRESH"
            : id.includes("new")
              ? "AI-2534-NEW"
              : id === "issue-new-ai2307"
                ? "AI-2307"
                : ISSUE_IDENTIFIER;
      return jsonResponse({
        data: {
          issue: {
            id,
            identifier,
            title: "AI-2534 test issue",
            team: { id: TEAM_ID },
            labels: { nodes: labelsForIssue(id) },
            delegate: null,
            assignee: null,
          },
        },
      });
    }

    // TeamLabels — label ID resolution for findOrCreateLabel
    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "intake-lbl", name: "state:intake" },
                { id: "implementation-lbl", name: "state:implementation" },
                { id: "done-lbl", name: "state:done" },
              ],
            },
          },
        },
      });
    }

    // TeamStates — native state resolution
    if (query.includes("TeamStates")) {
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "s-todo", name: "Backlog", type: "backlog" },
                { id: "s-doing", name: "Doing", type: "started" },
                { id: "s-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    // IssueBranchAndPR — for done gate
    if (query.includes("IssueBranchAndPR")) {
      return jsonResponse({ data: { issue: { branch: null, pullRequests: { nodes: [] } } } });
    }

    // IssueRouting — stale-route guard
    if (query.includes("IssueRouting")) {
      return jsonResponse({
        data: {
          issue: {
            id: variables.id,
            identifier: variables.id,
            delegate: null,
            assignee: null,
            state: { name: "Backlog", type: "backlog" },
            relations: { nodes: [] },
          },
        },
      });
    }

    // commentCreate — proxy comment forwarding
    if (query.includes("commentCreate")) {
      return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    // issueLabelCreate — when a label doesn't exist yet
    if (query.includes("issueLabelCreate")) {
      return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "created-lbl-id" } } } });
    }

    // ApplyAtomicTransition — the critical label mutation
    if (query.includes("ApplyAtomicTransition")) {
      setIssueLabels(String(variables.issueId), (variables.labelIds as string[] | undefined) ?? []);
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    // issueUpdate — for direct Linear mutations (e.g., native state change via complete)
    if (query.includes("issueUpdate")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    // UpdateDelegate
    if (query.includes("UpdateDelegate")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    // IssueByVcsBranch — for done gate checks
    if (query.includes("IssueByVcsBranch")) {
      return jsonResponse({ data: { issueByVcsBranch: null } });
    }

    // IssueSearch — used by reconciliation sweep
    if (query.includes("BootstrapReconciliation")) {
      // After demote, no tickets should match (labels were removed)
      return jsonResponse({ data: { issues: { nodes: [] } } });
    }

    // Fallback
    return jsonResponse({ errors: [{ message: `unexpected query: ${query.slice(0, 120)}` }] }, 400);
  };

  return { fetch: mockFetch, calls, labelsForIssue };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function commentCreateBody(text: string, issueId?: string): object {
  return {
    query: `
      mutation($issueId: ID!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }
    `,
    variables: { issueId: issueId ?? ISSUE_UUID, body: text },
  };
}

function issueWebhook(
  issueId: string,
  identifier: string,
  labelIds: string[],
  options?: { previousLabelIds?: string[] },
): object {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "linear-system", name: "Linear" },
    createdAt: new Date().toISOString(),
    data: {
      id: issueId,
      identifier,
      title: "AI-2534 test issue",
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: TEAM_ID, key: "AI" },
      labelIds,
      url: `https://linear.app/fancymatt/issue/${identifier}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
    },
    updatedFrom: { labelIds: options?.previousLabelIds ?? ["wf-lbl", "intake-lbl"] },
  };
}

function issueLabelWebhook(issueId: string, identifier: string): object {
  return {
    type: "IssueLabel",
    action: "remove",
    actor: { id: "linear-system", name: "Linear" },
    createdAt: new Date().toISOString(),
    data: {
      id: "wf-lbl",
      name: "wf:dev-impl",
      issue: {
        id: issueId,
        identifier,
        team: { id: TEAM_ID, key: "AI" },
        labelIds: [],
      },
      team: { id: TEAM_ID, key: "AI" },
    },
  };
}

async function postWebhook(
  app: ReturnType<typeof createApp>["app"],
  payload: object,
  deliveryId: string,
): Promise<void> {
  const res = await request(app)
    .post("/")
    .set("X-Linear-Delivery", deliveryId)
    .set("Content-Type", "application/json")
    .send(JSON.stringify(payload));
  expect(res.status).toBe(200);
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function labelUpdateCalls(calls: FetchCall[], issueId = ISSUE_UUID): FetchCall[] {
  return calls.filter(
    (c) => c.query.includes("ApplyAtomicTransition") && c.variables.issueId === issueId,
  );
}

function governanceRemovalCalls(
  calls: FetchCall[],
  issueId = ISSUE_UUID,
): FetchCall[] {
  return labelUpdateCalls(calls, issueId).filter((call) => {
    const labelIds = call.variables.labelIds as string[] | undefined;
    return (
      Array.isArray(labelIds) &&
      !labelIds.includes("wf-lbl") &&
      !labelIds.includes("intake-lbl")
    );
  });
}

function governanceRestampCalls(
  calls: FetchCall[],
  issueId = ISSUE_UUID,
): FetchCall[] {
  return labelUpdateCalls(calls, issueId).filter((call) => {
    const labelIds = call.variables.labelIds as string[] | undefined;
    return (
      Array.isArray(labelIds) &&
      (labelIds.includes("wf-lbl") || labelIds.includes("intake-lbl"))
    );
  });
}

async function waitForMutation(
  predicate: () => boolean,
  message: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (predicate()) return;
  }
  throw new Error(message);
}

function expectGovernanceRemovalForwarded(calls: FetchCall[], issueId = ISSUE_UUID): void {
  const removals = governanceRemovalCalls(calls, issueId);
  expect(removals.length).toBeGreaterThanOrEqual(1);
}

// ── Test setup ────────────────────────────────────────────────────────────

let appState: ReturnType<typeof createApp>;
let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2534-"));
  process.env.AGENTS_FILE = writeAgents(dir);
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
  process.env.ADMIN_SECRET = "admin-secret";
  delete process.env.LINEAR_WEBHOOK_SECRET;
  delete process.env.LINEAR_WEBHOOK_SECRETS;
  fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
  fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");

  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();

  originalFetch = globalThis.fetch;
  appState = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "events.db"),
    mutationAuditDbPath: path.join(dir, "audit.db"),
    enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
  });
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.mutationAuditStore.close();
  appState.enrolledTicketsStore.close();
  appState.dispatchDeliveryScheduler.stop();
  appState.watchdog.stop();
  appState.noActivityDetector.stop();
  appState.managingPoller.stop();
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC1: Demote/escape permanently exits — no re-apply within 5 minutes ─────

describe("AC1 — demote/escape permanently exits (no re-apply within 5m)", () => {
  it("AC1: demote persists through Issue + IssueLabel webhooks and bootstrap-reconciliation sweep — no wf/state re-stamp within 5m", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // Step 1: Enroll the ticket by simulating an auto-enrollment webhook.
    // Use real timers so the fire-and-forget autoEnrollByTeam resolves.
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []),
      "delivery-autoenroll",
    );
    await waitForMutation(
      () => governanceRestampCalls(mf.calls, ISSUE_UUID).length > 0,
      "auto-enroll did not stamp wf:dev-impl + state:intake on main issue",
    );

    // Step 2: Demote through the proxy
    const afterEnroll = mf.calls.length;
    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting ops-only ticket out of dev-impl."));

    expect(demoteRes.status).toBe(200);
    expect(demoteRes.body._workflowTransition).toMatchObject({
      status: "applied",
      code: "demoted-ad-hoc",
      to: "__ad_hoc__",
    });
    expectGovernanceRemovalForwarded(mf.calls);
    const afterDemote = mf.calls.length;

    // Step 3: Simulate the webhook echo — Linear fires an Issue event with
    // the label changes applied (no wf/state labels). This must NOT re-enroll.
    // Switch to fake timers for the time window checks.
    jest.useFakeTimers();
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, [], {
        previousLabelIds: ["wf-lbl", "intake-lbl"],
      }),
      "delivery-demote-issue-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), ISSUE_UUID).length).toBe(0);

    // Step 4: IssueLabel webhook echo (label removal fired separately)
    await postWebhook(
      appState.app,
      issueLabelWebhook(ISSUE_UUID, ISSUE_IDENTIFIER),
      "delivery-demote-label-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), ISSUE_UUID).length).toBe(0);

    // Step 5: Advance past 5-minute mark (the sweep interval is 5m)
    // and verify no re-stamp happened
    await jest.advanceTimersByTimeAsync(300_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), ISSUE_UUID).length).toBe(0);

    // Step 6: Send another webhook at 5m+ as if a new update happened on
    // the same issue — still must not re-stamp
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, [], {
        previousLabelIds: ["wf-lbl", "intake-lbl"],
      }),
      "delivery-demote-late-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), ISSUE_UUID).length).toBe(0);
  });

  it("AC1: escape persists through webhooks and sweep — no re-stamp within 5m", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // Step 1: Enroll by sending an auto-enroll webhook (real timers)
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []),
      "delivery-escape-autoenroll",
    );
    await waitForMutation(
      () => governanceRestampCalls(mf.calls, ISSUE_UUID).length > 0,
      "auto-enroll did not stamp for escape test",
    );

    // Step 2: Escape through the proxy
    const afterEnroll = mf.calls.length;
    const escapeRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send(commentCreateBody("Break-glass escape out of dev-impl."));

    expect(escapeRes.status).toBe(200);
    expect(escapeRes.body._workflowTransition).toMatchObject({
      status: "applied",
      code: "demoted-ad-hoc",
      to: "__ad_hoc__",
    });
    expectGovernanceRemovalForwarded(mf.calls);

    // Step 3: Switch to fake timers for the time-window checks
    jest.useFakeTimers();

    // Send echo webhooks and advance past 5m
    const afterEscape = mf.calls.length;
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, [], {
        previousLabelIds: ["wf-lbl", "intake-lbl"],
      }),
      "delivery-escape-issue-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterEscape), ISSUE_UUID).length).toBe(0);

    await postWebhook(
      appState.app,
      issueLabelWebhook(ISSUE_UUID, ISSUE_IDENTIFIER),
      "delivery-escape-label-echo",
    );
    await jest.advanceTimersByTimeAsync(300_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterEscape), ISSUE_UUID).length).toBe(0);

    // Late webhook still shouldn't re-stamp
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, [], {
        previousLabelIds: ["wf-lbl", "intake-lbl"],
      }),
      "delivery-escape-late-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterEscape), ISSUE_UUID).length).toBe(0);
  });
});

// ── AC2: Demoted/escaped ticket can be completed without re-entering dev-impl ─

describe("AC2 — demoted/escaped ticket can complete without re-entering dev-impl", () => {
  it("AC2: after demote, a subsequent complete transition does not trigger re-enrollment", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // Step 1: Enroll
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []),
      "delivery-complete-autoenroll",
    );
    await flushAsyncWork();

    // Step 2: Demote
    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting before completing."));
    expect(demoteRes.status).toBe(200);
    expectGovernanceRemovalForwarded(mf.calls);
    const afterDemote = mf.calls.length;

    // Step 3: Complete the ticket (close it)
    const completeRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send(commentCreateBody("Closing this completed ops-only ticket."));
    expect(completeRes.status).toBe(200);

    // Step 4: After the complete, no wf/state labels were re-stamped
    const allPostDemote = mf.calls.slice(afterDemote);
    // Clean: no governance label stamps anywhere after demote
    expect(governanceRestampCalls(allPostDemote, ISSUE_UUID).length).toBe(0);
  });

  it("AC2: after escape, a subsequent complete transition does not trigger re-enrollment", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // Step 1: Enroll
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []),
      "delivery-complete-escape-autoenroll",
    );
    await flushAsyncWork();

    // Step 2: Escape
    const escapeRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send(commentCreateBody("Escaping before completing."));
    expect(escapeRes.status).toBe(200);
    expectGovernanceRemovalForwarded(mf.calls);
    const afterEscape = mf.calls.length;

    // Step 3: Complete
    const completeRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send(commentCreateBody("Closing post-escape ticket."));
    expect(completeRes.status).toBe(200);

    // Step 4: No governance labels re-stamped
    expect(governanceRestampCalls(mf.calls.slice(afterEscape), ISSUE_UUID).length).toBe(0);
  });
});

// ── AC3: AI-2307-equivalent scenario ────────────────────────────────────────

describe("AC3 — AI-2307-equivalent scenario (ops-only, no pending impl work)", () => {
  it("AC3: exact AI-2307 flow — create → auto-enroll → demote → echo → complete, no re-stamp", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // Phase 1: A new AI-team Issue webhook arrives (credential cleanup ticket
    // entering dev-impl via auto-enroll).
    // Use real timers for the enrollment phase so async promise chains resolve.
    await postWebhook(
      appState.app,
      issueWebhook("issue-new-ai2307", "AI-2307", []),
      "delivery-ai2307-create",
    );

    // Wait for the fire-and-forget autoEnrollByTeam to complete
    await waitForMutation(
      () => governanceRestampCalls(mf.calls, "issue-new-ai2307").length > 0,
      "auto-enroll did not stamp wf:dev-impl + state:intake on new issue",
    );

    const autoEnrollStamps = governanceRestampCalls(mf.calls, "issue-new-ai2307");
    expect(autoEnrollStamps.length).toBeGreaterThanOrEqual(1);

    // Phase 2: Demote (ops-only ticket, no code changes needed)
    const afterEnroll = mf.calls.length;
    // Skip the proxy demote for this test — the AI-2307 scenario tests
    // that NO re-enrollment paths re-stamp labels after demote/escape.
    // The proxy demote for the wrong issueId would fail, so we simulate
    // the demote by directly calling the enrolledTicketsStore.
    // Instead, this test verifies that after enrollment, a side-entity demote
    // on the same issue keeps the labels off.
    // Actually, let's use the correct issue ID for proxy demote:
    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Credential cleanup — no code changes, demoting from dev-impl.", "issue-new-ai2307"));
    expect(demoteRes.status).toBe(200);
    expectGovernanceRemovalForwarded(mf.calls, "issue-new-ai2307");
    const afterDemote = mf.calls.length;

    // Phase 3: Issue echo webhook — the label removal fires a Linear webhook.
    // Switch to fake timers so we can verify no re-stamp within a long window.
    jest.useFakeTimers();
    await postWebhook(
      appState.app,
      issueWebhook("issue-new-ai2307", "AI-2307", [], {
        previousLabelIds: ["wf-lbl", "intake-lbl"],
      }),
      "delivery-ai2307-demote-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), "issue-new-ai2307").length).toBe(0);

    // Phase 4: IssueLabel webhook echo
    await postWebhook(
      appState.app,
      issueLabelWebhook("issue-new-ai2307", "AI-2307"),
      "delivery-ai2307-label-echo",
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), "issue-new-ai2307").length).toBe(0);

    // Phase 5: Complete (close the ticket)
    const completeRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "complete")
      .send(commentCreateBody("No implementation work needed — closing."));
    expect(completeRes.status).toBe(200);

    // Phase 6: Advance past 5m and verify no re-stamps
    await jest.advanceTimersByTimeAsync(300_000);
    await flushAsyncWork();
    expect(governanceRestampCalls(mf.calls.slice(afterDemote), "issue-new-ai2307").length).toBe(0);
  });

  it("AC3: fresh issue after a demoted issue is still auto-enrolled (suppression is scoped, not global)", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // Step 1: Enroll and demote the main issue
    await postWebhook(
      appState.app,
      issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []),
      "delivery-scope-autoenroll",
    );
    await waitForMutation(
      () => governanceRestampCalls(mf.calls, ISSUE_UUID).length > 0,
      "auto-enroll did not complete for main issue",
    );

    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting one issue."));
    expect(demoteRes.status).toBe(200);
    expectGovernanceRemovalForwarded(mf.calls);

    // Step 2: A completely new, unrelated AI-team issue should still
    // auto-enroll (suppression is per-ticket, not global)
    await postWebhook(
      appState.app,
      issueWebhook("issue-fresh-ai2534", "AI-2534-FRESH", []),
      "delivery-fresh-issue",
    );
    await waitForMutation(
      () => governanceRestampCalls(mf.calls, "issue-fresh-ai2534").length > 0,
      "fresh AI-team issue was not auto-enrolled after a demote of a different issue",
    );

    const freshStamps = governanceRestampCalls(mf.calls, "issue-fresh-ai2534");
    expect(freshStamps.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AC4: Pre-entry guard activation is observable ──────────────────────────

describe("AC4 — pre-entry guard activation observable", () => {
  it("AC4: /health exposes a pre-entry guard liveness field confirming registration and activity", async () => {
    // If the implementer chose fix option 1 (pre-entry guard), the guard's
    // registration and activity must be observable via /health or another
    // live endpoint.
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;

    // The field name is implementation-dependent. Look for any key matching
    // "dev-impl guard", "pre-entry guard", "demote-liveness", or similar.
    const guardEntry = Object.entries(body).find(([key]) => {
      return /guard|liveness|demote.?live|auto.?enroll.*suppress/i.test(key);
    });

    // AC4 is contingent on fix option 1. If no guard field exists (the
    // implementer chose a different fix approach), skip this check. But if
    // one is present, confirm it shows the guard is active.
    if (guardEntry) {
      const [, value] = guardEntry;
      if (typeof value === "object" && value !== null) {
        const typed = value as Record<string, unknown>;
        // Must show active/registered status
        expect(
          Object.values(typed).some(
            (v) => v === true || v === "active" || v === "registered",
          ),
        ).toBe(true);
      }
    }
  });
});
