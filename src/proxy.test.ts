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

// Extended policy for Phase 3 workflow-gate tests (adds deploy:execute + hanzo).
const TEST_POLICY_WITH_MERGE_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [human:escalate]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: []
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
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
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation
  - id: deployment
    owner_role: deployment
    kind: normal
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
      - command: reject
        to: implementation
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
      // Distinguish label/context fetch from the main mutation.
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = bodyText ? JSON.parse(bodyText) as { query?: string } : {};
      if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels")) {
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

// AI-1397: include delegate so charles (linearUserId "u1") passes the proxy delegate check.
const DEV_IMPL_IMPLEMENTATION_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u1" } } },
};
const DEV_IMPL_DEPLOYMENT_RESPONSE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] }, delegate: { id: "u1" } } },
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
      if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mainResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("blocks an illegal command ('approve') on a dev-impl implementation ticket", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

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
    expect(res.body.errors[0].message).toContain("implementation");
  });

  it("allows the legal command ('submit') on a dev-impl implementation ticket", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

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
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("blocks deploy from non-deployment body (charles) in deployment state", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "deploy")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("deploy:execute");
  });

  it("allows deploy from hanzo (deployment body) in deployment state", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_DEPLOYMENT_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "deploy")
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
      .set("X-Openclaw-Linear-Intent", "deploy")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  // ── AI-1397: delegate-only enforcement ───────────────────────────────────

  it("blocks a non-delegate agent (different linearUserId) from mutating a workflow ticket", async () => {
    // Ticket delegate is "u99" (not charles's "u1") → reject regardless of command legality.
    const nonDelegateResponse = {
      data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u99" } } },
    };
    globalThis.fetch = makeFetch(nonDelegateResponse);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit") // would be legal if delegate matched
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("not the current delegate");
  });

  it("fails open (allows) when ticket has no delegate set", async () => {
    const noDelegateResponse = {
      data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: null } },
    };
    globalThis.fetch = makeFetch(noDelegateResponse);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  // ── AI-1397: version floor ────────────────────────────────────────────────

  it("blocks a CLI below the minimum version on a workflow mutation", async () => {
    process.env.PROXY_MIN_CLI_VERSION = "1.0.0";
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    delete process.env.PROXY_MIN_CLI_VERSION;
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("minimum required");
    expect(res.body.errors[0].message).toContain("1.0.0");
  });

  it("allows a CLI at or above the minimum version", async () => {
    process.env.PROXY_MIN_CLI_VERSION = "0.3.0";
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    delete process.env.PROXY_MIN_CLI_VERSION;
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it("fails open (allows) when version header is absent", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      // no X-Openclaw-Linear-Cli-Version header
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });
});

// ── Phase 3 / B2: state-label transition application ─────────────────────

const DEV_IMPL_IMPLEMENTATION_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      team: { id: "team-uuid" },
      labels: {
        nodes: [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "state-lbl", name: "state:implementation" },
        ],
      },
    },
  },
};

const TEAM_LABELS_WITH_CR = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "cr-lbl", name: "state:code-review" },
          { id: "impl-lbl", name: "state:implementation" },
        ],
      },
    },
  },
};

describe("proxy enforcement — B2 state-label transition application", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-b2-test-"));
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

  /**
   * Full-stack B2 fetch mock. Handles:
   *   IssueLabels   — B1 validation fetch (returns label names)
   *   IssueWithLabels — B2 transition fetch (returns label IDs + team)
   *   TeamLabels    — B2 label lookup
   *   ApplyStateTransition — B2 issueUpdate mutation
   *   everything else → MOCK_RESPONSE (the agent's main mutation)
   * Records every call so tests can assert transition behavior.
   */
  function makeB2Fetch(opts: {
    b1LabelResponse: object;
    b2IssueResponse?: object;
    b2TeamLabels?: object;
    updateSuccess?: boolean;
  }): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: unknown }> } {
    const calls: Array<{ query: string; variables: unknown }> = [];

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: unknown };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables });

      const q = parsed.query ?? "";

      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
        return new Response(JSON.stringify(opts.b1LabelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify(opts.b2IssueResponse ?? DEV_IMPL_IMPLEMENTATION_WITH_IDS),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify(opts.b2TeamLabels ?? TEAM_LABELS_WITH_CR),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("ApplyStateTransition")) {
        const success = opts.updateSuccess ?? true;
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Main agent mutation → success response.
      return new Response(JSON.stringify(MOCK_RESPONSE), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };

    return { fetch: mockFetch, calls };
  }

  it("applies state transition after a legal command is forwarded", async () => {
    const { fetch: mock, calls } = makeB2Fetch({
      b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE,
    });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // B2 transition call should have fired.
    expect(calls.some((c) => c.query.includes("ApplyStateTransition"))).toBe(true);
    // The issueUpdate should use internal UUID and contain the new label.
    const b2call = calls.find((c) => c.query.includes("ApplyStateTransition"));
    expect(b2call).toBeDefined();
    const vars = b2call!.variables as { issueId: string; labelIds: string[] };
    expect(vars.issueId).toBe("internal-uuid");
    expect(vars.labelIds).toContain("cr-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  it("does NOT apply transition on a blocked command", async () => {
    const { fetch: mock, calls } = makeB2Fetch({
      b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE,
    });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "approve") // illegal in implementation
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(calls.some((c) => c.query.includes("ApplyStateTransition"))).toBe(false);
  });

  it("does NOT apply transition when no intent header (pure pass-through)", async () => {
    const { fetch: mock, calls } = makeB2Fetch({
      b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE,
    });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      // No X-Openclaw-Linear-Intent header.
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_RESPONSE);
    expect(calls.some((c) => c.query.includes("ApplyStateTransition"))).toBe(false);
  });

  it("returns the upstream response even when the B2 transition fails", async () => {
    const { fetch: mock, calls } = makeB2Fetch({
      b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE,
      updateSuccess: false,
    });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    // Agent response is still 200 even though label update returned non-success.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(calls.some((c) => c.query.includes("ApplyStateTransition"))).toBe(true);
  });
});

