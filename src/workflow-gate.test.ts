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
  checkRawMutationInterception,
  buildStateTransitionReminder,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// Resolved from the project root (jest cwd) so it works under both the
// ESM tsc build and the CommonJS ts-jest transpile.
const CANONICAL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
const CANONICAL_UX_AUDIT_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-ux-audit.yaml");

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

// ── Capability policy with ux-audit roles (AI-1438 Phase 5 / B-1) ────────

const UX_AUDIT_POLICY_YAML = `
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
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: ux-researcher
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]

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
  - id: maya
    container: ux-researcher
    fills_roles: [ux-researcher]
  - id: engine-1
    container: engine
    fills_roles: [engine]
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

// ── AI-1460: refuse-work meta-command ─────────────────────────────────────

describe("checkWorkflowRules — AI-1460: refuse-work meta-command", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const allStates = [
    "intake", "implementation", "code-review", "deployment", "done",
  ];

  for (const state of allStates) {
    it(`refuse-work is legal from state '${state}' for a known caller`, async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles")).toBeNull();
    });
  }

  it("refuse-work is blocked for unknown callers", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("Unknown caller");
    expect(result).toContain("ghost-agent");
  });

  it("refuse-work is pass-through on ad-hoc tickets (no wf:* label)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles")).toBeNull();
  });

  it("refuse-work bypasses delegate-only check (non-delegate can refuse)", async () => {
    // Simulate a ticket where charles is NOT the delegate (someone else is)
    // by providing callerLinearUserId that differs from delegateId.
    // refuse-work should still pass because it bypasses delegate-only.
    globalThis.fetch = async (_url, _init) => {
      const body = {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "other-user-id" },
          },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    // charles (callerLinearUserId=charles-uid) is not the delegate (other-user-id)
    expect(await checkWorkflowRules("refuse-work", "issue-uuid", "Bearer tok", "charles", null, "charles-uid")).toBeNull();
  });
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

    // AI-1463: UpdateDelegate mutation for auto-delegate assignment.
    if (query.includes("UpdateDelegate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
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

// ── Layer 2: Raw status/assignee mutation interception (AI-1387) ──────────

describe("checkRawMutationInterception — Layer 2 (AI-1387)", () => {
  let layer2Dir: string;
  let layer2OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    layer2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "layer2-test-"));
    const policyFile = path.join(layer2Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(layer2Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    layer2OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = layer2OriginalFetch;
  });

  // Minimal label response: workflow ticket in implementation state.
  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  // Non-workflow ticket.
  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
  };

  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueContext") || bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return layer2OriginalFetch(url, init);
    };
  }

  it("blocks a raw stateId mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
    expect(result).toContain("blocked on this workflow ticket");
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });

  it("blocks a raw assigneeId mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { assigneeId: "user-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("Direct assignee");
    expect(result).toContain("blocked on this workflow ticket");
  });

  it("blocks a raw stateId + assigneeId mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid", assigneeId: "user-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("Direct status/assignee");
  });

  it("passes through on ad-hoc (non-workflow) tickets", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("passes through when mutation does not touch stateId or assigneeId", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { title: "Updated title" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("passes through when body is not an issueUpdate mutation", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
      variables: { input: { issueId: "issue-uuid", body: "comment text" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("passes through when issueId is null", async () => {
    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, null, "Bearer tok");
    expect(result).toBeNull();
  });

  it("passes through when body is null", async () => {
    const result = await checkRawMutationInterception(null, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("fails open on label fetch error", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).toBeNull();
  });

  it("includes per-command help with assignment targets in the rejection", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    // Should include the submit command (the legal move from implementation)
    expect(result).toContain("linear submit");
    // Should include the escape/break-glass command
    expect(result).toContain("escape");
    // Should show the transition arrow
    expect(result).toContain("→ code-review");
  });
});

// ── Layer 1: Proactive legal-verb re-injection (AI-1387) ──────────────────

describe("buildStateTransitionReminder — Layer 1 (AI-1387)", () => {
  let layer1Dir: string;
  let layer1OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    layer1Dir = fs.mkdtempSync(path.join(os.tmpdir(), "layer1-test-"));
    const policyFile = path.join(layer1Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(layer1Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    layer1OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = layer1OriginalFetch;
  });

  it("returns reminder for code-review state after submit from implementation", async () => {
    // After "submit" (implementation → code-review), the new state is code-review.
    // Legal moves: approve, request-changes, escape.
    const result = await buildStateTransitionReminder("submit", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("[Workflow]");
    expect(result).toContain("code-review");
    expect(result).toContain("approve");
    expect(result).toContain("request-changes");
    expect(result).toContain("escape");
  });

  it("returns reminder for implementation state after accept from intake", async () => {
    const result = await buildStateTransitionReminder("accept", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });

  it("returns null for terminal state (done)", async () => {
    // After "deploy" (deployment → done), the destination is terminal.
    const result = await buildStateTransitionReminder("deploy", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null for terminal escape state", async () => {
    const result = await buildStateTransitionReminder("escape", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null for unknown intent", async () => {
    const result = await buildStateTransitionReminder("unknown-command", "ABC-123", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null when issueId is null", async () => {
    const result = await buildStateTransitionReminder("submit", null, "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns reminder for deployment state after approve from code-review", async () => {
    const result = await buildStateTransitionReminder("approve", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("deployment");
    expect(result).toContain("deploy");
    expect(result).toContain("reject");
  });

  it("returns reminder for implementation state after request-changes from code-review", async () => {
    const result = await buildStateTransitionReminder("request-changes", "ABC-123", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result).toContain("implementation");
    expect(result).toContain("submit");
  });
});

// ── AI-1402: Default-deny + needs-human blocking + unknown-caller ─────────

describe("checkWorkflowRules — AI-1402: needs-human blocked when forward path exists", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks needs-human in implementation (forward path: submit)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("needs-human");
  });

  it("blocks needs-human in code-review (forward path: approve, request-changes)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("needs-human");
  });

  it("blocks needs-human in deployment (forward path: deploy, reject)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("needs-human");
  });

  it("blocks needs-human when no state label — fail-closed for this intent", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl"]); // no state:* label
    const result = await checkWorkflowRules("needs-human", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("needs-human");
    // Should suggest escape as the legal alternative
    expect(result).toContain("escape");
  });

  it("break-glass (escape) is still legal from every state (§4.4)", async () => {
    for (const state of ["intake", "implementation", "code-review", "deployment", "done"]) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "charles");
      expect(result).toBeNull(); // state: ${state}
    }
  });
});

describe("checkWorkflowRules — AI-1402: unknown-caller fail-closed", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks unknown caller on wf:dev-impl ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // "ghost-agent" is not in the test policy (which only has hanzo, charles, astrid)
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("ghost-agent");
    expect(result).toContain("Unknown caller");
  });

  it("allows known caller (charles) on wf:dev-impl ticket with legal command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("unknown caller on ad-hoc ticket is pass-through (no wf:* label)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).toBeNull();
  });

  it("escape (break-glass) does NOT bypass unknown-caller check — unidentified callers are blocked", async () => {
    // The unknown-caller block fires before the break-glass check. An agent not in the
    // capability policy cannot affect a governed ticket, even via break-glass.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("Unknown caller");
  });
});

describe("checkRawMutationInterception — AI-1402: labelIds blocking + unknown-caller", () => {
  let ai1402Dir: string;
  let ai1402OriginalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ai1402Dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1402-test-"));
    const policyFile = path.join(ai1402Dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(ai1402Dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    resetPolicyCache();
    resetWorkflowCache();
    ai1402OriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ai1402OriginalFetch;
  });

  const WORKFLOW_IMPL_LABELS = {
    data: { issue: { labels: { nodes: [
      { name: "wf:dev-impl" },
      { name: "state:implementation" },
    ] } } },
  };

  const AD_HOC_LABELS = {
    data: { issue: { labels: { nodes: [{ name: "bug" }] } } },
  };

  function mockLabelFetch(labelResponse: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (url: any, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("IssueLabels")) {
          return new Response(JSON.stringify(labelResponse), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return ai1402OriginalFetch(url, init);
    };
  }

  it("blocks a raw labelIds mutation on a workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { labelIds: ["lbl-1", "lbl-2"] } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct");
    expect(result).toContain("labels");
    expect(result).toContain("blocked on this workflow ticket");
  });

  it("passes through labelIds mutation on ad-hoc ticket", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { labelIds: ["lbl-1"] } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("passes through title-only mutation on workflow ticket (title is not workflow-affecting)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { title: "Updated title" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("blocks unknown caller raw mutation on workflow ticket", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Unknown caller");
    expect(result).toContain("ghost-agent");
  });

  it("passes unknown caller on ad-hoc ticket (no wf:* label)", async () => {
    globalThis.fetch = mockLabelFetch(AD_HOC_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok", "ghost-agent");
    expect(result).toBeNull();
  });

  it("passes when bodyId is undefined (backward-compat: no caller header)", async () => {
    globalThis.fetch = mockLabelFetch(WORKFLOW_IMPL_LABELS);

    const body = {
      query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "issue-uuid", input: { stateId: "state-done-uuid" } },
    };

    // bodyId omitted (undefined) — still blocks the stateId mutation via existing logic
    const result = await checkRawMutationInterception(body, "issue-uuid", "Bearer tok");
    expect(result).not.toBeNull();
    // Should still be blocked by the stateId rule, not by the unknown-caller rule
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Direct status");
  });
});


// ── Phase 5 / B-1: ux-audit workflow definition validation (AI-1438) ────────
// Validates the canonical ux-audit YAML fixture parses correctly and
// enforces workflow rules per design.md §14 + §16.0.
// No engine/runtime logic — definition + validation only.

describe("checkWorkflowRules — canonical ux-audit schema (src/__fixtures__/canonical-ux-audit.yaml)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let uxDir: string;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    uxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ux-audit-test-"));
    const policyFile = path.join(uxDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, UX_AUDIT_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) {
      process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    } else {
      delete process.env.WORKFLOW_DEF_PATH;
    }
    if (originalPolicyPath !== undefined) {
      process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    } else {
      delete process.env.CAPABILITY_POLICY_PATH;
    }
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  // §16.0 invariant: the YAML parses and produces a valid WorkflowDef
  it("parses the canonical ux-audit YAML without error", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);
    // 'complete-audit' is legal in auditing; null means pass-through
    expect(await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "maya")).toBeNull();
  });

  // §16.0 invariant: escape is legal from every state (§4.4)
  it("escape is legal from every ux-audit state (§4.4)", async () => {
    const allStates = [
      "intake", "auditing", "spawning", "managing", "review", "done", "escape",
    ];
    for (const state of allStates) {
      resetWorkflowCache();
      globalThis.fetch = makeLabelFetch(["wf:ux-audit", `state:${state}`]);
      const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid");
      expect(result).toBeNull(); // state: ${state}
    }
  });

  // §16.0 invariant: each state has the expected legal transitions
  it("intake state allows accept and demote only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:intake"]);
    // accept is legal
    expect(await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
    // demote is legal
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:intake"]);
    expect(await checkWorkflowRules("demote", "issue-uuid", "Bearer tok", "astrid")).toBeNull();
    // complete-audit is illegal in intake
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:intake"]);
    const blocked = await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "astrid");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("accept");
    expect(blocked).toContain("demote");
    expect(blocked).toContain("escape");
  });

  it("auditing state allows complete-audit only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);
    expect(await checkWorkflowRules("complete-audit", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // submit is illegal in auditing
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:auditing"]);
    const blocked = await checkWorkflowRules("submit", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("complete-audit");
  });

  it("spawning state allows spawn only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:spawning"]);
    expect(await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "engine-1")).toBeNull();
    // accept is illegal in spawning
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:spawning"]);
    const blocked = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "engine-1");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("spawn");
  });

  it("managing state allows complete only", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:managing"]);
    expect(await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // spawn is illegal in managing
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:managing"]);
    const blocked = await checkWorkflowRules("spawn", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("complete");
  });

  it("review state allows approve and request-revision", async () => {
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:review"]);
    expect(await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:review"]);
    expect(await checkWorkflowRules("request-revision", "issue-uuid", "Bearer tok", "maya")).toBeNull();
    // complete is illegal in review
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:ux-audit", "state:review"]);
    const blocked = await checkWorkflowRules("complete", "issue-uuid", "Bearer tok", "maya");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("approve");
    expect(blocked).toContain("request-revision");
  });

  // §16.0 invariant: all transition targets resolve to valid states
  it("all transition targets reference valid states", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const stateIds = new Set(def.states.map((s) => s.id));
    // Also accept __ad_hoc__ as a valid target (it's a special demotion target)
    stateIds.add("__ad_hoc__");
    for (const state of def.states) {
      for (const t of state.transitions ?? []) {
        expect(stateIds.has(t.to)).toBe(true);
      }
    }
  });

  // §16.0 invariant: break_glass is defined
  it("break_glass is defined with a command", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    expect(def.break_glass).toBeDefined();
    expect(def.break_glass!.command).toBe("escape");
    expect(def.break_glass!.to).toBe("escape");
  });

  // §16.0 invariant: entry_state references a valid state
  it("entry_state references a valid state", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    const stateIds = new Set(def.states.map((s) => s.id));
    expect(stateIds.has(def.entry_state ?? "")).toBe(true);
  });

  // §16.0 invariant: archetype is set
  it("archetype is 'orchestrator'", async () => {
    const { loadWorkflowDef } = await import("./workflow-gate.js");
    const def = await loadWorkflowDef();
    expect(def.archetype).toBe("orchestrator");
  });
});

// ── AI-1463: Auto-delegate assignment on approve transition ──────────────────

describe("applyStateTransition — auto-delegate assignment (AI-1463)", () => {
  let autoDelegateDir: string;
  let autoDelegateOriginalFetch: typeof globalThis.fetch;
  let originalAgentsFile: string | undefined;

  beforeEach(() => {
    autoDelegateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1463-test-"));
    const policyFile = path.join(autoDelegateDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const workflowFile = path.join(autoDelegateDir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;

    // Set up agents.json with hanzo (deployment body) having a linearUserId
    const agentsFile = path.join(autoDelegateDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [{
        name: "hanzo",
        linearUserId: "hanzo-linear-uuid",
        clientId: "hanzo-client",
        clientSecret: "hanzo-secret",
        accessToken: "hanzo-token",
        refreshToken: "hanzo-refresh",
      }, {
        name: "charles",
        linearUserId: "charles-linear-uuid",
        clientId: "charles-client",
        clientSecret: "charles-secret",
        accessToken: "charles-token",
        refreshToken: "charles-refresh",
      }],
    }, null, 2), "utf8");
    originalAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    resetPolicyCache();
    resetWorkflowCache();
    autoDelegateOriginalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = autoDelegateOriginalFetch;
    if (originalAgentsFile) {
      process.env.AGENTS_FILE = originalAgentsFile;
    } else {
      delete process.env.AGENTS_FILE;
    }
    reloadAgents();
    fs.rmSync(autoDelegateDir, { recursive: true, force: true });
  });

  it("auto-assigns delegate to hanzo when approve transitions code-review → deployment", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "deploy-lbl", name: "state:deployment" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("approve", "issue-uuid", "Bearer tok");

    // Verify the label swap happened
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();

    // Verify the delegate update mutation was issued
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeDefined();
    const vars = delegateCall!.body.variables as { issueId: string; delegateId: string };
    expect(vars.issueId).toBe("internal-uuid");
    expect(vars.delegateId).toBe("hanzo-linear-uuid");
  });

  it("does not auto-assign delegate when destination state has no owner_role", async () => {
    // submit transitions implementation → code-review. code-review has owner_role: code-review
    // but there is no body filling the code-review role in the test policy, so resolveBodiesForRole
    // returns [] and auto-delegate should be skipped.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
      teamLabels: [{ id: "cr-lbl", name: "state:code-review" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("submit", "issue-uuid", "Bearer tok");

    // Label swap should happen
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();

    // But no delegate update (code-review role has no bodies in test policy)
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeUndefined();
  });

  it("does not auto-assign delegate when destination is terminal (done)", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:deployment" },
      ],
      teamLabels: [{ id: "done-lbl", name: "state:done" }],
    });
    globalThis.fetch = mock;

    await applyStateTransition("deploy", "issue-uuid", "Bearer tok");

    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();

    // Terminal state — no auto-delegate
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeUndefined();
  });

  it("fail-open: auto-delegate errors do not block the label transition", async () => {
    // Simulate a scenario where getAgent returns undefined (body not in agents.json)
    // by using a body name that doesn't exist. The label swap should still succeed.
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:code-review" },
      ],
      teamLabels: [{ id: "deploy-lbl", name: "state:deployment" }],
    });
    globalThis.fetch = mock;

    // Temporarily remove hanzo from agents
    const agentsFile = path.join(autoDelegateDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [{
        name: "charles",
        linearUserId: "charles-linear-uuid",
        clientId: "charles-client",
        clientSecret: "charles-secret",
        accessToken: "charles-token",
        refreshToken: "charles-refresh",
      }],
    }, null, 2), "utf8");
    reloadAgents();

    await applyStateTransition("approve", "issue-uuid", "Bearer tok");

    // Label swap should still have happened despite missing hanzo agent
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyStateTransition"));
    expect(updateCall).toBeDefined();

    // No delegate update (hanzo not in agents)
    const delegateCall = calls.find((c) => (c.body.query ?? "").includes("UpdateDelegate"));
    expect(delegateCall).toBeUndefined();

  });
});
