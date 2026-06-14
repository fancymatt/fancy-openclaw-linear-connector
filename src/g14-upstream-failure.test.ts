/**
 * G-14: Upstream-Linear-failure policy — 429/5xx/timeout after preconditions pass.
 * AI-1549 / verification-and-rigor-plan.md §4.10
 *
 * L3 harness: a "misbehaving Linear" mock that returns 429/500/timeout at the
 * forward step, after all preconditions (P2 escalation-gate, P3 workflow-gate)
 * have already passed. Tests prove three AC:
 *
 *   AC1: No half-applied state — the B2 state-label transition (applyStateTransition)
 *        MUST NOT run when the upstream forward fails. A partial write (Linear wrote
 *        nothing but the connector applied state labels) would corrupt workflow state.
 *
 *   AC2: Sane agent-visible result — the proxy returns HTTP 200 with a structured
 *        GraphQL-style error ({ errors: [{ message, extensions: { code, ... } }] })
 *        regardless of upstream failure mode. The code is one of:
 *          UPSTREAM_RATE_LIMITED   — 429 response from Linear
 *          UPSTREAM_ERROR          — 5xx response from Linear
 *          UPSTREAM_TIMEOUT        — network error / connection refused
 *        For 429, extensions.retryAfterSeconds must be present (from Retry-After
 *        header if supplied, otherwise a safe default).
 *
 *   AC3: No retry-spam — the proxy makes exactly one attempt at the upstream
 *        mutation. The agent session receives the error and is responsible for
 *        any retry; the proxy never hammers Linear on behalf of the agent.
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

// ── Shared fixtures ────────────────────────────────────────────────────────

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
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// Ticket in "implementation" state, delegate = charles (linearUserId "u1").
// This passes the P3 workflow-gate for the "submit" command.
const IMPLEMENTATION_LABEL_RESPONSE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u1" },
    },
  },
};

// The mutation the agent sends — a valid `submit` command targeting a workflow ticket.
const SUBMIT_MUTATION = {
  query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
  variables: { id: "issue-uuid-g14" },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
      ],
    }),
    "utf8"
  );
  return file;
}

function writePolicyFile(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, TEST_POLICY_YAML, "utf8");
  return file;
}

function writeWorkflowFile(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(file, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = file;
  return file;
}

/**
 * Build a misbehaving-Linear fetch mock for the L3 harness.
 *
 * Label-fetch calls (IssueContext / IssueLabels) return a healthy 200 so
 * preconditions pass. The actual mutation forward is intercepted and made to
 * behave badly (429 / 5xx / throw).
 *
 * Also counts every call made to api.linear.app, tagged by operation type:
 *   "label"    — enforcement / state-snapshot label fetch
 *   "mutation" — the main forward (the submit mutation)
 *   "b2"       — B2 label-apply calls (IssueLabels re-fetch + issueUpdate with labelIds)
 */
type CallTag = "label" | "mutation" | "b2";
interface MisbehavingMockResult {
  mock: (url: unknown, init?: RequestInit) => Promise<Response>;
  calls: CallTag[];
}

type UpstreamFailure =
  | { kind: "429"; retryAfter?: number }
  | { kind: "500" }
  | { kind: "503" }
  | { kind: "timeout" };

