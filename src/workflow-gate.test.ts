/**
 * Unit tests for workflow-gate enforcement (AI-1352 Phase 3 / B1)
 * and state-label transition application (AI-1353 Phase 3 / B2).
 *
 * Retargeted to the 5-state dev-impl shape (AI-1356, 2026-06-06):
 *   intake → implementation → code-review → deployment → done (+escape).
 *   capability repo:merge → deploy:execute; role/container merge-gate →
 *   deployment; command merge → deploy. A state is a work-phase; a
 *   transition is a decision (the old approved/merged/changes-requested
 *   "resting places" collapsed into transitions).
 *
 * Uses minimal in-memory YAML files injected via WORKFLOW_DEF_PATH and
 * CAPABILITY_POLICY_PATH so tests never depend on vault / project paths.
 *
 * Includes a suite that exercises the canonical-schema fixture
 * (src/__fixtures__/canonical-dev-impl.yaml — verbatim copy of the vault
 * source) to catch parser / schema drift before it reaches production.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkWorkflowRules,
  applyStateTransition,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// Resolved from the project root (jest cwd) so it works under both the
// ESM tsc build and the CommonJS ts-jest transpile.
const CANONICAL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

// ── Minimal test capability policy ────────────────────────────────────────
// Includes deploy:execute so we can test the deployment capability gate.

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// ── Minimal test workflow def ──────────────────────────────────────────────

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
      - command: demote
        to: __ad_hoc__

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

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gate-test-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url, _init) => {
    const body = {
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
        },
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("checkWorkflowRules — mode switch", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns null when issueId is null (fail open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("submit", null, "Bearer tok", "charles")).toBeNull();
  });

  it("returns null for ad-hoc ticket (no wf:* label) — §4.6 mode switch", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    expect(await checkWorkflowRules("anything", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null for unknown workflow id (wf:other-workflow) — fail open", async () => {
    globalThis.fetch = makeLabelFetch(["wf:other-workflow", "state:implementation"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null when label fetch throws — fail open", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("returns null when no state:* label — fail open", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "bug"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });
});

// ── Break-glass ────────────────────────────────────────────────────────────

describe("checkWorkflowRules — break-glass escape", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const allStates = [
    "intake", "implementation", "code-review", "deployment", "done",
  ];

  for (const state of allStates) {
    it(`escape is always legal from state '${state}' (§4.4)`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles")).toBeNull();
    });
  }
});

// ── Per-state legal / illegal commands ────────────────────────────────────

describe("checkWorkflowRules — intake state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'accept' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    expect(await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("allows 'demote' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });

  it("blocks 'submit' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("submit");
    expect(result).toContain("intake");
    expect(result).toContain("accept");
  });

  it("blocks 'deploy' in intake", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy");
    expect(result).toContain("intake");
  });
});

describe("checkWorkflowRules — implementation state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'submit' in implementation", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'deploy' in implementation", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
  });

  it("blocks 'approve' in implementation (not at review)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("approve");
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });
});

describe("checkWorkflowRules — code-review state", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'approve' in code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    expect(await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("allows 'request-changes' in code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    expect(await checkWorkflowRules("request-changes", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("blocks 'deploy' in code-review", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("code-review");
  });

  it("blocks 'submit' in code-review (wrong phase — already submitted)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("code-review");
    expect(result).toContain("approve");
    expect(result).toContain("request-changes");
  });
});

// ── Deploy capability gate (Hanzo-only) ────────────────────────────────────

describe("checkWorkflowRules — deploy capability gate (deployment state)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows 'deploy' from Hanzo (deployment body) in deployment state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });

  it("blocks 'deploy' from Charles (dev body, no deploy:execute) in deployment state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("deploy:execute");
    expect(result).toContain("deployment");
  });

  it("blocks 'deploy' from Astrid (steward body, no deploy:execute) in deployment state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy:execute");
  });

  it("blocks illegal command 'submit' in deployment state even for Hanzo", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("deployment");
    expect(result).toContain("deploy");
  });
});

// ── done state (terminal) ───────────────────────────────────────────────────

describe("checkWorkflowRules — done state (terminal)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks any non-escape command in done state (terminal)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("done");
  });

  it("escape is still legal in done state (§4.4)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    expect(await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
  });
});

// ── Error message content ──────────────────────────────────────────────────

describe("checkWorkflowRules — error message format", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("names the legal moves in the rejection for an illegal command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "charles");
    expect(result).toContain("submit");
    expect(result).toContain("escape");
  });
});

// ── Canonical vault schema fixture ────────────────────────────────────────
// These tests load the verbatim checked-in copy of the vault YAML
// (src/__fixtures__/canonical-dev-impl.yaml) to guard against parser/schema
// drift between the simplified test fixtures above and what actually runs in
// production. If these fail, the canonical YAML drifted or the parser broke.

describe("checkWorkflowRules — canonical vault schema (src/__fixtures__/canonical-dev-impl.yaml)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPath: string | undefined;

  beforeAll(() => {
    originalPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
  });

  afterAll(() => {
    if (originalPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = originalPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("parses the canonical YAML without error (passes for a legal command)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // 'submit' is legal in implementation; null means pass-through
    expect(await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("canonical: escape is legal from every state (§4.4)", async () => {
    const allStates = [
      "intake", "implementation", "code-review", "deployment", "done", "escape",
    ];
    for (const state of allStates) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles");
      expect(result).toBeNull(); // state: ${state}
    }
  });

  it("canonical: deployment state allows deploy and reject (not just deploy)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    // 'reject' requires no capability — should pass through
    const result = await checkWorkflowRules("reject", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("canonical: deployment state blocks 'submit' (illegal), names deploy and reject as legal", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("deploy");
    expect(result).toContain("reject");
    expect(result).toContain("escape");
  });

  it("canonical: deploy in deployment state is blocked for non-deployment body (charles)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("deploy:execute");
    expect(result).toContain("deployment");
  });

  it("canonical: deploy in deployment state is allowed for Hanzo (deployment body)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    expect(await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo")).toBeNull();
  });
});

// ── Phase 3 / B2: applyStateTransition ───────────────────────────────────
// Tests the atomic state-label swap triggered by a forwarded legal command.

type FetchCall = {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
};

/** Build a fetch mock that handles the three B2 API calls and records all calls. */
function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamId?: string;
  teamLabels?: Array<{ id: string; name: string }>;
  issueUpdateSuccess?: boolean;
  /** Override to simulate a fetch error for the issue fetch. */
  issueError?: boolean;
  /** Override to simulate a fetch error for the issueUpdate call. */
  updateError?: boolean;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const teamId = opts.teamId ?? "team-uuid";
  const teamLabels = opts.teamLabels ?? [];
  const issueUpdateSuccess = opts.issueUpdateSuccess ?? true;

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });

    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      if (opts.issueError) throw new Error("simulated fetch error");
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              team: { id: teamId },
              labels: { nodes: opts.issueLabels },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: teamLabels } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("issueLabelCreate")) {
      // Simulate label creation returning a new ID.
      return new Response(
        JSON.stringify({
          data: {
            issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("ApplyStateTransition")) {
      if (opts.updateError) throw new Error("simulated update error");
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: issueUpdateSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };

  return { fetch: mockFetch, calls };
}

describe("applyStateTransition — no-ops (fail-open / mode switch)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("is a no-op when issueId is null", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: [] });
    globalThis.fetch = mock;
    await applyStateTransition("submit", null, "Bearer tok");
    expect(calls).toHaveLength(0);
  });

  it("is a no-op for ad-hoc ticket (no wf:* label)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [{ id: "lbl-1", name: "bug" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");
    // Only the IssueWithLabels fetch should fire; no issueUpdate.
    expect(calls.some((c) => (c.body.query ?? "").includes("IssueWithLabels"))).toBe(true);
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyStateTransition"))).toBe(false);
  });

  it("is a no-op when issue fetch fails", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [],
      issueError: true,
    });
    globalThis.fetch = mock;
    // Should not throw even on fetch failure.
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toBeUndefined();
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyStateTransition"))).toBe(false);
  });

  it("is a no-op when already in target state (idempotent re-apply)", async () => {
    // implementation + submit → code-review, but if already code-review, no-op.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
    });
    globalThis.fetch = mock;
    // 'submit' transitions implementation → code-review, but ticket is already code-review.
    // The transition lookup finds 'submit' only in implementation, not code-review.
    // So this logs a warn (no transition for submit in code-review) and returns.
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyStateTransition"))).toBe(false);
  });

  it("idempotent: no issueUpdate when current state already past the command's source", async () => {
    // 'accept' lives in intake (intake → implementation). If the ticket is already
    // in implementation, a re-delivered 'accept' finds no 'accept' transition in
    // implementation → skips. No issueUpdate.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("accept", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyStateTransition"))).toBe(false);
  });
});

