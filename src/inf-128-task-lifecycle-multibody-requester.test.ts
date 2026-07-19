/**
 * INF-128 — wf:task full lifecycle (intake→done) with a multi-body `requester`
 * role, plus the regression that GEN-214 actually hit.
 *
 * GEN-214 (2026-07-19) looked like "review→done is unmapped": `approve`,
 * `continue-workflow` and `escape` all appeared to do nothing from `review`.
 * The workflow def was never the problem — review→sign-off→done is a real,
 * tested two-continue tail (see ai-2094-wf-task-review-signoff.test.ts AC4).
 * The actual defect was two bugs compounding on the LIVE capability-policy,
 * where `requester` is filled by TWO bodies (astrid, ai), not one:
 *
 *   1. A transition owned by a multi-body role (`approve` → sign-off, owned by
 *      `requester`) fail-closes without an explicit `--target` — correct,
 *      documented behavior (AI-1709). Astrid's dispatch loop never supplied
 *      one, so every `approve`/`escape` attempt aborted.
 *   2. The fail-close remedy comment — the ONE place the agent would have
 *      learned to re-run with `--target astrid|ai` — silently failed to post.
 *      `postComment()`'s response was discarded (fixed upstream as INF-127),
 *      AND `failDelegateUnresolved()` posted using the raw, possibly
 *      human-readable `issueId` the proxy forwarded (e.g. "GEN-214") instead
 *      of the resolved internal UUID `commentCreate` actually requires — the
 *      same two-step resolve-then-mutate pattern already used elsewhere in
 *      this codebase (see postLinearComment in index.ts). Both silently ate
 *      the remedy, so the operator saw nothing and misdiagnosed a routing gap.
 *
 * This file proves: (a) the real happy path — intake through done — works
 * end-to-end when `--target` is supplied at each multi-body-role gate, and
 * (b) the exact failure GEN-214 hit now surfaces a comment, posted against
 * the correct internal ticket id, instead of failing mute.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

// Mirrors the LIVE capability-policy shape (astrid fills BOTH department-head
// and requester; ai fills requester only) — the exact shape that made GEN-214's
// `approve`/`escape` calls hit the multi-body fail-close.
const TASK_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [department-head, requester]
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: worker1
    container: dev
    fills_roles: [worker]
  - id: worker2
    container: dev
    fills_roles: [worker]
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "user-astrid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "ai", linearUserId: "user-ai", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "worker1", linearUserId: "user-worker1", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "worker2", linearUserId: "user-worker2", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
  ],
};

const TEAM_LABELS = [
  { id: "wf-task-id", name: "wf:task" },
  { id: "state-intake-id", name: "state:intake" },
  { id: "state-routing-id", name: "state:routing" },
  { id: "state-doing-id", name: "state:doing" },
  { id: "state-review-id", name: "state:review" },
  { id: "state-signoff-id", name: "state:sign-off" },
  { id: "state-done-id", name: "state:done" },
];

const ISSUE_UUID = "11111111-2222-3333-4444-555555555555";
// The human-readable identifier the CLI/proxy forwards — deliberately NOT a
// UUID, matching what proxy.ts actually sent for GEN-214 (see connector log:
// `ticket=GEN-214 intent=approve`, not the internal id, on several attempts).
const TICKET_IDENTIFIER = "GEN-214";
const TEAM_ID = "team-uuid";

interface Captured {
  comments: Array<{ issueId: string; body: string }>;
  writes: Array<{ query: string; labelIds?: string[] }>;
}

let captured: Captured;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** `currentLabelNames` is read fresh on every IssueWithLabels call — callers reassign it between lifecycle steps. */
function makeFetch(currentLabelNames: () => string[]): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call: ${String(url)}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (query.includes("commentCreate")) {
      captured.comments.push({ issueId: String(vars.issueId ?? ""), body: String(vars.body ?? "") });
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }

    if (query.includes("IssueWithLabels") || query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: TICKET_IDENTIFIER,
            team: { id: TEAM_ID },
            labels: { nodes: currentLabelNames().map((name) => ({ id: `${name}-id`, name })) },
            delegate: null,
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: TEAM_LABELS } } } });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-doing-uuid", name: "Doing", type: "started" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueLabelCreate")) {
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    }

    if (query.includes("IssueBranchAndPR")) {
      return json({ data: { issue: { attachments: { nodes: [] } } } });
    }

    if (query.includes("issueUpdate") || query.includes("ApplyAtomicTransition") || query.includes("UpdateDelegate")) {
      captured.writes.push({ query: query.slice(0, 60), labelIds: (vars as { labelIds?: string[] }).labelIds });
      return json({ data: { issueUpdate: { success: true } } });
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("INF-128 — wf:task full lifecycle (multi-body requester)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalDefPath: string | undefined;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let tmpDir: string;

  beforeAll(() => {
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf128-task-lifecycle-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TASK_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");
    process.env.AGENTS_FILE = agentsFile;

    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK_FIXTURE;
  });

  afterAll(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    };
    restore("WORKFLOW_DEF_PATH", originalDefPath);
    restore("WORKFLOW_DEFS_DIR", originalDefsDir);
    restore("CAPABILITY_POLICY_PATH", originalPolicyPath);
    restore("AGENTS_FILE", originalAgentsFile);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    captured = { comments: [], writes: [] };
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("AC2: intake → routing → doing → review → sign-off → done, target supplied at every multi-body gate", async () => {
    // intake --request--> routing (department-head is a singleton: astrid; no target needed)
    globalThis.fetch = makeFetch(() => ["wf:task", "state:intake"]);
    let result = await applyStateTransition("request", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "intake",
    });
    expect(result).toMatchObject({ status: "applied", from: "intake", to: "routing" });

    // routing --assign--> doing (worker is multi-body: explicit target required)
    globalThis.fetch = makeFetch(() => ["wf:task", "state:routing"]);
    result = await applyStateTransition("assign", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "routing",
      cliTarget: "worker1",
    });
    expect(result).toMatchObject({ status: "applied", from: "routing", to: "doing" });

    // doing --submit--> review (department-head singleton auto-assigns; no target needed)
    globalThis.fetch = makeFetch(() => ["wf:task", "state:doing"]);
    result = await applyStateTransition("submit", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "worker1",
      sourceStateOverride: "doing",
    });
    expect(result).toMatchObject({ status: "applied", from: "doing", to: "review" });

    // review --approve--> sign-off (requester is multi-body: explicit target required)
    globalThis.fetch = makeFetch(() => ["wf:task", "state:review"]);
    result = await applyStateTransition("approve", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "review",
      cliTarget: "astrid",
    });
    expect(result).toMatchObject({ status: "applied", from: "review", to: "sign-off" });
    expect(captured.comments).toEqual([]); // happy path never posts a delegate-unresolved remedy

    // sign-off --accept--> done (requester is multi-body: explicit target required)
    globalThis.fetch = makeFetch(() => ["wf:task", "state:sign-off"]);
    result = await applyStateTransition("accept", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "sign-off",
      cliTarget: "astrid",
    });
    expect(result).toMatchObject({ status: "applied", from: "sign-off", to: "done" });
    expect(captured.comments).toEqual([]);
  });

  // ── The GEN-214 regression ────────────────────────────────────────────────
  describe("GEN-214 regression: approve on review with no --target", () => {
    it("fails closed (NOT a silent no-op, and not 'review→done unmapped') and posts the --target remedy", async () => {
      globalThis.fetch = makeFetch(() => ["wf:task", "state:review"]);

      const result = await applyStateTransition("approve", TICKET_IDENTIFIER, "Bearer tok", {
        bodyId: "astrid",
        sourceStateOverride: "review",
        // no cliTarget — exactly what Astrid's dispatch loop sent on GEN-214
      });

      expect(result.status).toBe("failed");
      expect(result.code).toBe("delegate-unresolved");
      expect(captured.writes).toEqual([]); // no half-applied label/delegate write

      // The remedy comment must actually land — this is the INF-127/INF-128 fix.
      expect(captured.comments).toHaveLength(1);
      const comment = captured.comments[0];
      expect(comment.body).toContain("--target");
      expect(comment.body).toContain("astrid");
      expect(comment.body).toContain("ai");

      // INF-128: commentCreate must be called with the resolved INTERNAL uuid,
      // never the raw human-readable identifier the proxy forwarded — Linear's
      // commentCreate rejects/silently drops non-UUID issueId (see
      // postLinearComment's resolve-then-mutate two-step in index.ts).
      expect(comment.issueId).toBe(ISSUE_UUID);
      expect(comment.issueId).not.toBe(TICKET_IDENTIFIER);
    });

    it("recovers when re-run with the target the remedy comment named", async () => {
      globalThis.fetch = makeFetch(() => ["wf:task", "state:review"]);
      const result = await applyStateTransition("approve", TICKET_IDENTIFIER, "Bearer tok", {
        bodyId: "astrid",
        sourceStateOverride: "review",
        cliTarget: "ai",
      });
      expect(result).toMatchObject({ status: "applied", from: "review", to: "sign-off" });
    });
  });
});
