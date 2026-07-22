/**
 * INF-310 — Merge-gate PR-evidence check fails on non-Linear branch names.
 *
 * These tests are FAILING by design. They cover the acceptance criteria
 * the implementation (Igor) must satisfy.
 *
 * Bug summary: The deploy-state evidence gate (merged-PR check) only fires
 * on `intent === 'deploy'` or `intent === 'handoff-host-deploy'`. In the v10
 * dev-impl workflow, `continue-workflow` from the deploy state resolves to
 * the `continue` command (generic: continue). So the evidence check is dead
 * code for the v10 deploy→ac-validate transition — it never fires.
 *
 * Additionally, `fetchBranchAndPRStatus()` checks `metadata.status === "merged"`
 * for `hasMergedPR`. Manually-attached PRs via `attachmentCreate` have
 * `sourceType: null` and `metadata: null`, so `hasMergedPR` is false even
 * though the PR is genuinely merged on main. The fix must accept a GitHub
 * PR URL attachment as valid evidence even without merged metadata.
 *
 * Test strategy: each AC test asserts BOTH:
 *   (a) the positive case — manual attachment / non-Linear branch → gate passes
 *   (b) the negative companion — no PR evidence at all → gate BLOCKS
 *
 * The negative companion (b) is what makes each test FAIL on the current
 * code: since the evidence check doesn't fire on `continue`, the gate
 * returns null even when there's no PR evidence. Once the implementation
 * adds the evidence check to fire on `continue` from deploy state, both
 * halves pass.
 *
 * AC-to-test mapping:
 *   AC1: Merged PR with non-Linear branch name → gate accepts + negative companion
 *   AC2: attachmentCreate PR satisfies check + negative companion
 *   AC3: No merged PR → gate blocks (standalone negative guard)
 *   AC4: LIF-176 regression + negative companion
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";

// ── Fixture path ─────────────────────────────────────────────────────────────

const CANONICAL_FIXTURE = path.resolve(
  process.cwd(),
  "src/__fixtures__/canonical-dev-impl.yaml",
);

// ── Capability policy ────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute
  - id: infra:ssh
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: host-deploy
    requires: [infra:ssh]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const AGENTS_JSON = {
  agents: [
    { name: "hanzo", linearUserId: "hanzo-uuid", clientId: "h-c", clientSecret: "h-s", accessToken: "h-t", refreshToken: "h-r" },
    { name: "grover", linearUserId: "grover-uuid", clientId: "g-c", clientSecret: "g-s", accessToken: "g-t", refreshToken: "g-r" },
    { name: "astrid", linearUserId: "astrid-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
    { name: "igor", linearUserId: "igor-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
  ],
};

// ── Constants ────────────────────────────────────────────────────────────────

const ISSUE_ID = "inf-310-issue-uuid";
const AUTH_TOKEN = "Bearer test-token";
const BODY_ID = "grover"; // host-deploy — holds infra:ssh (deploy state's continue requires it)
const CALLER_LUID = "grover-uuid";

const DEPLOY_LABELS = [
  { id: "lbl-wf", name: "wf:dev-impl" },
  { id: "lbl-state", name: "state:deploy" },
];

// ── Mock fetch ───────────────────────────────────────────────────────────────

type AttachmentNode = {
  url?: string | null;
  sourceType?: string | null;
  metadata?: Record<string, unknown> | null;
};

interface MockFetchOpts {
  issueLabels?: Array<{ id: string; name: string }>;
  delegateId?: string;
  branchStatus?: { hasBranch?: boolean; hasPR?: boolean; hasMergedPR?: boolean } | null;
  /** Override: exact attachment nodes for IssueBranchAndPR. */
  attachments?: AttachmentNode[];
}