describe("applyStateTransition — normal state advance", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("advances state:implementation → state:code-review on 'submit'", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
        { id: "other-lbl", name: "priority:high" },
      ],
      teamLabels: [
        { id: "existing-cr-lbl", name: "state:code-review" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { issueId: string; labelIds: string[] };
    expect(vars.issueId).toBe("internal-uuid");
    // Should have: wf-lbl, other-lbl (kept), existing-cr-lbl (new state) — NOT state-lbl
    expect(vars.labelIds).toContain("wf-lbl");
    expect(vars.labelIds).toContain("other-lbl");
    expect(vars.labelIds).toContain("existing-cr-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  it("creates the target state label when it does not exist in the team", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [], // no state:code-review label yet
    });
    globalThis.fetch = mock;
    await applyStateTransition("submit", "issue-uuid", "Bearer tok");

    expect(calls.some((c) => (c.body.query ?? "").includes("issueLabelCreate"))).toBe(true);
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("new-label-id");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  it("exactly one state:* label in the new set (no double-add)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:intake" },
      ],
      teamLabels: [{ id: "impl-lbl", name: "state:implementation" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("accept", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    const stateLabelCount = vars.labelIds.filter((id) =>
      [{ id: "state-lbl", name: "state:intake" }, { id: "impl-lbl", name: "state:implementation" }]
        .map((n) => n.id)
        .includes(id),
    ).length;
    // Exactly one state label: the new one only.
    expect(stateLabelCount).toBe(1);
    expect(vars.labelIds).toContain("impl-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });

  it("fail-open when issueUpdate returns non-success (no throw)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
      issueUpdateSuccess: false,
    });
    globalThis.fetch = mock;
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toBeUndefined();
  });

  it("fail-open when issueUpdate throws (no throw)", async () => {
    const { fetch: mock } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
      updateError: true,
    });
    globalThis.fetch = mock;
    await expect(applyStateTransition("submit", "issue-uuid", "Bearer tok")).resolves.toBeUndefined();
  });
});

