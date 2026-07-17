/**
 * AI-2542: autoEnrollByTeam must not re-enroll tickets intentionally demoted
 * or escaped out of workflow governance.
 *
 * FAILING integration suite (TDD, write-tests state). These tests drive the
 * production entry-point app factory and real webhook/proxy paths, then grade
 * only observable Linear API mutations and /health output. They intentionally
 * do not import or name any future suppression API.
 *
 * AC coverage map:
 *   AC1 — "`demote <ID>` and `escape <ID>` on an AI-team ticket must persist:
 *          after the governed transition removes `wf:*` + `state:*` labels,
 *          no `wf:*` or `state:*` labels are re-stamped within at least a
 *          5-second window."
 *          → describe("AC1+AC3 …") tests `demote` and `escape` through
 *            /proxy/graphql, confirms the removal mutation, posts the follow-up
 *            webhook, advances fake time past 2s and 5s, and asserts no
 *            re-stamp mutation for that same issue.
 *   AC2 — "`autoEnrollByTeam` continues to auto-enroll genuinely new AI-team
 *          issues."
 *          → describe("AC2 …") posts fresh Issue webhooks through createApp()
 *            and asserts `wf:dev-impl` + `state:intake` are forwarded, including
 *            an unrelated later issue after a demote so suppression cannot be
 *            implemented as a global disable/permanent blacklist.
 *   AC3 — "The suppression mechanism handles the webhook-race: a Linear
 *          `Issue`/`IssueLabel` webhook firing within 1-3s of a demote/escape
 *          does not trigger re-enrollment."
 *          → describe("AC1+AC3 …") covers the 2s race point and includes both
 *            Issue and IssueLabel webhook payloads for the demoted issue.
 *   AC4 — "No regression on AI-2532 behavior: the `issueUpdateLabels === false`
 *          fail-loud guard is preserved."
 *          → describe("AC4 …") forces the demote label mutation to return false
 *            and asserts failed/atomic-mutation-failed plus the B2 apply FAILED
 *            log line.
 *   AC5 — "The `autoEnrollByTeam` webhook handler is registered at server
 *          bootstrap ... proven by an integration test that boots the entry
 *          point and asserts registration."
 *          → describe("AC5 …") boots createApp(), posts a production-path Issue
 *            webhook to `/`, and observes the auto-enroll label stamp.
 *   AC6 — "Liveness is observable at ac-validate without waiting for a webhook
 *          trigger."
 *          → describe("AC6 …") asserts GET /health exposes an auto-enroll
 *            liveness field over HTTP. The implementer may choose the exact
 *            field name, but some /health field must confirm active/registered
 *            autoEnrollByTeam wiring plus suppression status.
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

const ISSUE_UUID = "issue-ai-2542-internal-uuid";
const ISSUE_IDENTIFIER = "AI-2542";
const TEAM_ID = "team-ai";

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

interface MockFetchOptions {
  failLabelUpdateForIssue?: string;
}

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

function makeMockFetch(options: MockFetchOptions = {}): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const labelNamesById = new Map<string, string>([
    ["wf-lbl", "wf:dev-impl"],
    ["intake-lbl", "state:intake"],
    ["implementation-lbl", "state:implementation"],
  ]);
  const labelsByIssue = new Map<string, Array<{ id: string; name: string }>>();
  const labelsForIssue = (issueId: string): Array<{ id: string; name: string }> => {
    const existing = labelsByIssue.get(issueId);
    if (existing) return existing;
    const initial = issueId.includes("new") || issueId.includes("later") || issueId.includes("bootstrap")
      ? [{ id: `${issueId}-other-lbl`, name: "component:api" }]
      : [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "intake-lbl", name: "state:intake" },
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

    if (query.includes("IssueContext")) {
      return jsonResponse({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "u-astrid" },
            assignee: { id: "u-astrid" },
          },
        },
      });
    }

    if (query.includes("IssueWithLabels")) {
      const id = String(variables.id ?? ISSUE_UUID);
      return jsonResponse({
        data: {
          issue: {
            id,
            identifier: id.includes("later") ? "AI-2542-LATER" : id.includes("new") ? "AI-2542-NEW" : ISSUE_IDENTIFIER,
            team: { id: TEAM_ID },
            labels: { nodes: labelsForIssue(id) },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "intake-lbl", name: "state:intake" },
                { id: "implementation-lbl", name: "state:implementation" },
              ],
            },
          },
        },
      });
    }

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

    if (query.includes("IssueBranchAndPR")) {
      return jsonResponse({ data: { issue: { branch: null, pullRequests: { nodes: [] } } } });
    }

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

    if (query.includes("commentCreate")) {
      return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    if (query.includes("issueLabelCreate")) {
      return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "created-lbl-id" } } } });
    }

    if (query.includes("ApplyAtomicTransition")) {
      if (options.failLabelUpdateForIssue && variables.issueId === options.failLabelUpdateForIssue) {
        return jsonResponse({ data: { issueUpdate: { success: false } } });
      }
      setIssueLabels(String(variables.issueId), (variables.labelIds as string[] | undefined) ?? []);
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    return jsonResponse({ errors: [{ message: `unexpected query: ${query.slice(0, 120)}` }] }, 400);
  };

  return { fetch: mockFetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

function issueWebhook(issueId: string, identifier: string, labelIds: string[]): object {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "linear-system", name: "Linear" },
    createdAt: new Date().toISOString(),
    data: {
      id: issueId,
      identifier,
      title: "AI-2542 test issue",
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: TEAM_ID, key: "AI" },
      labelIds,
      url: `https://linear.app/fancymatt/issue/${identifier}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
    },
    updatedFrom: { labelIds: ["wf-lbl", "intake-lbl"] },
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

async function postWebhook(app: ReturnType<typeof createApp>["app"], payload: object, deliveryId: string): Promise<void> {
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

async function waitForMutation(
  predicate: () => boolean,
  message: string,
  options: { timeoutMs?: number; advanceFakeTimers?: boolean } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await flushAsyncWork();
    if (predicate()) return;
    if (options.advanceFakeTimers) {
      await jest.advanceTimersByTimeAsync(10);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(message);
}

function labelUpdateCalls(calls: FetchCall[], issueId = ISSUE_UUID): FetchCall[] {
  return calls.filter(
    (c) => c.query.includes("ApplyAtomicTransition") && c.variables.issueId === issueId,
  );
}

function restampCallsAfter(calls: FetchCall[], startIndex: number, issueId = ISSUE_UUID): FetchCall[] {
  return labelUpdateCalls(calls.slice(startIndex), issueId).filter((call) => {
    const labelIds = call.variables.labelIds as string[] | undefined;
    return Array.isArray(labelIds) && (labelIds.includes("wf-lbl") || labelIds.includes("intake-lbl"));
  });
}

function expectGovernanceRemovalForwarded(calls: FetchCall[], issueId = ISSUE_UUID): void {
  const removals = labelUpdateCalls(calls, issueId).filter((call) => {
    const labelIds = call.variables.labelIds as string[] | undefined;
    return Array.isArray(labelIds) && !labelIds.includes("wf-lbl") && !labelIds.includes("intake-lbl");
  });
  expect(removals.length).toBeGreaterThanOrEqual(1);
}

let appState: ReturnType<typeof createApp>;
let dir: string;
let originalFetch: typeof globalThis.fetch;
let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2542-"));
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
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
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
  consoleErrorSpy.mockRestore();
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
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AC1+AC3 — governed demote/escape suppress webhook-race auto-enrollment", () => {
  it("AC1 AC3: demote persists through an Issue webhook race and no wf/state labels are re-stamped within 5s", async () => {
    jest.useFakeTimers();
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting this ticket out of dev-impl."));

    expect(demoteRes.status).toBe(200);
    expect(demoteRes.body._workflowTransition).toMatchObject({
      status: "applied",
      code: "demoted-ad-hoc",
      to: "__ad_hoc__",
    });
    expectGovernanceRemovalForwarded(mf.calls);

    const afterDemote = mf.calls.length;
    await postWebhook(appState.app, issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []), "delivery-demote-issue");
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(restampCallsAfter(mf.calls, afterDemote)).toEqual([]);

    await jest.advanceTimersByTimeAsync(3_100);
    await flushAsyncWork();
    expect(restampCallsAfter(mf.calls, afterDemote)).toEqual([]);
  });

  it("AC1 AC3: escape persists through an Issue webhook race and no wf/state labels are re-stamped within 5s", async () => {
    jest.useFakeTimers();
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const escapeRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send(commentCreateBody("Break-glass escape out of governed workflow."));

    expect(escapeRes.status).toBe(200);
    expect(escapeRes.body._workflowTransition).toMatchObject({
      status: "applied",
      code: "demoted-ad-hoc",
      to: "__ad_hoc__",
    });
    expectGovernanceRemovalForwarded(mf.calls);

    const afterEscape = mf.calls.length;
    await postWebhook(appState.app, issueWebhook(ISSUE_UUID, ISSUE_IDENTIFIER, []), "delivery-escape-issue");
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(restampCallsAfter(mf.calls, afterEscape)).toEqual([]);

    await jest.advanceTimersByTimeAsync(3_100);
    await flushAsyncWork();
    expect(restampCallsAfter(mf.calls, afterEscape)).toEqual([]);
  });

  it("AC3: an IssueLabel webhook for the same demoted issue does not re-stamp wf/state labels during the 1-3s race", async () => {
    jest.useFakeTimers();
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting before label webhook replay."));

    expect(demoteRes.status).toBe(200);
    expectGovernanceRemovalForwarded(mf.calls);

    const afterDemote = mf.calls.length;
    await postWebhook(appState.app, issueLabelWebhook(ISSUE_UUID, ISSUE_IDENTIFIER), "delivery-demote-label");
    await jest.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(restampCallsAfter(mf.calls, afterDemote)).toEqual([]);
  });
});

describe("AC2 — genuinely new AI-team issues still auto-enroll", () => {
  it("AC2 AC5: a new AI-team Issue webhook through createApp() stamps wf:dev-impl + state:intake", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    await postWebhook(appState.app, issueWebhook("issue-new-ai-2542", "AI-2542-NEW", []), "delivery-new-issue");
    await waitForMutation(
      () => labelUpdateCalls(mf.calls, "issue-new-ai-2542").length > 0,
      "new AI-team issue was not auto-enrolled through the webhook path",
    );

    const stamps = labelUpdateCalls(mf.calls, "issue-new-ai-2542").filter((call) => {
      const labelIds = call.variables.labelIds as string[] | undefined;
      return Array.isArray(labelIds) && labelIds.includes("wf-lbl") && labelIds.includes("intake-lbl");
    });
    expect(stamps.length).toBeGreaterThanOrEqual(1);
  });

  it("AC2: suppression is scoped to the demoted issue and does not blacklist an unrelated later AI issue", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const demoteRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting one issue must not suppress unrelated issues."));
    expect(demoteRes.status).toBe(200);
    expectGovernanceRemovalForwarded(mf.calls);

    await postWebhook(appState.app, issueWebhook("issue-later-ai-2542", "AI-2542-LATER", []), "delivery-later-issue");
    await waitForMutation(
      () => labelUpdateCalls(mf.calls, "issue-later-ai-2542").length > 0,
      "later unrelated AI-team issue was not auto-enrolled through the webhook path",
    );

    const laterStamps = labelUpdateCalls(mf.calls, "issue-later-ai-2542").filter((call) => {
      const labelIds = call.variables.labelIds as string[] | undefined;
      return Array.isArray(labelIds) && labelIds.includes("wf-lbl") && labelIds.includes("intake-lbl");
    });
    expect(laterStamps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("AC4 — AI-2532 issueUpdateLabels false guard remains fail-loud", () => {
  it("AC4: demote surfaces atomic-mutation-failed and logs B2 apply FAILED when label removal returns false", async () => {
    const mf = makeMockFetch({ failLabelUpdateForIssue: ISSUE_UUID });
    globalThis.fetch = mf.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send(commentCreateBody("Demoting with a failing label mutation."));

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "failed",
      code: "atomic-mutation-failed",
      to: "__ad_hoc__",
    });
    const logs = consoleErrorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logs).toContain("B2 apply: FAILED");
    expect(logs).toContain("demoted to __ad_hoc__ but label mutation returned false");
  });
});

describe("AC5 — production bootstrap registers the autoEnrollByTeam webhook handler", () => {
  it("AC5: createApp() production webhook route reaches autoEnrollByTeam and forwards the enrollment mutation", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    await postWebhook(appState.app, issueWebhook("issue-new-bootstrap-ai-2542", "AI-2542-BOOT", []), "delivery-bootstrap-issue");
    await waitForMutation(
      () => labelUpdateCalls(mf.calls, "issue-new-bootstrap-ai-2542").length > 0,
      "bootstrap webhook path did not reach autoEnrollByTeam",
    );

    const stamps = labelUpdateCalls(mf.calls, "issue-new-bootstrap-ai-2542").filter((call) => {
      const labelIds = call.variables.labelIds as string[] | undefined;
      return Array.isArray(labelIds) && labelIds.includes("wf-lbl") && labelIds.includes("intake-lbl");
    });
    expect(stamps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("AC6 — auto-enroll liveness is observable from /health", () => {
  it("AC6: /health exposes an auto-enroll liveness field with active registration and suppression status", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    // The implementer may choose the exact key, but some /health field must
    // confirm autoEnrollByTeam is subscribed/active and expose suppression
    // liveness without waiting for a webhook trigger.
    const autoEnrollEntry = Object.entries(res.body as Record<string, unknown>).find(([key, value]) => {
      if (!/auto.?enroll/i.test(key)) return false;
      return Boolean(value && typeof value === "object");
    });

    expect(autoEnrollEntry).toBeDefined();
    const [, value] = autoEnrollEntry as [string, Record<string, unknown>];
    expect(value).toEqual(expect.objectContaining({ active: true }));
    expect(Object.keys(value).some((key) => /suppress|demote|escape/i.test(key))).toBe(true);
  });
});