function makeMisbehavingMock(
  originalFetch: typeof globalThis.fetch,
  failure: UpstreamFailure
): MisbehavingMockResult {
  const calls: CallTag[] = [];

  const mock = async (url: unknown, init?: RequestInit): Promise<Response> => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return originalFetch(url as Parameters<typeof fetch>[0], init);
    }

    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string }) : {};
    const query = parsed.query ?? "";

    // Enforcement / source-state snapshot fetches → return healthy labels.
    if (query.includes("IssueContext") || query.includes("IssueLabels")) {
      // Distinguish B2 re-fetch (contains "labelIds" in a prior mutation body) by
      // checking whether we've already logged a mutation call for this mock session.
      const tag: CallTag = calls.includes("mutation") ? "b2" : "label";
      calls.push(tag);
      return new Response(JSON.stringify(IMPLEMENTATION_LABEL_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // B2 label-apply mutation: issueUpdate with labelIds variable.
    if (query.includes("issueUpdate") && bodyText.includes("labelIds")) {
      calls.push("b2");
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Actual mutation forward — this is where Linear misbehaves.
    calls.push("mutation");

    if (failure.kind === "timeout") {
      throw new Error("ECONNABORTED: connection timeout");
    }

    if (failure.kind === "429") {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (failure.retryAfter !== undefined) {
        headers["Retry-After"] = String(failure.retryAfter);
      }
      return new Response(
        JSON.stringify({ errors: [{ message: "Too Many Requests" }] }),
        { status: 429, headers }
      );
    }

    if (failure.kind === "500") {
      return new Response(
        JSON.stringify({ errors: [{ message: "Internal Server Error" }] }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 503
    return new Response(
      JSON.stringify({ errors: [{ message: "Service Unavailable" }] }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  };

  return { mock, calls };
}

// ── L3 harness suite ───────────────────────────────────────────────────────

describe("G-14: upstream Linear failure after preconditions pass (L3 harness)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "g14-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
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

  // ── AC1: No half-applied state ────────────────────────────────────────────

  describe("AC1: no B2 state transition when upstream fails", () => {
    it("does not apply B2 state transition when Linear returns 429", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      // AC1: no B2 calls should appear after the failed mutation forward.
      const b2Calls = calls.filter((t) => t === "b2");
      expect(b2Calls).toHaveLength(0);
    });

    it("does not apply B2 state transition when Linear returns 500", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "500" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const b2Calls = calls.filter((t) => t === "b2");
      expect(b2Calls).toHaveLength(0);
    });

    it("does not apply B2 state transition when Linear returns 503", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "503" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const b2Calls = calls.filter((t) => t === "b2");
      expect(b2Calls).toHaveLength(0);
    });

    it("does not apply B2 state transition on network timeout", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "timeout" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const b2Calls = calls.filter((t) => t === "b2");
      expect(b2Calls).toHaveLength(0);
    });
  });

  // ── AC2: Sane agent-visible result ────────────────────────────────────────

  describe("AC2: sane agent-visible result (structured error, HTTP 200)", () => {
    // The proxy MUST return HTTP 200 for all upstream failure modes so that the
    // agent's axios client does not throw and the error can be handled in the
    // GraphQL error layer (response.data.errors). A raw 4xx/5xx passthrough
    // makes the error opaque and prevents structured retry logic.

    it("returns HTTP 200 when Linear returns 429", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      // AC2: proxy normalizes all upstream failures to HTTP 200 + GraphQL error body.
      expect(res.status).toBe(200);
    });

    it("returns errors array when Linear returns 429", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    it("error code is UPSTREAM_RATE_LIMITED for 429", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_RATE_LIMITED");
    });

    it("includes retryAfterSeconds from Retry-After header for 429", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors[0].extensions?.retryAfterSeconds).toBe(60);
    });

    it("provides a default retryAfterSeconds when 429 has no Retry-After header", async () => {
      // No retryAfter field → Linear didn't send a Retry-After header.
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      // Default retry guidance must be present and positive.
      const retryAfter = res.body.errors?.[0]?.extensions?.retryAfterSeconds;
      expect(typeof retryAfter).toBe("number");
      expect(retryAfter).toBeGreaterThan(0);
    });

    it("error message communicates that no state was changed (429)", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 30 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const message: string = res.body.errors?.[0]?.message ?? "";
      // The message should indicate no state transition occurred so the agent
      // knows it is safe to retry without risk of double-applying the transition.
      expect(message.toLowerCase()).toMatch(/no state|not applied|unchanged|rate.?limit/);
    });

    it("returns HTTP 200 when Linear returns 500", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "500" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.status).toBe(200);
    });

    it("error code is UPSTREAM_ERROR for 500", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "500" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_ERROR");
    });

    it("error extensions include httpStatus for 5xx", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "500" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors[0].extensions?.httpStatus).toBe(500);
    });

    it("returns HTTP 200 when Linear returns 503", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "503" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.status).toBe(200);
    });

    it("error code is UPSTREAM_ERROR for 503", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "503" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_ERROR");
    });

    it("returns HTTP 200 on network timeout", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "timeout" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.status).toBe(200);
    });

    it("error code is UPSTREAM_TIMEOUT on network timeout", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "timeout" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_TIMEOUT");
    });

    it("does not include _workflowReminder when upstream fails (no B2 = no state context)", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      // _workflowReminder is only injected after a successful B2 transition.
      expect(res.body._workflowReminder).toBeUndefined();
    });

    it("non-workflow (no intent) 429 is also normalized to 200 with structured error", async () => {
      // Without an intent header the request is a pass-through (no enforcement).
      // The 429 normalization policy must apply unconditionally so ad-hoc agents
      // also get structured errors.
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 30 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .send({ query: "{ viewer { id } }" });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_RATE_LIMITED");
    });

    it("non-workflow (no intent) 500 is also normalized to 200 with structured error", async () => {
      const { mock } = makeMisbehavingMock(originalFetch, { kind: "500" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .send({ query: "{ viewer { id } }" });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions?.code).toBe("UPSTREAM_ERROR");
    });
  });

  // ── AC3: No retry-spam ────────────────────────────────────────────────────

  describe("AC3: proxy makes exactly one upstream mutation attempt (no retry-spam)", () => {
    it("makes exactly one mutation call when Linear returns 429", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "429", retryAfter: 60 });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const mutationCalls = calls.filter((t) => t === "mutation");
      expect(mutationCalls).toHaveLength(1);
    });

    it("makes exactly one mutation call when Linear returns 500", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "500" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const mutationCalls = calls.filter((t) => t === "mutation");
      expect(mutationCalls).toHaveLength(1);
    });

    it("makes exactly one mutation call on network timeout", async () => {
      const { mock, calls } = makeMisbehavingMock(originalFetch, { kind: "timeout" });
      globalThis.fetch = mock as typeof globalThis.fetch;

      await request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer test-token")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .send(SUBMIT_MUTATION);

      const mutationCalls = calls.filter((t) => t === "mutation");
      expect(mutationCalls).toHaveLength(1);
    });
  });
});
