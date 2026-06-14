/**
 * AI-1548 — Idempotency + concurrent-command race handling (G-8/G-16)
 *
 * Tests are RED against the current implementation — they specify the target
 * behavior. Igor implements; these tests go green.
 *
 * AC1 (G-8): replay each transition event twice → single effect.
 *   Covers both webhook delivery dedup (EventStore) and proxy-level command
 *   replay: two concurrent identical proxy commands on the same ticket must
 *   produce exactly one upstream Linear forward.
 *
 * AC2 (G-8): interleave overlay + transition writes → authoritative write wins.
 *   The engagement overlay may read stale (non-terminal) labels before B2 writes
 *   `state:done`. The overlay must not overwrite the terminal native-state write.
 *   Requires a pre-write re-check in engagement-status (not present today).
 *
 * AC3 (G-16): two legal-from-current transitions fired concurrently → exactly
 *   one applies; loser rejected with the post-first legal set named.
 *   Requires per-ticket locking in the proxy (not present today).
 *
 * Infrastructure note: tests intentionally avoid createApp() / SQLite stores so
 * they run cleanly on arm64 dev machines where the better-sqlite3 native
 * binding may not be rebuilt. Proxy tests go through handleProxyRequest
 * directly; webhook dedup tests use an in-memory EventStore stand-in.
 */

import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { handleProxyRequest } from "./proxy.js";
import { createWebhookRouter } from "./webhook/index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, resetNativeStateCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { applyEngagementStatus } from "./engagement-status.js";
import type { EventStore } from "./store/event-store.js";

// ── Shared config ──────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: deploy:execute
  - id: human:escalate
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
  - id: charles
    container: dev
    fills_roles: []
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

/**
 * Workflow with a two-command "review" state for concurrent-command tests.
 * `approve → done` and `reject → implementation` are both legal from `review`.
 */
