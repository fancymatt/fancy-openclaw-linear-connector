/**
 * INF-12 — `delegate-unresolved` fail-close must not be mute.
 *
 * `applyStateTransition` has five `delegate-unresolved` fail-close returns.
 * Before this change exactly one of them (the singleton path) told the agent
 * why; the other four logged server-side and returned silently. A mute
 * fail-close is indistinguishable from a hang, so agents retry instead of
 * correcting — the root cause of the LIF-7 decline loop (5 declines across
 * three sessions, then a demotion to Backlog to stop the re-dispatch).
 *
 * Every reason string is already computed at every site. These tests assert it
 * reaches the ticket.
 *
 * WHAT THESE TESTS ARE FOR (read before editing):
 *   1. A comment is posted on each fail-close path, naming the specific cause.
 *   2. Fail-close semantics are UNCHANGED — still `failed`/`delegate-unresolved`,
 *      and ZERO applied writes on the failure path. Do not relax the write
 *      assertions to make a change pass; the fail-close is load-bearing
 *      (AI-1709) and this suite is what keeps a "helpful" auto-pick out.
 *
 * The mute paths are asserted through the real `applyStateTransition` rather
 * than a extracted helper on purpose: the muteness only exists in the wiring,
 * so a unit test of a helper would pass while production stayed silent.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { clearImplementerStore, recordImplementer } from "./implementer-store.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Roles are shaped to hit each resolution branch:
 *   solo-role  → exactly 1 body  (singleton; body has NO linearUserId)
 *   duo-role   → 2 bodies        (multi-body; requires --target)
 *   ghost-role → 0 bodies        (no bodies found)
 */
const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
  - id: worker
    grants: [linear:transition]
roles:
  - id: steward
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: solo
    container: worker
    fills_roles: [solo-role]
  - id: alpha
    container: worker
    fills_roles: [duo-role]
  - id: beta
    container: worker
    fills_roles: [duo-role]
`;

/**
 * `to-ghost` uses `approve` deliberately: the zero-body path only fails closed
 * for approve/reject (AI-1493); every other intent warns and skips.
 * `to-prior` carries `assign.default: prior-implementer` to reach that branch.
 */
const TEST_WORKFLOW_YAML = `
id: inf12
version: 1
archetype: single-task
entry_state: intake

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: to-solo
        to: solo-state
      - command: to-duo
        to: duo-state
      - command: approve
        to: ghost-state
      - command: to-prior
        to: duo-state
        assign:
          default: prior-implementer

  - id: solo-state
    owner_role: solo-role
    kind: normal
    native_state: doing
    transitions: []

  - id: duo-state
    owner_role: duo-role
    kind: normal
    native_state: doing
    transitions: []

  - id: ghost-state
    owner_role: ghost-role
    kind: normal
    native_state: doing
    transitions: []
