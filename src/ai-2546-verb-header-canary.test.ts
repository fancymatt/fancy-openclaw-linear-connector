/**
 * AI-2546: Guard against silent suite decapitation when future required
 * headers are added to the intent-resolving verb path.
 *
 * These tests intentionally pin the generic test-support seam, not another
 * one-off assertion for the AI-2530 X-Openclaw-Command-Id incident.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";
import {
  REQUIRED_VERB_HEADERS,
  assertVerbPathReachable,
  verbRequest,
  type VerbRequestOptions,
} from "./test-support/verb-request.js";

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
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: spawner
version: 1
archetype: single-task
entry_state: determining-scope
states:
  - id: determining-scope
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: propose-brief
        to: spawning-scope
        generic: continue
        requires_comment: true
  - id: spawning-scope
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: scoping
        generic: continue
        requires_comment: true
  - id: scoping
    owner_role: dev
    kind: normal
    native_state: doing
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "LIF-28";

function contextFor(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:spawner" }, { name: `state:${state}` }] },
        delegate: delegateUserId ? { id: delegateUserId } : null,
      },
    },
  };
}

function withIdsFor(state: string): object {
  return {
    data: {
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:spawner" },
            { id: `${state}-lbl`, name: `state:${state}` },
          ],
        },
      },
    },
  };
}

const TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "determining-scope-lbl", name: "state:determining-scope" },
          { id: "spawning-scope-lbl", name: "state:spawning-scope" },
          { id: "scoping-lbl", name: "state:scoping" },
        ],
      },
    },
  },
};

const TEAM_STATES = {
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

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function makeMutableFetch(initial: { state: string; delegate: string | null }) {
  let currentContext = contextFor(initial.state, initial.delegate);
  let withIdsState = initial.state;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText);
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const q = parsed.query ?? "";

    const json = (payload: object) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      return json(currentContext);
    }
    if (q.includes("IssueWithLabels")) {
      return json(withIdsFor(withIdsState));
    }
    if (q.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: TEAM_LABELS.data.team.labels } } } });
    }
    if (q.includes("TeamLabels")) {
      return json(TEAM_LABELS);
    }
    if (q.includes("TeamStates")) {
      return json(TEAM_STATES);
    }
    if (q.includes("VerifyTransitionWrite")) {
      const ctx = currentContext as { data: { issue: { labels: unknown; delegate: unknown } } };
      return json({
        data: {
          issue: {
            labels: ctx.data.issue.labels,
            delegate: ctx.data.issue.delegate,
            state: { id: "s-doing" },
          },
        },
      });
    }
    if (q.includes("ApplyAtomicTransition")) {
      const vars = parsed.variables ?? {};
      const addedIds = (vars.labelIds as string[] | undefined) ?? [];
      const target = ["determining-scope", "spawning-scope", "scoping"]
        .find((s) => addedIds.includes(`${s}-lbl`));
      if (target) {
        currentContext = contextFor(target, "u-igor");
        withIdsState = target;
      }
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({
      data: {
        commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-16T00:00:00Z", url: "u" } },
        issueUpdate: { success: true },
      },
    });
  };

  return {
    fetch: mockFetch,
    calls,
    setWithIdsState: (state: string) => {
      withIdsState = state;
    },
  };
}

function commentCreateBody(body: string) {
  return {
    operationName: "AddComment",
    query: `mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id createdAt url } }
    }`,
    variables: { issueId: ISSUE_UUID, body },
  };
}

function appliedStateLabels(calls: Array<{ query: string; variables: Record<string, unknown> }>): string[] {
  return calls
    .filter((c) => c.query.includes("ApplyAtomicTransition"))
    .map((c) => JSON.stringify(c.variables));
}

function canaryOpts(): VerbRequestOptions {
  return {
    agent: "igor",
    token: "tok-igor",
    cliVersion: "0.3.6",
    intent: "continue-workflow",
    commandId: "ai-2546-canary-command",
    body: commentCreateBody("AI-2546 canary reaches the transition behavior."),
  };
}

function wrapWithFutureRequiredHeaderGuard(app: Express): Express {
  const wrapped = express();
  wrapped.use((req: Request, res: Response, next: NextFunction) => {
    const intent = req.header("X-Openclaw-Linear-Intent");
    const isVerbPath =
      req.method === "POST" &&
      req.path === "/proxy/graphql" &&
      (intent === "continue-workflow" || intent === "request-revision");

    if (isVerbPath && !req.header("X-Openclaw-Future-Guard")) {
      res.status(200).json({
        errors: [{ message: "Future required header X-Openclaw-Future-Guard is required for this verb path." }],
      });
      return;
    }

    next();
  });
  wrapped.use(app);
  return wrapped;
}

describe("AI-2546 verb-path required-header canary", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let mf: ReturnType<typeof makeMutableFetch>;

  beforeEach(() => {
    process.env.PROXY_MIN_CLI_VERSION = "0.3.0";

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2546-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "spawner.yaml");
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
    mf = makeMutableFetch({ state: "determining-scope", delegate: "u-igor" });
    mf.setWithIdsState("determining-scope");
    globalThis.fetch = mf.fetch;
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
    fs.rmSync(dir, { recursive: true, force: true });

    delete process.env.PROXY_MIN_CLI_VERSION;
  });

  it("AC1a: canary is green today because assertVerbPathReachable reaches behavior with the current required-header registry", async () => {
    // AC1a: This must turn red when proxy.ts adds a new verb-path required
    // header and REQUIRED_VERB_HEADERS is not updated to emit it.
    await expect(assertVerbPathReachable(appState.app, canaryOpts())).resolves.toBeUndefined();
    expect(appliedStateLabels(mf.calls).join(" ")).toContain("spawning-scope-lbl");
  });

  it("AC1b: canary is generically sensitive to an unknown future verb-path required header", async () => {
    // AC1b: The detector must fail on any new gate that stops the request
    // before behavior, without hardcoding that future header's name.
    const guardedApp = wrapWithFutureRequiredHeaderGuard(appState.app);
    await expect(assertVerbPathReachable(guardedApp, canaryOpts())).rejects.toThrow(/Future required header/);
  });

  it("AC1c: registry covers the proxy's current gate and verbRequest emits the required command identity header", async () => {
    // AC1c: Today the registry must contain the AI-2530 hard gate, and a
    // helper-built request must not be decapitated by that current gate.
    expect(REQUIRED_VERB_HEADERS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "X-Openclaw-Command-Id",
          intents: expect.arrayContaining(["continue-workflow", "request-revision"]),
        }),
      ]),
    );

    const res = await verbRequest(appState.app, canaryOpts()).send(canaryOpts().body);
    expect(res.status).toBe(200);
    const errMsg = (res.body?.errors?.[0]?.message as string | undefined) ?? "";
    expect(errMsg).not.toContain("X-Openclaw-Command-Id");
    expect(appliedStateLabels(mf.calls).join(" ")).toContain("spawning-scope-lbl");
  });

  it("AC1d: direct hand-built requests can be silently decapitated while helper-built verb requests reach behavior", async () => {
    // AC1d: Documents the exact failure mode AI-2546 prevents: a suite can keep
    // sending a stale hand-maintained header set and assert the wrong layer.
    const staleHandBuilt = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "continue-workflow")
      .send(commentCreateBody("missing command identity"));

    expect(staleHandBuilt.status).toBe(200);
    const staleErrMsg = (staleHandBuilt.body?.errors?.[0]?.message as string | undefined) ?? "";
    expect(staleErrMsg).toContain("X-Openclaw-Command-Id");
    expect(appliedStateLabels(mf.calls)).toEqual([]);

    const helperBuilt = await verbRequest(appState.app, {
      ...canaryOpts(),
      commandId: "ai-2546-helper-command-after-decapitation",
      body: commentCreateBody("helper-built request reaches behavior"),
    }).send(commentCreateBody("helper-built request reaches behavior"));

    expect(helperBuilt.status).toBe(200);
    const helperErrMsg = (helperBuilt.body?.errors?.[0]?.message as string | undefined) ?? "";
    expect(helperErrMsg).not.toContain("X-Openclaw-Command-Id");
    expect(appliedStateLabels(mf.calls).join(" ")).toContain("spawning-scope-lbl");
  });
});