const WORKFLOW_YAML = `
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
        to: review
  - id: review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
      - command: reject
        to: implementation
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const AGENTS_JSON = JSON.stringify({
  agents: [
    { name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
    { name: "hanzo", linearUserId: "u2", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
    { name: "astrid", linearUserId: "u3", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
  ],
});

function setupConfigFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, "agents.json"), AGENTS_JSON, "utf8");
  fs.writeFileSync(path.join(dir, "policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(path.join(dir, "dev-impl.yaml"), WORKFLOW_YAML, "utf8");
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
}

/**
 * Minimal Express app that routes all requests through handleProxyRequest.
 * Avoids createApp() and its SQLite dependencies.
 */
function createProxyApp(): express.Application {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        try { req.body = JSON.parse(req.body.toString("utf8")); } catch { /* leave as-is */ }
      }
      next();
    },
  );
  app.post("/proxy/graphql", async (req, res) => {
    await handleProxyRequest(req, res);
  });
  return app;
}

/** In-memory EventStore stand-in — no SQLite required. */
class MemoryEventStore implements Pick<EventStore, "isDuplicate" | "recordEvent" | "close"> {
  private seen = new Map<string, object>();
  isDuplicate(id: string): boolean { return this.seen.has(id); }
  recordEvent(id: string, payload: object): void { this.seen.set(id, payload); }
  close(): void { /* no-op */ }
  get size(): number { return this.seen.size; }
}

// B1 label mock responses
const IMPLEMENTATION_LABEL_RESPONSE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u1" },
    },
  },
};

const REVIEW_LABEL_RESPONSE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:review" }] },
      delegate: { id: "u1" },
    },
  },
};

// ── AC1 (G-8) webhook: same delivery → single effect ──────────────────────

const WEBHOOK_SECRET = "test-idempotency-secret";
function signWebhook(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(Buffer.from(body)).digest("hex");
}

describe("AC1 (G-8) — webhook replay: same delivery ID → single dispatch", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = process.env;
    process.env = { ...savedEnv, LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("second delivery with same x-linear-delivery ID is suppressed as duplicate", async () => {
    const store = new MemoryEventStore();
    const app = express();
    app.use(
      express.raw({ type: "application/json", limit: "1mb" }),
      (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        if (Buffer.isBuffer(req.body)) {
          (req as express.Request & { rawBody?: Buffer }).rawBody = req.body;
        }
        next();
      },
    );
    app.use("/", createWebhookRouter(store as unknown as EventStore));

    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      createdAt: "2026-06-14T10:00:00.000Z",
      actor: { id: "actor-1", name: "Charles" },
      data: {
        id: "issue-ai1548",
        identifier: "AI-1548",
        title: "Idempotency test ticket",
        state: { id: "s1", name: "In Progress", type: "started" },
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-ai", key: "AI" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/AI-1548",
        delegate: { id: "u1", name: "Charles" },
        createdAt: "2026-06-14T09:00:00.000Z",
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    });
    const sig = signWebhook(payload);
    const deliveryId = "replay-delivery-001";

    const r1 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sig)
      .set("x-linear-delivery", deliveryId)
      .send(payload);

    expect(r1.status).toBe(200);
    expect(r1.body.duplicate).toBeUndefined();

    const r2 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sig)
      .set("x-linear-delivery", deliveryId)
      .send(payload);

    // AC1: the second delivery must be suppressed as a duplicate — single effect.
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    // EventStore recorded exactly one event (the first delivery).
    expect(store.size).toBe(1);
  });
});

// ── AC1 (G-8) proxy: concurrent identical commands → single forward ────────

describe("AC1 (G-8) — proxy command replay: concurrent identical commands → single upstream forward", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = process.env;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1548-ac1-proxy-"));
    setupConfigFiles(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * AC1: replay each transition event twice → single effect.
   *
   * Two identical `submit` commands on the same `implementation` ticket are
   * fired concurrently. Without per-ticket locking, both pass B1 (both see
   * `state:implementation` before either B2 fires) and both forward to Linear,
   * producing two upstream mutations.
   *
   * EXPECTED after implementation: forwardCount === 1.
   * CURRENT BEHAVIOR: forwardCount === 2 → test FAILS (red).
   */
  it("two concurrent identical commands produce exactly one upstream Linear forward", async () => {
    let b1FetchCount = 0;
    let forwardCount = 0;
    const app = createProxyApp();

    globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; operationName?: string };
      const q = parsed.query ?? "";

      // B1 label check (IssueContext / IssueWithLabels).
      if (q.includes("IssueContext") || q.includes("IssueLabels") || q.includes("IssueWithLabels")) {
        b1FetchCount++;
        if (b1FetchCount === 1) {
          // Delay first call so the second concurrent request also starts B1 before either B2 fires.
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        return new Response(JSON.stringify(IMPLEMENTATION_LABEL_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // B2 atomic transition — succeed but don't count as a forward.
      if (q.includes("ApplyAtomicTransition")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // TeamStates (native-state resolution by B2).
      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "st-todo", name: "To Do", type: "unstarted" },
                    { id: "st-done", name: "Done", type: "completed" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // IssueBranchAndPR (deploy gate, not needed here).
      if (q.includes("IssueBranchAndPR")) {
        return new Response(
          JSON.stringify({ data: { issue: { branch: null, pullRequests: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Everything else is the actual upstream forward.
      forwardCount++;
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const makeSubmitRequest = () =>
      request(app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-charles")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "submit")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
        .send({
          query: "mutation SubmitWork($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
          variables: { id: "issue-uuid" },
        });

    await Promise.all([makeSubmitRequest(), makeSubmitRequest()]);

    // AC1: exactly one upstream Linear forward must have occurred.
    // CURRENTLY FAILS: without locking both pass B1 and both forward (forwardCount === 2).
    expect(forwardCount).toBe(1);
  });
});

// ── AC2 (G-8): Overlay must not overwrite authoritative terminal write ─────

const SEMANTIC_TO_UUID: Record<string, string> = {
  "To Do": "state-todo-uuid",
  Thinking: "state-thinking-uuid",
  Doing: "state-doing-uuid",
  Done: "state-done-uuid",
};

describe("AC2 (G-8) — overlay/transition race: authoritative terminal write wins", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetNativeStateCache();
  });

  /**
   * AC2: interleave overlay + transition writes → authoritative write wins.
   *
   * Scenario: the engagement overlay starts executing (fetchIssue) BEFORE B2
   * has written `state:done`. It sees stale non-terminal labels and proceeds
   * toward writing "Doing". Meanwhile B2 atomically writes `state:done` + Done.
   * A pre-write re-check (the implementation fix) must detect the terminal
   * label and abort the overlay write.
   *
   * Mock call sequence:
   *   Call 1 (EngagementIssue): stale non-terminal labels — overlay decides to proceed.
   *   Call 2 (EngagementIssue, pre-write re-check added by fix): terminal labels — bail.
   *
   * EXPECTED after implementation: updates.length === 0 (overlay skips write).
   * CURRENT BEHAVIOR: updates.length === 1 (no re-check, overlay writes) → FAILS.
   */
  it("overlay with stale non-terminal read must not overwrite terminal transition written by B2", async () => {
    const updates: Array<{ id: string; stateId: string }> = [];
    let engagementIssueFetchCount = 0;

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      const q = parsed.query ?? "";
      const vars = parsed.variables ?? {};

      if (q.includes("EngagementIssue")) {
        engagementIssueFetchCount++;
        if (engagementIssueFetchCount === 1) {
          // Stale read: overlay starts before B2 writes state:done.
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "issue-uuid",
                  team: { id: "team-uuid" },
                  state: { id: "state-todo-uuid", name: "To Do" },
                  labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Pre-write re-check (call ≥ 2): B2 has written state:done between the initial
        // fetch and the issueUpdate. The implementation must make this second fetch and
        // bail when it sees the terminal label.
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-uuid",
                team: { id: "team-uuid" },
                state: { id: "state-done-uuid", name: "Done" },
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({
                    id,
                    name,
                    type: name === "Done" ? "completed" : "started",
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueUpdate")) {
        const stateId = vars.stateId ?? (vars.input as Record<string, unknown> | undefined)?.stateId;
        updates.push({ id: String(vars.id ?? vars.issueId ?? "?"), stateId: String(stateId ?? "?") });
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await applyEngagementStatus("AI-1548", "doing", "tok");

    // AC2: the authoritative terminal write (Done, by B2) must win.
    // The overlay must NOT emit any issueUpdate after the re-check sees state:done.
    // CURRENTLY FAILS: no pre-write re-check → overlay writes "Doing" → updates.length === 1.
    expect(updates).toHaveLength(0);

    // The implementation must have made a second EngagementIssue fetch (the re-check).
    expect(engagementIssueFetchCount).toBeGreaterThanOrEqual(2);
  });

  /**
   * AC2 (control): overlay reading ALREADY-terminal labels on first fetch must still skip.
   * Verifies the existing AI-1540 guard remains intact after any refactor.
   * PASSES with current code.
   */
  it("overlay reading terminal labels on first fetch is a no-op (existing AI-1540 guard)", async () => {
    const updates: Array<unknown> = [];

    globalThis.fetch = async (_url, init) => {
      const q = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string }).query ?? "";

      if (q.includes("EngagementIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-uuid",
                team: { id: "team-uuid" },
                state: { id: "state-done-uuid", name: "Done" },
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("issueUpdate")) {
        updates.push(true);
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await applyEngagementStatus("AI-1548", "doing", "tok");

    expect(updates).toHaveLength(0);
  });
});

// ── AC3 (G-16): Concurrent distinct commands → first-wins ─────────────────

describe("AC3 (G-16) — concurrent distinct commands: exactly one applies, loser gets post-first legal set", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = process.env;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1548-ac3-"));
    setupConfigFiles(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * AC3: two legal-from-current transitions fired concurrently → exactly one
   *   applies; loser rejected with the post-first legal set named.
   *
   * Ticket is in `review` (legal moves: approve → done, reject → implementation).
   * `approve` and `reject` are fired simultaneously. Without per-ticket locking,
   * both pass B1 (both see `review` before either B2 fires) and both forward —
   * resulting in two upstream Linear mutations and a state split.
   *
   * EXPECTED after implementation:
   *   - forwardCount === 1 (exactly one upstream forward).
   *   - One request succeeds; the other is rejected.
   *   - The rejected request's error names the POST-FIRST legal set (the moves
   *     legal from the state the winner transitioned into), NOT `review`'s moves.
   *
   * CURRENT BEHAVIOR: both requests succeed (forwardCount === 2) → test FAILS.
   */
  it("approve + reject concurrent on review ticket: exactly one upstream forward, loser named with post-first legal set", async () => {
    let b1FetchCount = 0;
    let forwardCount = 0;
    // Track the current state so re-checks after the first B2 write see the new state.
    let currentStateName = "review";
    const app = createProxyApp();

    globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const q = parsed.query ?? "";

      // B1 label check — returns current state labels.
      if (q.includes("IssueContext") || q.includes("IssueLabels") || q.includes("IssueWithLabels")) {
        b1FetchCount++;
        if (b1FetchCount === 1) {
          // Delay first B1 so the second concurrent request also starts B1 before
          // either B2 fires. Both see `review` — the race condition under test.
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        const stateLabel = `state:${currentStateName}`;
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: stateLabel }] },
                delegate: { id: "u1" },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // B2 atomic transition — simulate advancing state on the first write.
      if (q.includes("ApplyAtomicTransition")) {
        if (currentStateName === "review") {
          // First B2 to fire advances the state (approve wins → done).
          currentStateName = "done";
        }
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // TeamStates.
      if (q.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "st-todo", name: "To Do", type: "unstarted" },
                    { id: "st-done", name: "Done", type: "completed" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // IssueBranchAndPR.
      if (q.includes("IssueBranchAndPR")) {
        return new Response(
          JSON.stringify({ data: { issue: { branch: null, pullRequests: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Actual upstream forward (the agent mutation).
      forwardCount++;
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const makeApproveRequest = () =>
      request(app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-charles")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "approve")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
        .send({
          query: "mutation ApproveWork($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
          variables: { id: "issue-uuid" },
        });

    const makeRejectRequest = () =>
      request(app)
        .post("/proxy/graphql")
        .set("Authorization", "Bearer tok-charles")
        .set("X-Openclaw-Agent", "charles")
        .set("X-Openclaw-Linear-Intent", "reject")
        .set("X-Openclaw-Linear-Cli-Version", "0.3.0")
        .send({
          query: "mutation RejectWork($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
          variables: { id: "issue-uuid" },
        });

    const [approveResult, rejectResult] = await Promise.all([
      makeApproveRequest(),
      makeRejectRequest(),
    ]);

    const results = [approveResult, rejectResult];
    const successes = results.filter((r) => !r.body.errors?.length);
    const failures = results.filter((r) => (r.body.errors?.length ?? 0) > 0);

    // AC3: exactly one upstream forward.
    // CURRENTLY FAILS: without locking both pass B1 and both forward (forwardCount === 2).
    expect(forwardCount).toBe(1);

    // AC3: exactly one request succeeds, the other is rejected.
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // AC3: the loser's rejection message must name the POST-FIRST legal set.
    // After `approve` wins (review → done), the legal moves are those from `done`
    // (terminal: only `escape`). The rejection must NOT list `approve` or `reject`
    // (which were legal from `review` before the first command fired).
    const errorMsg: string = failures[0].body.errors[0].message as string;
    expect(errorMsg).not.toMatch(/legal.*approve|legal.*reject/i);
  });
});