`;

/** `solo` and `stale-impl` deliberately have NO linearUserId — the failure condition. */
const AGENTS_JSON = {
  agents: [
    { name: "alpha", linearUserId: "user-alpha", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
    { name: "beta", linearUserId: "user-beta", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
    { name: "solo", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
    { name: "stale-impl", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
  ],
};

const ISSUE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEST_IDENTIFIER = "INF-12";
const TEAM_ID = "team-uuid";

let dir: string;
let policyFile: string;

const ORIG_ENV = {
  CAPABILITY_POLICY_PATH: process.env.CAPABILITY_POLICY_PATH,
  WORKFLOW_DEF_PATH: process.env.WORKFLOW_DEF_PATH,
  AGENTS_FILE: process.env.AGENTS_FILE,
  IMPLEMENTER_STORE_PATH: process.env.IMPLEMENTER_STORE_PATH,
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-12-"));

  policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");

  const wfFile = path.join(dir, "workflow.yaml");
  fs.writeFileSync(wfFile, TEST_WORKFLOW_YAML, "utf8");

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");

  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.WORKFLOW_DEF_PATH = wfFile;
  process.env.AGENTS_FILE = agentsFile;
  // The implementer store defaults to a REAL shared /tmp/implementer-store.json.
  // Pin it, or a stale record from another run leaks into these assertions.
  process.env.IMPLEMENTER_STORE_PATH = path.join(dir, "implementer-store.json");
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Linear mock ────────────────────────────────────────────────────────────

interface Captured {
  comments: Array<{ issueId: string; body: string }>;
  /** Any mutation that would mutate the ticket's state/labels/delegate. */
  writes: string[];
}

let captured: Captured;

function makeFetch(labels: string[], opts: { policyUnreadable?: boolean } = {}): typeof globalThis.fetch {
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call: ${String(url)}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (query.includes("commentCreate")) {
      captured.comments.push({
        issueId: String(vars.issueId ?? ""),
        body: String(vars.body ?? ""),
      });
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }

    if (query.includes("IssueContext") || query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: TEST_IDENTIFIER,
            team: { id: TEAM_ID },
            labels: { nodes: labels.map((name) => ({ id: `${name}-id`, name })) },
            delegate: null,
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
                { id: "wf-inf12-id", name: "wf:inf12" },
                { id: "state:intake-id", name: "state:intake" },
                { id: "state:solo-state-id", name: "state:solo-state" },
                { id: "state:duo-state-id", name: "state:duo-state" },
                { id: "state:ghost-state-id", name: "state:ghost-state" },
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

    // Anything that mutates the ticket is a WRITE — the fail-close must produce none.
    if (query.includes("issueUpdate") || query.includes("ApplyAtomicTransition") || query.includes("UpdateDelegate")) {
      captured.writes.push(query.slice(0, 60));
      return json({ data: { issueUpdate: { success: true } } });
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = { comments: [], writes: [] };
  originalFetch = globalThis.fetch;
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
  clearImplementerStore();
  _resetAppliedStateStore();
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  reloadAgents();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Every fail-close path shares this contract, regardless of which one fired. */
function expectFailClosedWithNoWrites(result: { status: string; code: string }) {
  expect(result.status).toBe("failed");
  expect(result.code).toBe("delegate-unresolved");
  expect(captured.writes).toEqual([]);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("INF-12: every delegate-unresolved fail-close names its cause on the ticket", () => {
  it("multi-body role with no --target: comments naming the role AND its bodies", async () => {
    globalThis.fetch = makeFetch(["wf:inf12", "state:intake"]);

    const result = await applyStateTransition("to-duo", ISSUE_UUID, "Bearer tok", { bodyId: "astrid" });

    expectFailClosedWithNoWrites(result);
    expect(captured.comments).toHaveLength(1);
    const body = captured.comments[0].body;
    expect(body).toContain("duo-role");
    // AC: the caller must be able to pick a --target without reading agents.json.
    expect(body).toContain("alpha");
    expect(body).toContain("beta");
    expect(body).toContain("--target");
  });

  it("prior implementer with no linearUserId: comments naming the implementer", async () => {
    await recordImplementer(ISSUE_UUID, "stale-impl", "inf12");
    globalThis.fetch = makeFetch(["wf:inf12", "state:intake"]);

    const result = await applyStateTransition("to-prior", ISSUE_UUID, "Bearer tok", { bodyId: "astrid" });

    expectFailClosedWithNoWrites(result);
    expect(captured.comments).toHaveLength(1);
    expect(captured.comments[0].body).toContain("stale-impl");
    expect(captured.comments[0].body).toContain("linearUserId");
  });

  it("no bodies for role: comments naming the unfilled role", async () => {
    globalThis.fetch = makeFetch(["wf:inf12", "state:intake"]);

    const result = await applyStateTransition("approve", ISSUE_UUID, "Bearer tok", { bodyId: "astrid" });

    expectFailClosedWithNoWrites(result);
    expect(captured.comments).toHaveLength(1);
    expect(captured.comments[0].body).toContain("ghost-role");
  });

  it("role resolution throws: comments naming the role and the error", async () => {
    // An unreadable policy makes loadPolicy (and so resolveBodiesForRole) throw.
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "does-not-exist.yaml");
    resetPolicyCache();
    globalThis.fetch = makeFetch(["wf:inf12", "state:intake"]);

    const result = await applyStateTransition("to-duo", ISSUE_UUID, "Bearer tok", { bodyId: "astrid" });

    expectFailClosedWithNoWrites(result);
    expect(captured.comments).toHaveLength(1);
    expect(captured.comments[0].body).toContain("duo-role");
  });

  it("singleton body with no linearUserId: keeps its existing comment verbatim", async () => {
    // This path was already correct. It is pinned here so the refactor that
    // gives the other four the same courtesy cannot quietly reword it.
    globalThis.fetch = makeFetch(["wf:inf12", "state:intake"]);

    const result = await applyStateTransition("to-solo", ISSUE_UUID, "Bearer tok", { bodyId: "astrid" });

    expectFailClosedWithNoWrites(result);
    expect(captured.comments).toHaveLength(1);
    expect(captured.comments[0].body).toBe(
      "[Connector] Transition blocked: singleton body 'solo' for role 'solo-role' has no linearUserId in agents.json. Register the agent's Linear user ID to proceed.",
    );
  });
});

describe("INF-12: the fail-close itself is unchanged", () => {
  it("a resolvable multi-body role still transitions when --target is supplied (no over-blocking)", async () => {
    globalThis.fetch = makeFetch(["wf:inf12", "state:intake"]);

    const result = await applyStateTransition("to-duo", ISSUE_UUID, "Bearer tok", {
      bodyId: "astrid",
      cliTarget: "alpha",
    });

    // The point: the comment paths must not fire on the happy path, and the
    // transition must still apply. A fix that comments on success is wrong.
    expect(result.status).toBe("applied");
    expect(captured.comments).toEqual([]);

    // POSITIVE CONTROL for every `expect(captured.writes).toEqual([])` above.
    // Those assertions are only meaningful if this mock actually records writes
    // when a write happens — an empty array proves nothing about a detector that
    // never fires. This is the test that gives the other four their teeth.
    expect(captured.writes.length).toBeGreaterThan(0);
  });
});
