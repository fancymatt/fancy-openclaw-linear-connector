import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: deployment
    requires: [deploy:execute]
  - id: sprint-owner
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

const SPRINT_WORKFLOW_YAML = `
id: sprint
version: 1
archetype: feature-initiative
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
        to: ux-shaping
  - id: ux-shaping
    owner_role: ux-researcher
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: spawning
  - id: spawning
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: managing
  - id: managing
    owner_role: sprint-owner
    kind: normal
    native_state: managing
    barrier: true
    transitions:
      - command: complete
        to: validating
  - id: validating
    owner_role: sprint-owner
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
      - command: request-rework
        to: spawning
  - id: done
    kind: terminal
    native_state: done
    transitions: []
  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

let dir: string;
let appState: ReturnType<typeof createApp>;
let originalFetch: typeof globalThis.fetch;
let fetchCalls: FetchCall[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-27-rewind-"));

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "user-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "hanzo", linearUserId: "user-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const defFile = path.join(dir, "sprint.yaml");
  fs.writeFileSync(defFile, SPRINT_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = defFile;
  delete process.env.WORKFLOW_DEFS_DIR;

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
  fetchCalls = [];
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
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTS_FILE;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_DEFS_DIR;
});

function makeRewindFetch(opts: { delegateId?: string | null } = {}): typeof globalThis.fetch {
  const delegateId = opts.delegateId === undefined ? "user-hanzo" : opts.delegateId;
  return (async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return originalFetch(url, init);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    fetchCalls.push({ query, variables });

    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: "issue-internal-uuid",
            identifier: "LIF-2",
            team: { id: "team-uuid" },
            labels: {
              nodes: [
                { id: "wf-sprint-label", name: "wf:sprint" },
                { id: "state-validating-label", name: "state:validating" },
                { id: "ordinary-label", name: "customer:lif" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamStateLabels")) {
      return json({
        data: {
          issue: {
            team: {
              labels: {
                nodes: [
                  { id: "state-validating-label", name: "state:validating" },
                  { id: "state-managing-label", name: "state:managing" },
                  { id: "state-escape-label", name: "state:escape" },
                ],
              },
            },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-sprint-label", name: "wf:sprint" },
                { id: "state-validating-label", name: "state:validating" },
                { id: "state-managing-label", name: "state:managing" },
                { id: "state-escape-label", name: "state:escape" },
                { id: "ordinary-label", name: "customer:lif" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo-state", name: "Todo", type: "unstarted" },
                { id: "native-doing-state", name: "Doing", type: "started" },
                { id: "native-thinking-state", name: "Thinking", type: "started" },
                { id: "native-managing-state", name: "Managing", type: "started" },
                { id: "native-done-state", name: "Done", type: "completed" },
                { id: "native-invalid-state", name: "Invalid", type: "canceled" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("VerifyTransitionWrite")) {
      const lastWrite = [...fetchCalls].reverse().find((c) => c.query.includes("issueUpdate"));
      const labelIds = (lastWrite?.variables.labelIds ?? []) as string[];
      return json({
        data: {
          issue: {
            labels: { nodes: labelIds.map((id) => ({ name: labelNameForId(id) })) },
            delegate: delegateId ? { id: delegateId } : null,
            state: { id: lastWrite?.variables.stateId ?? null },
          },
        },
      });
    }

    if ((query.includes("IssueContext") || query.includes("IssueLabels") || query.includes("delegate")) && !query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:sprint" }, { name: "state:validating" }] },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }

    if (query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true, issue: { id: "issue-internal-uuid" } } } });
    }

    return json({ data: {} });
  }) as typeof globalThis.fetch;
}

function json(payload: object): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function labelNameForId(id: string): string {
  const map: Record<string, string> = {
    "wf-sprint-label": "wf:sprint",
    "state-validating-label": "state:validating",
    "state-managing-label": "state:managing",
    "state-escape-label": "state:escape",
    "ordinary-label": "customer:lif",
  };
  return map[id] ?? id;
}

function rewindRequest(agent: "astrid" | "hanzo", target?: string) {
  let req = request(appState.app)
    .post("/proxy/graphql")
    .set("Authorization", `Bearer tok-${agent}`)
    .set("X-Openclaw-Agent", agent)
    .set("X-Openclaw-Linear-Intent", "rewind");
  if (target !== undefined) {
    req = req.set("X-Openclaw-Rewind-Target", target);
  }
  return req.send({
    query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
    variables: { id: "LIF-2" },
  });
}

function directLabelRepairRequest() {
  return request(appState.app)
    .post("/proxy/graphql")
    .set("Authorization", "Bearer tok-astrid")
    .set("X-Openclaw-Agent", "astrid")
    .send({
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "LIF-2", input: { labelIds: ["wf-sprint-label", "state-managing-label", "ordinary-label"] } },
    });
}

function issueUpdateCalls() {
  return fetchCalls.filter((c) => c.query.includes("issueUpdate"));
}

function commentCreateCalls() {
  return fetchCalls.filter((c) => c.query.includes("commentCreate"));
}

function rewindWrite() {
  return issueUpdateCalls().find((c) => {
    const labels = c.variables.labelIds as string[] | undefined;
    return labels?.includes("state-managing-label") || c.variables.stateId === "native-managing-state";
  });
}

describe("INF-27 AC3: steward break-glass rewind verb", () => {
  it("AC3: a steward with workflow:break-glass can rewind a governed ticket to a named legal state", async () => {
    globalThis.fetch = makeRewindFetch();

    const res = await rewindRequest("astrid", "managing");

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("AC3: rewind writes the state:* label and native Linear state in one atomic mutation", async () => {
    globalThis.fetch = makeRewindFetch();

    await rewindRequest("astrid", "managing");

    const write = rewindWrite();
    expect(write).toBeDefined();
    expect(write?.variables.labelIds).toContain("state-managing-label");
    expect(write?.variables.labelIds).not.toContain("state-validating-label");
    expect(write?.variables.stateId).toBe("native-managing-state");
  });

  it("AC3: rewind posts a comment naming the from-state, to-state, and caller", async () => {
    globalThis.fetch = makeRewindFetch();

    await rewindRequest("astrid", "managing");

    const comment = commentCreateCalls()[0];
    expect(comment).toBeDefined();
    const body = JSON.stringify(comment?.variables ?? {});
    expect(body).toMatch(/validating/);
    expect(body).toMatch(/managing/);
    expect(body).toMatch(/astrid/);
  });

  it("AC3: rewind is audit-logged as an operational event", async () => {
    globalThis.fetch = makeRewindFetch();

    await rewindRequest("astrid", "managing");

    const events = appState.operationalEventStore.query({ limit: 50 });
    const event = events.find((e) => e.agent === "astrid" && e.key === "LIF-2" && JSON.stringify(e.detail).match(/managing/));
    expect(event).toBeDefined();
    expect(event?.outcome).toEqual(expect.any(String));
    expect(event?.outcome).not.toBe("");
    expect(event?.type).toEqual(expect.any(String));
    expect(event?.type).not.toBe("");
  });

  it("AC3: a caller without workflow:break-glass is rejected and writes nothing", async () => {
    globalThis.fetch = makeRewindFetch();

    const res = await rewindRequest("hanzo", "managing");

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    const msg = res.body.errors[0].message as string;
    expect(msg).toMatch(/hanzo/);
    expect(msg).toMatch(/workflow:break-glass/);
    expect(issueUpdateCalls()).toHaveLength(0);
    expect(commentCreateCalls()).toHaveLength(0);
  });

  it("AC3: workflow:break-glass alone is sufficient even when caller is not the current delegate or state owner", async () => {
    globalThis.fetch = makeRewindFetch({ delegateId: "user-hanzo" });

    const res = await rewindRequest("astrid", "managing");

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("AC3: rejects unknown, missing, or other-workflow rewind targets without writing", async () => {
    for (const target of ["not-a-real-state", undefined, "ac-validate"] as Array<string | undefined>) {
      fetchCalls = [];
      globalThis.fetch = makeRewindFetch();

      const res = await rewindRequest("astrid", target);

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(target ? new RegExp(target) : /target|missing/i);
      expect(issueUpdateCalls()).toHaveLength(0);
      expect(commentCreateCalls()).toHaveLength(0);
    }
  });

  it("AC3: premise then red — direct label repair is blocked, but rewind can cross the same guard", async () => {
    globalThis.fetch = makeRewindFetch();

    const direct = await directLabelRepairRequest();
    expect(direct.status).toBe(200);
    expect(direct.body.errors?.[0]?.message).toMatch(/Direct .*changes are blocked/);

    fetchCalls = [];
    globalThis.fetch = makeRewindFetch();
    const rewind = await rewindRequest("astrid", "managing");
    expect(rewind.status).toBe(200);
    expect(rewind.body.errors).toBeUndefined();
  });

  it("AC3: rewind is not terminal escape; it leaves the ticket at managing/native Managing", async () => {
    globalThis.fetch = makeRewindFetch();

    await rewindRequest("astrid", "managing");

    const write = rewindWrite();
    expect(write).toBeDefined();
    expect(write?.variables.stateId).toBe("native-managing-state");
    expect(write?.variables.stateId).not.toBe("native-invalid-state");
    expect(write?.variables.labelIds).not.toContain("state-escape-label");
  });
});
