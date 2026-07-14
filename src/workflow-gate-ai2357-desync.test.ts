/**
 * AI-2357: Connector stale-label/state-projection drift — governed transitions
 * decline on desynced labels.
 *
 * The connector maintains a projection of workflow state via `state:*` labels
 * on Linear tickets. This projection is redundant with the engine's in-memory
 * state track — and it drifts. When a ticket's native Linear state and its
 * `state:*` label desync (which is frequent for workflows cycling through
 * multiple native states or after connector restarts), every governed verb
 * declines.
 *
 * The fix: `checkWorkflowRules` now checks the authoritative applied-state
 * store (`getAppliedState`) as the primary source of truth. When the engine
 * state disagrees with the label projection, the engine state wins — the
 * label projection is advisory, not authoritative.
 *
 * AC1/AC2 — Self-heal on stale labels (via applied-state store)
 * AC3 — Stuck-delegate suggestion alignment
 * AC4 — Integration: desync → self-heal → applyStateTransition
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { checkWorkflowRules, applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { recordAppliedState, _resetAppliedStateStore } from "./store/applied-state-store.js";

// ── Shared test policy ─────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
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
  - id: reviewer
    grants: [linear:transition]
  - id: deployer
    grants: [deploy:execute]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: cra
    container: reviewer
    fills_roles: [code-review]
  - id: hanzo
    container: deployer
    fills_roles: [deployment]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

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
    native_state: doing
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// ── Test infrastructure ────────────────────────────────────────────────────

let dir: string;
let policyFile: string;
let wfFile: string;

// Save original env values so we don't clobber other test files in the same worker
const ORIG_CAPABILITY_POLICY_PATH = process.env.CAPABILITY_POLICY_PATH;
const ORIG_WORKFLOW_DEF_PATH = process.env.WORKFLOW_DEF_PATH;
const ORIG_ROLE_BODIES_FIXTURE_PATH = process.env.ROLE_BODIES_FIXTURE_PATH;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-gate-ai2357-"));

  policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");

  wfFile = path.join(dir, "workflow.yaml");
  fs.writeFileSync(wfFile, TEST_WORKFLOW_YAML, "utf8");

  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.WORKFLOW_DEF_PATH = wfFile;
  process.env.ROLE_BODIES_FIXTURE_PATH = policyFile;
});

afterAll(() => {
  // Restore originals, don't delete — other test files may need them
  if (ORIG_CAPABILITY_POLICY_PATH !== undefined) {
    process.env.CAPABILITY_POLICY_PATH = ORIG_CAPABILITY_POLICY_PATH;
  } else {
    delete process.env.CAPABILITY_POLICY_PATH;
  }
  if (ORIG_WORKFLOW_DEF_PATH !== undefined) {
    process.env.WORKFLOW_DEF_PATH = ORIG_WORKFLOW_DEF_PATH;
  } else {
    delete process.env.WORKFLOW_DEF_PATH;
  }
  if (ORIG_ROLE_BODIES_FIXTURE_PATH !== undefined) {
    process.env.ROLE_BODIES_FIXTURE_PATH = ORIG_ROLE_BODIES_FIXTURE_PATH;
  } else {
    delete process.env.ROLE_BODIES_FIXTURE_PATH;
  }
  try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  _resetAppliedStateStore();
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
});

interface MakeLabelFetchOpts {
  issueLabels?: Array<{ name: string }>;
  issueError?: boolean;
  updateError?: boolean;
  issueUpdateSuccess?: boolean;
  /**
   * Identifier returned by the IssueContext fetch. Pass `null` to simulate an
   * issue whose identifier could not be resolved (the gate then falls back to
   * the raw issueId it was handed).
   */
  identifier?: string | null;
}

/**
 * The two key spaces the applied-state store straddles — kept deliberately
 * DISTINCT so the suite exercises production keying.
 *
 * Production writes to the store under the HUMAN identifier
 * (applyStateTransition → recordAppliedState(issue.identifier, ...)), but
 * checkWorkflowRules is handed `issueId` = extractIssueId(body), which on the
 * issueUpdate mutation path is a UUID. An earlier version of this suite used one
 * literal for both, so the lookup always hit and the tests passed against a fix
 * that was a no-op in production. Never collapse these two constants.
 */