function makeMockFetch(opts: MockFetchOpts): typeof globalThis.fetch {
  const issueLabels = opts.issueLabels ?? DEPLOY_LABELS;
  const delegateId = opts.delegateId ?? CALLER_LUID;
  const branch = opts.branchStatus ?? { hasBranch: true, hasPR: true, hasMergedPR: true };

  return (async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const q = parsed.query ?? "";

    if (q.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: issueLabels.map((l) => ({ name: l.name })) },
              delegate: { id: delegateId },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("IssueWithLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              identifier: "INF-310",
              team: { id: "team-uuid" },
              labels: { nodes: issueLabels },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "s1", name: "Backlog", type: "unstarted" },
                  { id: "s2", name: "Todo", type: "unstarted" },
                  { id: "s3", name: "Doing", type: "started" },
                  { id: "s4", name: "Thinking", type: "started" },
                  { id: "s5", name: "Managing", type: "started" },
                  { id: "s6", name: "Done", type: "completed" },
                  { id: "s7", name: "Invalid", type: "canceled" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "nl" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("ApplyAtomicTransition") || q.includes("issueUpdate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("UpdateDelegate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("IssueBranchAndPR")) {
      if (branch === null) throw new Error("simulated branch/PR fetch error");
      let nodes: AttachmentNode[];
      if (opts.attachments !== undefined) {
        nodes = opts.attachments;
      } else {
        const prState = branch.hasMergedPR ? "merged" : "open";
        nodes = branch.hasPR
          ? [{ url: "https://github.com/fancymatt/repo/pull/1", sourceType: "github", metadata: { status: prState } }]
          : [];
      }
      return new Response(
        JSON.stringify({ data: { issue: { attachments: { nodes } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("IssueRepoAttachments")) {
      return new Response(
        JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected query: ${q.slice(0, 120)}`);
  }) as typeof globalThis.fetch;
}

// ── Shared test state ────────────────────────────────────────────────────────

let dir: string;
let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-310-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");
  process.env.AGENTS_FILE = agentsFile;

  process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;

  reloadAgents();
  savedFetch = globalThis.fetch;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.WORKFLOW_DEF_PATH;
  globalThis.fetch = savedFetch;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Run the deploy-state evidence gate with the given attachments.
 * In v10 dev-impl, the deploy state's exit command is `continue` (generic: continue),
 * resolved from `continue-workflow`. The evidence check must fire on this intent.
 */
function runDeployGate(opts: MockFetchOpts) {
  globalThis.fetch = makeMockFetch(opts);
  return checkWorkflowRules(
    "continue",   // resolved from continue-workflow in v10 deploy state
    ISSUE_ID,
    AUTH_TOKEN,
    BODY_ID,
    null,
    CALLER_LUID,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("INF-310: Merge-gate PR-evidence check with non-Linear branch names", () => {

  /**
   * AC1: A ticket whose merged PR uses a branch name different from Linear's
   * generated name advances past merge-gate via continue-workflow without
   * break-glass, given a real merged PR on the default branch.
   *
   * Test (a): manual attachment with null metadata → gate MUST PASS.
   * Test (b): NO attachment at all → gate MUST BLOCK (proves the gate is running).
   *
   * FAILS on current code: test (b) fails because the evidence gate doesn't
   * fire on `continue` from deploy state. The gate returns null (pass) even
   * when there's zero PR evidence.
   */
  it("AC1a: merged PR with non-Linear branch name passes deploy gate", async () => {
    const result = await runDeployGate({
      attachments: [
        {
          url: "https://github.com/fancymatt/repo/pull/42",
          sourceType: null,
          metadata: null,
        },
      ],
    });
    expect(result).toBeNull();
  });

  it("AC1b: no PR evidence blocks deploy gate (companion negative)", async () => {
    const result = await runDeployGate({
      attachments: [], // no PR at all
    });
    // Must block — no PR evidence means the gate is running and rejecting.
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  /**
   * AC2: A PR attached via attachmentCreate (pointing to a merged PR)
   * satisfies the evidence check.
   *
   * Test (a): manual attachmentCreate attachment → gate MUST PASS.
   * Test (b): NO attachment → gate MUST BLOCK (proves gate is running).
   */
  it("AC2a: attachmentCreate PR satisfies evidence check", async () => {
    const result = await runDeployGate({
      attachments: [
        {
          url: "https://github.com/fancymatt/connector/pull/99",
          sourceType: null,
          metadata: null,
        },
      ],
    });
    expect(result).toBeNull();
  });

  it("AC2b: no PR evidence blocks (companion negative)", async () => {
    const result = await runDeployGate({
      attachments: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  /**
   * AC3: Negative case preserved — a ticket with NO merged PR still blocks.
   *
   * FAILS on current code: the evidence gate doesn't fire on `continue`,
   * so it returns null instead of blocking.
   */
  it("AC3: no merged PR evidence blocks the deploy gate", async () => {
    const result = await runDeployGate({
      attachments: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  /**
   * AC4: Regression test reproducing the LIF-176 scenario.
   *
   * LIF-176: Hanzo merged a PR whose branch name didn't match Linear's
   * auto-generated name. Manual attachmentCreate had null metadata.
   * This forced break-glass (escape).
   *
   * Test (a): manual attachment (LIF-176 scenario) → gate MUST PASS.
   * Test (b): NO attachment → gate MUST BLOCK (proves gate is running).
   */
  it("AC4a: LIF-176 regression — mismatched branch + valid merged PR passes", async () => {
    const result = await runDeployGate({
      attachments: [
        {
          // Branch "fix/lif-176-merge-gate-evidence" (not Linear's name).
          // PR squash-merged to main. Manually attached via attachmentCreate.
          url: "https://github.com/fancymatt/repo/pull/77",
          sourceType: null,
          metadata: null,
        },
      ],
    });
    expect(result).toBeNull();
  });

  it("AC4b: no PR evidence blocks (LIF-176 companion negative)", async () => {
    const result = await runDeployGate({
      attachments: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });
});