// ── Layer 2: Raw mutation interception via proxy (AI-1387) ────────────────

describe("proxy — Layer 2 raw mutation interception (AI-1387)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-layer2-test-"));
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
      if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels")) {
        return new Response(JSON.stringify(labelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mainResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("blocks a raw stateId mutation on a workflow ticket without intent header", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      // NO X-Openclaw-Linear-Intent header — raw mutation
      .send({
        query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("Direct status");
    expect(res.body.errors[0].message).toContain("blocked on this workflow ticket");
  });

  it("blocks a raw assigneeId mutation on a workflow ticket without intent header", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({
        query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "issue-uuid", input: { assigneeId: "user-uuid" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("Direct assignee");
  });

  it("allows raw mutations on non-workflow tickets (ad-hoc §4.6)", async () => {
    globalThis.fetch = makeFetch(NON_WORKFLOW_LABEL_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({
        query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("allows raw mutations without stateId/assigneeId on workflow tickets", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({
        query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "issue-uuid", input: { title: "Updated title" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("allows intent-headed requests through (those use B1 validation, not Layer 2)", async () => {
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // submit is legal in implementation — should pass B1 and not hit Layer 2.
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });
});

// ── Layer 1: Workflow reminder header in response (AI-1387) ───────────────

describe("proxy — Layer 1 workflow reminder header (AI-1387)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-layer1-test-"));
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

  /**
   * Full fetch mock for Layer 1 tests. Handles:
   *   IssueLabels — B1 validation
   *   IssueWithLabels — B2 transition
   *   TeamLabels — B2 label lookup
   *   ApplyStateTransition — B2 issueUpdate
   *   everything else → MOCK_RESPONSE
   */
  function makeFullFetch(opts: {
    b1LabelResponse: object;
    b2IssueResponse?: object;
    b2TeamLabels?: object;
  }): typeof globalThis.fetch {
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const q = parsed.query ?? "";

      if (q.includes("IssueLabels") && !q.includes("IssueWithLabels")) {
        return new Response(JSON.stringify(opts.b1LabelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (q.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify(opts.b2IssueResponse ?? DEV_IMPL_IMPLEMENTATION_WITH_IDS),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify(opts.b2TeamLabels ?? TEAM_LABELS_WITH_CR),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("ApplyStateTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(MOCK_RESPONSE), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("includes _workflowReminder in response body after a successful submit", async () => {
    globalThis.fetch = makeFullFetch({
      b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE,
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // Layer 1 reminder should be present in the response body
    expect(res.body._workflowReminder).toBeDefined();
    expect(res.body._workflowReminder).toContain("code-review");
    expect(res.body._workflowReminder).toContain("approve");
    expect(res.body._workflowReminder).toContain("request-changes");
    expect(res.body._workflowReminder).toContain("escape");
  });

  it("does NOT include _workflowReminder when no intent header is present", async () => {
    globalThis.fetch = makeFullFetch({
      b1LabelResponse: NON_WORKFLOW_LABEL_RESPONSE,
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({
        query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: "issue-uuid", input: { title: "Updated title" } },
      });

    expect(res.status).toBe(200);
    expect(res.body._workflowReminder).toBeUndefined();
  });
});
