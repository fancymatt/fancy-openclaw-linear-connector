/**
 * AI-2036 AC1.2 — end-to-end through the proxy's HTTP layer.
 *
 * The unit tests drive applyStateTransition directly. This one drives the route
 * the reviewer's CLI actually hits, POST /proxy/graphql, sending exactly the
 * headers the deployed `fancy-openclaw-linear-skill-cli` sends — which is to say
 * neither X-Openclaw-Feedback-Category nor X-Openclaw-From-Body. That header set
 * is the whole bug: the proxy only built its `feedback` payload when the category
 * header was present, so `options.feedback` was always undefined and the
 * observation write in workflow-gate never ran.
 *
 * These assertions fail against the pre-AI-2036 proxy.
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
import { recordImplementer, clearImplementerStore } from "./implementer-store.js";
import { resetObservationWritePath } from "./store/observation-write-path.js";
import { createApp } from "./index.js";

const ISSUE_UUID = "issue-uuid-2036";
const ISSUE_IDENTIFIER = "AI-2036";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
roles:
  - id: dev
    requires: []
  - id: code-review
    requires: []
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: cra
    container: code-review
    fills_roles: [code-review]
`;

const WORKFLOW_YAML = `
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
      - command: request-changes
        to: implementation
        requires_comment: true
        assign:
          mode: required
          default: prior-implementer
        feedback:
          required: true
          category_enum:
            - missing-tests
            - style
            - scope-creep
            - correctness
            - ac-mismatch
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

/** Serves both the proxy's own label lookup and workflow-gate's transition queries. */
function makeFetch(): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch: ${String(url)}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const query = (JSON.parse(bodyText) as { query?: string }).query ?? "";

    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

    if (query.includes("IssueContext") || query.includes("IssueLabels")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "user-cra" },
          },
        },
      });
    }
    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            team: { id: "team-uuid" },
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "cr-lbl", name: "state:code-review" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: [{ id: "impl-lbl", name: "state:implementation" }] } } } });
    }
    if (query.includes("TeamStates")) {
      return json({ data: { team: { states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted" }] } } } });
    }
    if (query.includes("issueLabelCreate")) {
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-lbl" } } } });
    }
    return json({ data: { issueUpdate: { success: true, issue: { id: ISSUE_UUID } } }, });
  }) as unknown as typeof globalThis.fetch;
}

/** The comment mutation the CLI forwards for `linear request-changes --comment-file`. */
function requestChangesBody(comment: string) {
  return {
    query: `mutation commentCreate($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }`,
    variables: { issueId: ISSUE_UUID, body: comment },
  };
}

describe("AI-2036 AC1.2 — proxy end-to-end: request-changes with the real CLI's headers", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-proxy-"));

    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "igor", linearUserId: "user-igor", openclawAgent: "igor", accessToken: "t1", host: "local" },
          { name: "cra", linearUserId: "user-cra", openclawAgent: "cra", accessToken: "t2", host: "local" },
        ],
      }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;

    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    process.env.IMPLEMENTER_STORE_PATH = path.join(dir, "implementer-store.json");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetObservationWritePath();
    clearImplementerStore();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    // The implementer store is keyed by the Linear issue UUID.
    await recordImplementer(ISSUE_UUID, "igor", "dev-impl");

    originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.observationStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes one observation row, with no feedback headers on the request at all", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "cra")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      // deliberately NO X-Openclaw-Feedback-Category, NO X-Openclaw-From-Body
      .send(requestChangesBody("Tests are missing for the sad path. Please re-submit."));

    expect(res.status).toBe(200);

    const rows = appState.observationStore.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticket: ISSUE_IDENTIFIER, // the human identifier, not the internal UUID
      workflow: "dev-impl",
      step: "code-review",
      reasonCode: "unclassified", // reviewer named no category
      fromBody: "igor", // resolved from the implementer store
      reviewerBody: "cra",
    });
    expect(rows[0].freeText).toContain("sad path");
    expect(rows[0].wakeId).toBeNull();
  });

  it("picks up a Category: marker written in the review comment", async () => {
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "cra")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .send(requestChangesBody("The retry loop is off by one.\n\nCategory: correctness\n"));

    const rows = appState.observationStore.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0].reasonCode).toBe("correctness");
  });

  it("still honours the header when a future CLI sends one", async () => {
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "cra")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Feedback-Category", "missing-tests")
      .set("X-Openclaw-From-Body", "igor")
      .send(requestChangesBody("no tests"));

    const rows = appState.observationStore.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reasonCode: "missing-tests", fromBody: "igor" });
  });

  it("emits an observation-recorded operational event for the transition", async () => {
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "cra")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .send(requestChangesBody("please fix"));

    const events = appState.operationalEventStore.query({ outcome: "observation-recorded", limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe(ISSUE_IDENTIFIER);
  });

  it("the query API can find the row by its ticket identifier", async () => {
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "cra")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .send(requestChangesBody("Category: style\n\nnaming is inconsistent"));

    // The clustering queries and the admin API both filter on the human ticket id.
    expect(appState.observationStore.query({ ticket: ISSUE_IDENTIFIER })).toHaveLength(1);
    expect(appState.observationStore.query({ ticket: ISSUE_UUID })).toHaveLength(0);
    expect(appState.observationStore.counts({ workflow: "dev-impl", step: "code-review" })).toEqual([
      { workflow: "dev-impl", step: "code-review", reasonCode: "style", count: 1 },
    ]);
  });
});
