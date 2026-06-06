/**
 * Tests for the connector proxy: Phase 0B pass-through and Phase 2 slice 1
 * enforcement (design.md §4.6, §11, §13).
 *
 * We mock the upstream fetch so these tests never reach api.linear.app.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
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

// Extended policy for Phase 3 workflow-gate tests (adds repo:merge + hanzo).
const TEST_POLICY_WITH_MERGE_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: repo:merge
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: merge-gate
    grants: [linear:transition, repo:merge]
roles:
  - id: steward
    requires: [human:escalate]
  - id: merge-gate
    requires: [repo:merge]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: []
  - id: hanzo
    container: merge-gate
    fills_roles: [merge-gate]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
states:
  - id: intake
    owner_role: steward
    kind: normal
    transitions:
      - command: accept
        to: ready-for-impl
  - id: in-progress
    owner_role: dev
    kind: normal
    transitions:
      - command: submit
        to: awaiting-review
  - id: awaiting-review
    owner_role: code-review
    kind: normal
    transitions:
      - command: approve
        to: approved
      - command: request-changes
        to: changes-requested
  - id: approved
    owner_role: merge-gate
    kind: normal
    transitions:
      - command: merge
        to: merged
        requires_capability: repo:merge
  - id: done
    kind: terminal
    transitions: []
`;

// Minimal agents.json so createApp() doesn't complain.
function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ agents: [{ name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok", host: "local" }] }),
    "utf8"
  );
  return file;
}

function writePolicyFile(dir: string, content = TEST_POLICY_YAML): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function writeWorkflowFile(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(file, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = file;
  return file;
}

const MOCK_RESPONSE = { data: { viewer: { id: "user-1", name: "Charles" } } };
const WORKFLOW_LABEL_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:sprint-1" }] } } },
};
const NON_WORKFLOW_LABEL_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
};

describe("proxy /proxy/graphql", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    writeWorkflowFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    // Capture real fetch and replace with mock.
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      // Only intercept Linear API calls.
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };
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

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .send({ query: "{ viewer { id } }" });
    expect(res.status).toBe(401);
    expect(res.body.errors).toBeDefined();
  });

  it("forwards requests to Linear and returns the response transparently", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({ query: "{ viewer { id name } }", operationName: "ViewerQuery" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_RESPONSE);
  });

  it("passes the Authorization header to Linear unchanged", async () => {
    let capturedAuth: string | undefined;
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"];
        return new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer my-agent-token")
      .send({ query: "{ viewer { id } }" });

    expect(capturedAuth).toBe("Bearer my-agent-token");
  });

  it("returns 502 when Linear API is unreachable", async () => {
    globalThis.fetch = async (url) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        throw new Error("ECONNREFUSED");
      }
      return originalFetch(url);
    };

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(502);
    expect(res.body.errors[0].message).toContain("ECONNREFUSED");
  });
});

// ── Phase 2 / slice 1: enforcement tests ──────────────────────────────────

describe("proxy enforcement — needs-human (Phase 2 slice 1)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-enforce-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    writeWorkflowFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
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

  function makeFetch(labelResponse: object, mainResponse = MOCK_RESPONSE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      // Distinguish label fetch (IssueLabels query) from the main mutation.
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
      if (parsed.query?.includes("IssueLabels")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mainResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("blocks needs-human from non-steward on a workflow ticket", async () => {
    globalThis.fetch = makeFetch(WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send({ query: "mutation NeedsHuman($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("steward");
  });

  it("allows needs-human from steward (Astrid) on a workflow ticket", async () => {
    globalThis.fetch = makeFetch(WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send({ query: "mutation NeedsHuman($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("allows needs-human on a non-workflow ticket (§4.6 mode switch)", async () => {
    globalThis.fetch = makeFetch(NON_WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send({ query: "mutation NeedsHuman($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("allows non-needs-human commands on workflow ticket (zero behavior change)", async () => {
    globalThis.fetch = makeFetch(WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "begin-work")
      .send({ query: "mutation BeginWork($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("allows requests with no intent header (pure pass-through)", async () => {
    globalThis.fetch = makeFetch(WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_RESPONSE);
  });
});

// ── Phase 3 / B1: workflow-def-driven command validation ──────────────────

const DEV_IMPL_IN_PROGRESS_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:in-progress" }] } } },
};
const DEV_IMPL_APPROVED_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:approved" }] } } },
};

describe("proxy enforcement — workflow-gate Phase 3 B1", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-wf-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir, TEST_POLICY_WITH_MERGE_YAML);
    writeWorkflowFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeFetch(labelResponse: object, mainResponse = MOCK_RESPONSE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
      if (parsed.query?.includes("IssueLabels")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mainResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("blocks an illegal command ('approve') on a dev-impl in-progress ticket", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IN_PROGRESS_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "approve")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("approve");
    expect(res.body.errors[0].message).toContain("in-progress");
  });

  it("allows the legal command ('submit') on a dev-impl in-progress ticket", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IN_PROGRESS_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("allows escape from any state (break-glass §4.4)", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IN_PROGRESS_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("blocks merge from non-merge-gate body (charles) in approved state", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_APPROVED_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "merge")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("repo:merge");
  });

  it("allows merge from hanzo (merge-gate body) in approved state", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_APPROVED_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "merge")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("is pass-through for ad-hoc tickets (no wf:* label) — §4.6 mode switch", async () => {
    globalThis.fetch = makeFetch(NON_WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "merge")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });
});
