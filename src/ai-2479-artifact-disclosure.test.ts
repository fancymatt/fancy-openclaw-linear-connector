import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { createApp } from "./index.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const POLICY_YAML = `
capabilities:
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]

bodies:
  - id: aidev
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: implementation
states:
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: handoff-work
        to: implementation
        requires_comment: true
`;

const ISSUE_ID = "issue-uuid";
const MARKER_IGOR = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"b777e17"} -->';
const MARKER_IGOR_LONG = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"b777e171234567890abcdef"} -->';
const MARKER_CALLER = '<!-- artifact-disclosure: {"branch":"feature/own","sha":"abc1234"} -->';
/** Igor's SECOND, newer declaration — e.g. after a force-push/rebase. */
const MARKER_IGOR_NEWER = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"dd11cc2"} -->';

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "aidev", linearUserId: "u-aidev", openclawAgent: "aidev", accessToken: "tok-aidev", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function issueContext(): object {
  return {
    data: {
      issue: {
        identifier: "AI-2479",
        labels: { nodes: [] },
        delegate: { id: "u-aidev" },
      },
    },
  };
}

type TestComment = { body: string; userId: string };

function makeFetch(opts: { comments?: TestComment[]; throwOnComments?: boolean } = {}): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const json = (payload: object) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";
    calls.push({ query: q, variables: parsed.variables ?? {} });

    if (q.includes("IssueContext")) return json(issueContext());
    if (q.includes("ArtifactDisclosureComments")) {
      if (opts.throwOnComments) throw new Error("comment fetch exploded");
      return json({
        data: {
          issue: {
            comments: {
              nodes: (opts.comments ?? []).map((c) => ({
                body: c.body,
                user: { id: c.userId },
              })),
            },
          },
        },
      });
    }
    return json({ data: { issueUpdate: { success: true } } });
  };

  return { fetch: mockFetch, calls };
}

function handoffBody(delegateId = "u-igor") {
  return {
    operationName: "HandoffDelegate",
    query: `mutation HandoffDelegate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: ISSUE_ID, input: { delegateId } },
  };
}

function stateWriteBody() {
  return {
    operationName: "StateWrite",
    query: `mutation StateWrite($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: ISSUE_ID, input: { stateId: "state-doing" } },
  };
}

describe("proxy — AI-2479 artifact disclosure guard", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let oldLinearOauthToken: string | undefined;
  let oldLinearApiKey: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2479-test-"));
    oldLinearOauthToken = process.env.LINEAR_OAUTH_TOKEN;
    oldLinearApiKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

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
    if (oldLinearOauthToken === undefined) delete process.env.LINEAR_OAUTH_TOKEN;
    else process.env.LINEAR_OAUTH_TOKEN = oldLinearOauthToken;
    if (oldLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = oldLinearApiKey;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.dispatchDeliveryScheduler.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function send(body: object, headers: Record<string, string> = {}) {
    let r = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-aidev")
      .set("X-Openclaw-Agent", "aidev");
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  }

  const forwardedMutations = (calls: Array<{ query: string }>) =>
    calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext")).length;

  // The comment fetch asks Linear for comments NEWEST FIRST
  // (`comments(first: 50, orderBy: createdAt)` returns descending — live-probed
  // 2026-07-16, and the CLI pairs the same query with a .reverse() to render
  // oldest-first). The guard takes the first marker it finds, so that ordering is
  // load-bearing: if it were ascending, the guard would silently compare against
  // the OLDEST declaration and refuse a truthful handoff.
  //
  // These two tests are the only thing standing in front of that. Every other
  // fixture has a single other-user marker, so ordering cannot discriminate and
  // reversing the scan passes the whole rest of the suite.
  describe("selects the most recent declaration, not the oldest", () => {
    // Mock order mirrors the API contract: index 0 is newest.
    const reDeclared = [
      { body: MARKER_IGOR_NEWER, userId: "u-igor" },
      { body: MARKER_IGOR, userId: "u-igor" },
    ];

    it("allows a declaration matching Igor's newest artifact", async () => {
      const mf = makeFetch({ comments: reDeclared });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@dd11cc2" });

      expect(res.body.errors).toBeUndefined();
      expect(forwardedMutations(mf.calls)).toBe(1);
    });

    it("blocks a declaration matching only Igor's superseded artifact", async () => {
      const mf = makeFetch({ comments: reDeclared });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@b777e17" });

      expect(res.body.errors?.[0]?.message).toMatch(/blocked/);
      expect(res.body.errors?.[0]?.message).toContain("dd11cc2");
      expect(forwardedMutations(mf.calls)).toBe(0);
    });
  });

  it("AI-2476 shape: prior marker by Igor, different declaration, no reason blocks and does not forward", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@911ef85" });

    expect(res.status).toBe(200);
    expect(res.body.errors?.[0]?.message).toMatch(/blocked/);
    expect(forwardedMutations(mf.calls)).toBe(0);
  });

  it("declared substitution reason allows a different artifact and forwards", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), {
      "X-Openclaw-Code-Artifact": "feature/x@911ef85",
      "X-Openclaw-Substitution-Reason": encodeURIComponent("reviewed replacement branch"),
    });

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("declared artifact matching the recorded artifact forwards", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@b777e17" });

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("declared abbreviated sha matching recorded artifact forwards", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR_LONG, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@b777e17" });

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("prior marker exists but caller declares nothing is refused with required echo", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors?.[0]?.message).toContain("this ticket was handed to you declaring artifact 'feature/x@b777e17'");
    expect(forwardedMutations(mf.calls)).toBe(0);
  });

  it("no prior marker anywhere forwards without declaration", async () => {
    const mf = makeFetch({ comments: [{ body: "ordinary comment", userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("only the caller's own prior markers exist, so nothing was handed by someone else", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_CALLER, userId: "u-aidev" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("non-delegate-change mutation does not engage the artifact guard", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(stateWriteBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("comment fetch failure fails open and forwards", async () => {
    const mf = makeFetch({ throwOnComments: true });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("unparseable declared artifact header is refused and names branch@sha form", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "not-a-valid-artifact" });

    expect(res.body.errors?.[0]?.message).toMatch(/<branch>@<sha>/);
    expect(forwardedMutations(mf.calls)).toBe(0);
  });
});