describe("applyStateTransition — break-glass escape", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("transitions to state:escape from any state on 'escape' command", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "escape-lbl", name: "state:escape" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("escape", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    expect(vars.labelIds).toContain("escape-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
  });
});

describe("applyStateTransition — __ad_hoc__ demotion", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("removes state:* and wf:* labels when demoting to __ad_hoc__", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:intake" },
        { id: "other-lbl", name: "priority:medium" },
      ],
    });
    globalThis.fetch = mock;
    await applyStateTransition("demote", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();
    const vars = updateCall!.body.variables as { labelIds: string[] };
    // wf:* and state:* labels gone; non-workflow labels kept.
    expect(vars.labelIds).toContain("other-lbl");
    expect(vars.labelIds).not.toContain("wf-lbl");
    expect(vars.labelIds).not.toContain("state-lbl");
    // No TeamLabels or label create call needed for __ad_hoc__.
    expect(calls.some((c) => (c.body.query ?? "").includes("TeamLabels"))).toBe(false);
  });

  it("does not call issueUpdate when demoting a ticket that already has no state/wf labels", async () => {
    // Already cleaned up — issue has no wf:* label, so mode switch exits early.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [{ id: "other-lbl", name: "priority:medium" }],
    });
    globalThis.fetch = mock;
    await applyStateTransition("demote", "issue-uuid", "Bearer tok");
    expect(calls.some((c) => (c.body.query ?? "").includes("ApplyStateTransition"))).toBe(false);
  });
});
