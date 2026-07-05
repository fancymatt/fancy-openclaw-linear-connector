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
import { resetConfigHealth } from "./config-health.js";

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

// Extended policy for Phase 3 workflow-gate tests (adds deploy:execute + hanzo).
const TEST_POLICY_WITH_MERGE_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
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
        requires_capability: deploy:execute
      - command: reject
        to: implementation
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// Minimal agents.json so createApp() doesn't complain.
function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ agents: [{ name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok", host: "local" }, { name: "hanzo", linearUserId: "u2", openclawAgent: "hanzo", accessToken: "tok2", host: "local" }] }),
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

  it("returns 200 with UPSTREAM_TIMEOUT when Linear API is unreachable", async () => {
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

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_TIMEOUT");
    expect(res.body.errors[0].message).toContain("ECONNREFUSED");
  });
});

// ── Broker token injection (AI-1382 follow-up) ─────────────────────────────

describe("proxy broker token injection", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  // Agents file where charles carries an opaque proxy token + vaulted real token.
  function writeBrokerAgents(d: string): string {
    const file = path.join(d, "agents.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        agents: [
          {
            name: "charles",
            linearUserId: "u1",
            openclawAgent: "charles",
            accessToken: "real-charles-linear-token",
            proxyToken: "lpx_charles_opaque_secret",
            proxyUrl: "http://127.0.0.1:3100/proxy/graphql",
            host: "local",
          },
        ],
      }),
      "utf8"
    );
    return file;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-broker-test-"));
    process.env.AGENTS_FILE = writeBrokerAgents(dir);
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

  it("swaps a known proxy token for the agent's vaulted real Linear token upstream", async () => {
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
      .set("Authorization", "lpx_charles_opaque_secret")
      .send({ query: "{ viewer { id } }" });

    // The opaque proxy token must never reach Linear; the vaulted token does.
    expect(capturedAuth).toBe("real-charles-linear-token");
    expect(capturedAuth).not.toContain("lpx_");
  });

  it("derives identity from the proxy token, ignoring a spoofed X-Openclaw-Agent header", async () => {
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
      .set("Authorization", "lpx_charles_opaque_secret")
      .set("X-Openclaw-Agent", "someone-else")
      .send({ query: "{ viewer { id } }" });

    // Identity resolved from the token (charles), so charles's real token is injected.
    expect(capturedAuth).toBe("real-charles-linear-token");
  });

  it("forwards an unrecognized Authorization unchanged (legacy direct-token fallback)", async () => {
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
      .set("Authorization", "lin_oa_some_direct_token")
      .send({ query: "{ viewer { id } }" });

    expect(capturedAuth).toBe("lin_oa_some_direct_token");
  });

  it("strips a Bearer prefix when matching the proxy token", async () => {
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
      .set("Authorization", "Bearer lpx_charles_opaque_secret")
      .send({ query: "{ viewer { id } }" });

    expect(capturedAuth).toBe("real-charles-linear-token");
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
    expect(res.body.errors[0].message).toContain("Ai (human gateway)");
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
// AI-1400: hanzo (u2) is the delegate in deployment state for tests that verify hanzo can deploy.
const DEV_IMPL_DEPLOYMENT_RESPONSE_HANZO_DELEGATE = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] }, delegate: { id: "u2" } } },
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
      // Done gate (AI-1475/AI-1797): branch/PR status via GitHub attachments
      if (parsed.query?.includes("IssueBranchAndPR")) {
        return new Response(JSON.stringify({
          data: { issue: { attachments: { nodes: [{ url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: "merged" } }] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    globalThis.fetch = makeFetch(DEV_IMPL_DEPLOYMENT_RESPONSE_HANZO_DELEGATE);

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

  // ── AI-1583: enforcement applies to mutations only ───────────────────────
  // The CLI sets the intent header for a whole semantic command, so reads issued
  // mid-command (notably updateIssue()'s trailing getIssue re-fetch) inherit it.
  // After a transition reassigns the delegate, that read would otherwise trip the
  // delegate-only guard and surface a spurious "not the current delegate" block
  // even though the mutation succeeded. A read must never be gated.

  it("AI-1583: does NOT block a read query carrying a workflow intent on a non-delegate ticket", async () => {
    // Same situation that blocks the mutation above (delegate u99 ≠ charles's u1),
    // but the operation is a read → it must pass through.
    const nonDelegateResponse = {
      data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u99" } } },
    };
    globalThis.fetch = makeFetch(nonDelegateResponse);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit") // sticky intent inherited by the read
      .send({ query: "query IssueDetail($id: String!) { issue(id: $id) { id } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  it("AI-1583: still blocks a non-delegate MUTATION carrying the same intent (enforcement intact)", async () => {
    const nonDelegateResponse = {
      data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u99" } } },
    };
    globalThis.fetch = makeFetch(nonDelegateResponse);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("not the current delegate");
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

  it("AI-1668: escape (break-glass) is blocked for a non-delegate, non-steward agent", async () => {
    // charles (linearUserId "u1") is not the delegate (u99) and not the steward.
    const nonDelegateResponse = {
      data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u99" } } },
    };
    globalThis.fetch = makeFetch(nonDelegateResponse);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/\[Proxy\]/);
    expect(res.body.errors[0].message).toMatch(/delegate|steward/i);
  });

  it("blocks an agent not registered in agents.json when ticket has a known delegate (AI-1400 B2 fail-closed)", async () => {
    const knownDelegateResponse = {
      data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u99" } } },
    };
    globalThis.fetch = makeFetch(knownDelegateResponse);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "unknown-unregistered-agent")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("blocked on workflow ticket");
  });

  it("accepts a v-prefixed CLI version string (parseSemver fix)", async () => {
    process.env.PROXY_MIN_CLI_VERSION = "0.3.0";
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Linear-Cli-Version", "v0.4.0")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    delete process.env.PROXY_MIN_CLI_VERSION;
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
   *   ApplyAtomicTransition — B2 issueUpdate mutation
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
      if (q.includes("TeamStates")) {
        // AI-1498: native state resolution for the atomic writer.
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("ApplyAtomicTransition")) {
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
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
    // The issueUpdate should use internal UUID and contain the new label.
    const b2call = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
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
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
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
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
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
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
  });
});

// ── AI-1612: proxy is the sole writer of the state:* label ───────────────

// Team label set used by fetchTeamStateLabelIds to identify which forwarded
// label-delta IDs are state:* labels (and so must be stripped).
const AI1612_TEAM_STATE_LABELS = {
  data: {
    issue: {
      team: {
        labels: {
          nodes: [
            { id: "state-impl-lbl", name: "state:implementation" },
            { id: "state-cr-lbl", name: "state:code-review" },
            { id: "state-deploy-lbl", name: "state:deployment" },
            { id: "non-state-lbl", name: "bug" },
          ],
        },
      },
    },
  },
};

describe("proxy — AI-1612 state-label strip (proxy is sole writer)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-1612-test-"));
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

  function makeFetch(opts: {
    b1LabelResponse: object;
    teamStateLabels?: object;
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

      if (q.includes("TeamStateLabels")) {
        return new Response(JSON.stringify(opts.teamStateLabels ?? AI1612_TEAM_STATE_LABELS), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
        return new Response(JSON.stringify(opts.b1LabelResponse), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (q.includes("IssueWithLabels")) {
        return new Response(JSON.stringify(DEV_IMPL_IMPLEMENTATION_WITH_IDS), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (q.includes("TeamLabels")) {
        return new Response(JSON.stringify(TEAM_LABELS_WITH_CR), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (q.includes("TeamStates")) {
        return new Response(JSON.stringify({
          data: { team: { states: { nodes: [
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-thinking-uuid", name: "Thinking", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
            { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
          ] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.includes("ApplyAtomicTransition")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: opts.updateSuccess ?? true } } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(MOCK_RESPONSE), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    return { fetch: mockFetch, calls };
  }

  // The forwarded agent mutation is the issueUpdate that is NOT the proxy's own
  // ApplyAtomicTransition write.
  function forwardedInput(calls: Array<{ query: string; variables: unknown }>): Record<string, unknown> | undefined {
    const call = calls.find((c) => c.query.includes("issueUpdate") && !c.query.includes("ApplyAtomicTransition"));
    return (call?.variables as { input?: Record<string, unknown> } | undefined)?.input;
  }

  const ISSUE_UPDATE_MUTATION =
    "mutation Reject($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }";

  // AC1: state:* label deltas are stripped from the forwarded mutation; non-state deltas pass through.
  it("strips state:* label deltas from the forwarded issueUpdate but passes non-state deltas through", async () => {
    const { fetch: mock, calls } = makeFetch({ b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: ISSUE_UPDATE_MUTATION,
        variables: { id: "issue-uuid", input: { addedLabelIds: ["state-cr-lbl", "non-state-lbl"], removedLabelIds: ["state-impl-lbl"] } },
      });

    expect(res.status).toBe(200);
    const input = forwardedInput(calls);
    expect(input).toBeDefined();
    // state:* added id stripped, non-state id retained.
    expect(input!.addedLabelIds).toEqual(["non-state-lbl"]);
    // removedLabelIds held only a state:* id → key removed entirely.
    expect(input!.removedLabelIds).toBeUndefined();
    // AC3: the proxy still lands the transition itself (sole writer).
    const b2 = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(b2).toBeDefined();
    expect((b2!.variables as { labelIds: string[] }).labelIds).toContain("cr-lbl");
  });

  // AC2: a governed reject whose delegate resolution fail-closes is a TRUE no-op —
  // the state label never moved (stripped from the forward) AND no atomic write fired
  // (so the delegate is untouched). No more half-applied stranding.
  it("leaves state label AND delegate unchanged when delegate resolution fail-closes", async () => {
    const { fetch: mock, calls } = makeFetch({ b1LabelResponse: DEV_IMPL_DEPLOYMENT_RESPONSE_HANZO_DELEGATE });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "reject") // legal from deployment; dev role has no bodies → fail-closed
      .send({
        query: ISSUE_UPDATE_MUTATION,
        variables: { id: "issue-uuid", input: { addedLabelIds: ["state-impl-lbl"], removedLabelIds: ["state-deploy-lbl"] } },
      });

    expect(res.status).toBe(200);
    // The forwarded mutation carried NO state-label delta → upstream state label unchanged.
    const input = forwardedInput(calls);
    expect(input).toBeDefined();
    expect(input!.addedLabelIds).toBeUndefined();
    expect(input!.removedLabelIds).toBeUndefined();
    // applyStateTransition fail-closed → no atomic write → delegate + native untouched.
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
  });

  // Fail-open: if the team state-label set can't be resolved, strip nothing
  // (preserve prior behavior rather than risk dropping legitimate labels).
  it("forwards the label delta unchanged when the state-label set cannot be resolved", async () => {
    const { fetch: mock, calls } = makeFetch({
      b1LabelResponse: DEV_IMPL_IMPLEMENTATION_RESPONSE,
      teamStateLabels: { data: { issue: { team: { labels: { nodes: [] } } } } },
    });
    globalThis.fetch = mock;

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: ISSUE_UPDATE_MUTATION,
        variables: { id: "issue-uuid", input: { addedLabelIds: ["state-cr-lbl"], removedLabelIds: ["state-impl-lbl"] } },
      });

    const input = forwardedInput(calls);
    expect(input).toBeDefined();
    expect(input!.addedLabelIds).toEqual(["state-cr-lbl"]);
    expect(input!.removedLabelIds).toEqual(["state-impl-lbl"]);
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
   *   ApplyAtomicTransition — B2 issueUpdate
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

      if ((q.includes("IssueLabels") || q.includes("IssueContext")) && !q.includes("IssueWithLabels")) {
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
      if (q.includes("TeamStates")) {
        // AI-1498: native state resolution for the atomic writer.
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("ApplyAtomicTransition")) {
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

// ── Phase 6.5 / H-1: fail-closed + break-glass + canary (AI-1476) ──────────

describe("proxy — Phase 6.5 fail-closed (AI-1476)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-p65-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir, TEST_POLICY_WITH_MERGE_YAML);
    writeWorkflowFile(dir);
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

  function makeFetch(labelResponse: object, mainResponse = MOCK_RESPONSE) {
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

  // AC1: With the proxy stopped (upstream unreachable), a workflow command is refused.
  // (e.g., config is broken). The proxy still runs but rejects wf:* commands.
  it("rejects workflow commands when config is degraded (config-load fail-closed §16.0)", async () => {
    // Point the workflow def to a non-existent file so loadWorkflowDef fails
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    // The proxy should still work — it'll load config and record the failure
    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("could not be loaded");
    expect(res.body.errors[0].message).toContain("break-glass");
  });

  // AC2: A deliberately broken config refuses workflow advancement.
  it("refuses workflow advancement when workflow def YAML is malformed", async () => {
    // Write invalid YAML
    const badYamlPath = path.join(dir, "bad-dev-impl.yaml");
    fs.writeFileSync(badYamlPath, "not: [valid: yaml: {{{", "utf8");
    process.env.WORKFLOW_DEF_PATH = badYamlPath;
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("could not be loaded");
  });

  // AC2 (G-13a / AI-1551): steward can break-glass to move a wedged ticket.
  it("allows break-glass header to bypass enforcement when config is degraded (steward caller)", async () => {
    // Break config
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    // astrid is in the steward container (human:escalate) — must be allowed.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toBeDefined();
  });

  // G-13a (AI-1551) AC1: non-steward body is rejected when break-glass header is set.
  it("rejects break-glass from a non-steward body (G-13a AC1)", async () => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    // charles is in the dev container — no human:escalate → must be rejected.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "true")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("Break-glass rejected");
    expect(res.body.errors[0].message).toContain("charles");
  });

  it("rejects break-glass with value 'false'", async () => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    globalThis.fetch = makeFetch(DEV_IMPL_IMPLEMENTATION_RESPONSE);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Break-Glass", "false")
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: "issue-uuid" } });

    // 'false' is not a truthy break-glass value — should still fail
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
  });

  it("allows ad-hoc tickets even when config is degraded (§4.6 pass-through)", async () => {
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "nonexistent-workflow.yaml");
    resetWorkflowCache();

    // Non-workflow ticket — should still pass through
    globalThis.fetch = makeFetch(NON_WORKFLOW_LABEL_RESPONSE);

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

  it("returns 200 with UPSTREAM_TIMEOUT when upstream Linear API is unreachable", async () => {
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

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_TIMEOUT");
    expect(res.body.errors[0].message).toContain("Linear API unreachable");
  });
});