const TEST_IDENTIFIER = "AI-2357";
const ISSUE_UUID = "11111111-2222-3333-4444-555555555555";

const teamId = "team-uuid";
const teamLabels: Array<{ id: string; name: string }> = [
  { id: "state-backlog-uuid", name: "Backlog" },
  { id: "state-todo-uuid", name: "Todo" },
  { id: "state-doing-uuid", name: "Doing" },
  { id: "state-thinking-uuid", name: "Thinking" },
  { id: "state-managing-uuid", name: "Managing" },
  { id: "state-done-uuid", name: "Done" },
  { id: "state-invalid-uuid", name: "Invalid" },
  { id: "wf-dev-impl-uuid", name: "wf:dev-impl" },
  { id: "state-intake-uuid", name: "state:intake" },
  { id: "state-implementation-uuid", name: "state:implementation" },
  { id: "state-code-review-uuid", name: "state:code-review" },
  { id: "state-deployment-uuid", name: "state:deployment" },
  { id: "state-done-uuid-label", name: "state:done" },
];

let updateRequestCount = 0;

function makeLabelFetch(labels: string[], opts: MakeLabelFetchOpts = {}) {
  updateRequestCount = 0;
  const issueLabels = (opts.issueLabels ?? labels.map((l) => ({ name: l })));

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("IssueContext") || query.includes("IssueWithLabels")) {
      if (opts.issueError) throw new Error("simulated fetch error");
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              // Linear resolves the human identifier regardless of whether the
              // request supplied a UUID or an identifier. This is the store's
              // true key.
              identifier: opts.identifier === undefined ? TEST_IDENTIFIER : opts.identifier,
              team: { id: teamId },
              labels: { nodes: issueLabels },
              delegate: null,
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

    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-backlog-uuid", name: "Backlog", type: "unstarted" },
                  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                  { id: "state-doing-uuid", name: "Doing", type: "started" },
                  { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                  { id: "state-managing-uuid", name: "Managing", type: "started" },
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

    if (query.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("ApplyAtomicTransition")) {
      updateRequestCount++;
      if (opts.updateError) throw new Error("simulated update error");
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: opts.issueUpdateSuccess ?? true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("UpdateDelegate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              attachments: { nodes: [] },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };

  return mockFetch;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AI-2357: stale-label/state-projection drift — self-heal in checkWorkflowRules", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; _resetAppliedStateStore(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ─── AC1/AC2: self-heal on stale labels via applied-state store ────────

  it("'approve' passes despite stale 'state:implementation' label (engine state = code-review)", async () => {
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).toBeNull();
  });

  it("'submit' passes despite stale 'state:code-review' label (engine state = implementation)", async () => {
    recordAppliedState(TEST_IDENTIFIER, "implementation");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("submit", ISSUE_UUID, "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("'deploy' passes despite stale 'state:done' label (engine state = deployment)", async () => {
    recordAppliedState(TEST_IDENTIFIER, "deployment");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:done"]);
    const result = await checkWorkflowRules("deploy", ISSUE_UUID, "Bearer tok", "hanzo");
    expect(result).toBeNull();
  });

  it("passes normally when labels are accurate (no regression)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("submit", ISSUE_UUID, "Bearer tok", "charles")).toBeNull();

    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    expect(await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra")).toBeNull();

    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    expect(await checkWorkflowRules("deploy", ISSUE_UUID, "Bearer tok", "hanzo")).toBeNull();
  });

  it("blocks a genuinely illegal verb when no engine state override exists", async () => {
    // No applied-state store — labels are authoritative. deploy from
    // code-review is illegal with accurate labels.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("deploy", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  it("escape still works with stale labels", async () => {
    // escape is break-glass and is handled before the normal transition check
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("escape", ISSUE_UUID, "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("'request-changes' passes despite stale 'state:implementation' label (engine state = code-review)", async () => {
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("request-changes", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).toBeNull();
  });

  it("blocks request-changes without engine state override (labels accurate)", async () => {
    // No applied state — request-changes from implementation is NOT legal
    _resetAppliedStateStore();
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("request-changes", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  it("'accept' passes despite stale 'state:implementation' label (engine state = intake)", async () => {
    recordAppliedState(TEST_IDENTIFIER, "intake");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("accept", ISSUE_UUID, "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("capability gate still fires after self-heal", async () => {
    // deploy requires deploy:execute — cra doesn't have it
    recordAppliedState(TEST_IDENTIFIER, "deployment");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("deploy", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).not.toBeNull();
    expect(result).toContain("requires");
  });
});

describe("AI-2357: applied-state store keying — read key must be the human identifier", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; _resetAppliedStateStore(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // The regression this class of test exists for: the store is written under the
  // human identifier but the gate is handed a UUID. If the gate reads the store
  // with that UUID, the lookup misses, it falls through to the stale label, and
  // the verb declines — the bug AI-2357 exists to close, passing its own suite.

  it("self-heals when the store was written under the identifier and the gate is called with a UUID", async () => {
    // Exactly what production does: applyStateTransition recorded 'code-review'
    // under 'AI-2357'; the inbound issueUpdate mutation carries a UUID.
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const result = await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra");

    expect(result).toBeNull();
  });

  it("does NOT consult a store entry written under the UUID (identifier is the only key)", async () => {
    // Nothing in production writes under the UUID. If this ever passes, the gate
    // is reading a key space that the writer never populates.
    recordAppliedState(ISSUE_UUID, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const result = await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra");

    // No identifier-keyed entry → stale label stands → approve is illegal there.
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  it("falls back to the raw issueId when the identifier cannot be resolved (CLI path)", async () => {
    // On the CLI path issueId may itself already be the identifier, and a failed
    // identifier resolve must not regress the pre-existing behavior.
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"], { identifier: null });

    const result = await checkWorkflowRules("approve", TEST_IDENTIFIER, "Bearer tok", "cra");

    expect(result).toBeNull();
  });

  it("store lookup is case-insensitive across key forms (normalizeKey uppercases)", async () => {
    recordAppliedState("ai-2357", "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const result = await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra");

    expect(result).toBeNull();
  });
});

describe("AI-2357: stale-label self-heal — stuck-delegate suggestion alignment", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; _resetAppliedStateStore(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("commands suggested by buildRePrompt for the true state pass checkWorkflowRules with engine state", async () => {
    // Simulate ticket at code-review with stale label (says implementation)
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    // approve is a code-review command — should pass
    expect(await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra")).toBeNull();
    // request-changes is also a code-review command
    expect(await checkWorkflowRules("request-changes", ISSUE_UUID, "Bearer tok", "cra")).toBeNull();
  });

  it("without engine state, labels are authoritative — non-matching verbs still rejected", async () => {
    // No applied-state store — label (code-review) is the source of truth
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    // submit is NOT in code-review's transitions and no engine state override
    const result = await checkWorkflowRules("submit", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });
});

describe("AI-2357: integration — applyStateTransition after self-heal", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; _resetAppliedStateStore(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("desync labels → self-heal gate → pass — approve transitions cleanly", async () => {
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "cra")).toBeNull();
  });

  it("desync labels → self-heal gate → pass — submit transitions cleanly", async () => {
    recordAppliedState(TEST_IDENTIFIER, "implementation");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    expect(await checkWorkflowRules("submit", ISSUE_UUID, "Bearer tok", "charles")).toBeNull();
  });

  it("request-changes self-heals from stale implementation label when engine says code-review", async () => {
    recordAppliedState(TEST_IDENTIFIER, "code-review");
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    expect(await checkWorkflowRules("request-changes", ISSUE_UUID, "Bearer tok", "cra")).toBeNull();
  });
});
