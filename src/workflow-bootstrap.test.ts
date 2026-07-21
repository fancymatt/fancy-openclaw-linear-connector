/**
 * Failing tests for workflow-bootstrap.ts (AI-1565).
 *
 * New pre-routing hook: when a wf:* label is added to a ticket that has no
 * state:* label, the connector bootstraps the ticket into its entry state and
 * sets the first-owner delegate — no human/agent action required.
 *
 * Reverse path: when the wf:* label is removed (demote / manual strip), the
 * companion state:* label is cleaned up so the ticket reverts to ad-hoc.
 *
 * AC-to-test mapping:
 *   AC1 + AC7a: label-add bootstraps entry state + delegate (dev-impl)
 *   AC2:        resolution is config-derived (entry_state from def, owner from policy)
 *   AC3 + AC7b: label-add on already-in-state ticket is a no-op
 *   AC4:        fires only on label-add, not on other issue updates
 *   AC5 + AC7c: second workflow (ux-audit) resolves its own entry state
 *   AC6:        demote / wf:* remove cleanly reverses bootstrap
 *   AC7d:       missing/invalid def fails safe — logged, no crash
 *   AC8:        see jest suite integration below
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { maybeBootstrapWorkflow } from "./workflow-bootstrap.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Minimal workflow defs for tests ───────────────────────────────────────

const DEV_IMPL_YAML = `
id: dev-impl
version: 8
entry_state: intake
break_glass:
  command: escape
  to: escape
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        assign: { mode: auto }
        capture_ac: true
      - command: demote
        to: __ad_hoc__
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

// Second workflow for AC5/AC7c — entry_state deliberately different from dev-impl.
const UX_AUDIT_YAML = `
id: ux-audit
version: 1
entry_state: ux-intake
break_glass:
  command: escape
  to: ux-escape
  owner_role: steward
states:
  - id: ux-intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: ux-done
  - id: ux-done
    kind: terminal
    native_state: done
  - id: ux-escape
    kind: terminal
    native_state: invalid
`;

// Capability policy with steward role filled by astrid (linearUserId: "astrid-linear-id").
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// ── Fake agents.json (astrid with a known linearUserId) ───────────────────
const AGENTS_JSON = JSON.stringify({
  agents: [
    {
      name: "astrid",
      linearUserId: "astrid-linear-id",
      clientId: "c1",
      clientSecret: "s1",
      accessToken: "tok-astrid",
      refreshToken: "r1",
      openclawAgent: "astrid",
    },
  ],
});

// ── Internal issue IDs used in tests ─────────────────────────────────────
const ISSUE_INTERNAL_ID = "issue-internal-uuid-123";
const TEAM_ID = "team-uuid-abc";
const WF_LABEL_ID = "label-wf-dev-impl-id";
const STATE_INTAKE_LABEL_ID = "label-state-intake-id";
const STATE_WF_UX_LABEL_ID = "label-wf-ux-audit-id";

// ── Test suite setup ──────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-test-"));

  // Write workflow def files
  const defsDir = path.join(tmpDir, "defs");
  await fs.mkdir(defsDir);
  await fs.writeFile(path.join(defsDir, "dev-impl.yaml"), DEV_IMPL_YAML);
  await fs.writeFile(path.join(defsDir, "ux-audit.yaml"), UX_AUDIT_YAML);

  // Write capability policy
  const policyFile = path.join(tmpDir, "policy.yaml");
  await fs.writeFile(policyFile, POLICY_YAML);

  // Write agents.json
  const agentsFile = path.join(tmpDir, "agents.json");
  await fs.writeFile(agentsFile, AGENTS_JSON);

  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.AGENTS_PATH = agentsFile;
});

afterAll(async () => {
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  resetWorkflowCache();
  resetPolicyCache();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ── Fetch mock helpers ────────────────────────────────────────────────────

/** Build a fetch mock for the IssueWithLabels + team-labels + mutation calls. */
function makeBootstrapFetch(opts: {
  currentLabelNames: string[];
  /** extra label nodes for team-label lookup (resolves state:intake ID) */
  teamLabels?: Array<{ id: string; name: string }>;
  mutationSuccess?: boolean;
}): typeof globalThis.fetch {
  const teamLabels = opts.teamLabels ?? [
    { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
    { id: "label-state-ux-intake-id", name: "state:ux-intake" },
    { id: WF_LABEL_ID, name: "wf:dev-impl" },
    { id: STATE_WF_UX_LABEL_ID, name: "wf:ux-audit" },
  ];
  const mutationSuccess = opts.mutationSuccess ?? true;

  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";

    // IssueWithLabels query (bootstrap reads current issue labels + teamId)
    if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: ISSUE_INTERNAL_ID,
              team: { id: TEAM_ID },
              labels: {
                nodes: opts.currentLabelNames.map((name) => {
                  // Resolve to known IDs where we have them
                  const known = teamLabels.find((l) => l.name === name);
                  return { id: known?.id ?? `label-${name}-id`, name };
                }),
              },
              delegate: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Team labels lookup (findOrCreateLabel uses this to resolve a label name → ID)
    if (body.includes("labels") && body.includes(TEAM_ID)) {
      return new Response(
        JSON.stringify({
          data: { team: { labels: { nodes: teamLabels } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Atomic mutation (issueUpdate)
    if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Default (team states, etc.)
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Shared event factory ──────────────────────────────────────────────────

function makeIssueUpdateEvent(opts: {
  currentLabelIds: string[];
  previousLabelIds?: string[];
}) {
  return {
    type: "Issue" as const,
    action: "update" as const,
    actor: { id: "human-user-id", name: "Human" },
    createdAt: "2026-06-12T10:00:00.000Z",
    data: {
      id: ISSUE_INTERNAL_ID,
      identifier: "AI-1565",
      title: "Test ticket",
      description: "Test",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: TEAM_ID,
      teamKey: "AI",
      labelIds: opts.currentLabelIds,
      url: "https://linear.app/test/issue/AI-1565",
      createdAt: "2026-06-12T10:00:00.000Z",
      updatedAt: "2026-06-12T10:00:01.000Z",
    },
    updatedFrom: {
      labelIds: opts.previousLabelIds ?? [],
    },
    raw: {},
  };
}

// ── Tests: AC1/AC2/AC7a — label-add bootstraps entry state + delegate ─────

describe("AC1/AC2/AC7a: wf:* label-add bootstraps entry state and delegate", () => {
  it("applies state:intake and sets delegate to astrid when wf:dev-impl is added", async () => {
    const calls: Array<{ body: string }> = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ body });
      return makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] })(url, init);
    };

    // labelIds: previously none, now has the wf:dev-impl label
    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID],
      previousLabelIds: [],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).not.toBeNull();
    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("dev-impl");
    expect(result?.entryState).toBe("intake");

    // Verify the mutation was called (state:intake label + delegate astrid)
    const mutationCall = calls.find(
      (c) => c.body.includes("issueUpdate") || c.body.includes("ApplyAtomicTransition"),
    );
    expect(mutationCall).toBeDefined();
    // Mutation should reference the state:intake label ID and astrid's linearUserId
    expect(mutationCall?.body).toContain(STATE_INTAKE_LABEL_ID);
    expect(mutationCall?.body).toContain("astrid-linear-id");
  });

  it("AC2: entry_state is taken from workflow def (config-derived, not hardcoded)", async () => {
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] });

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID],
      previousLabelIds: [],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    // entry_state is "intake" as declared in the YAML def — not hardcoded
    expect(result?.entryState).toBe("intake");
  });

  it("AC2: owner delegate comes from capability policy (not hardcoded body name)", async () => {
    const mutationBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationBodies.push(body);
      }
      return makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] })(url, init);
    };

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID],
      previousLabelIds: [],
    });

    await maybeBootstrapWorkflow(event, "test-token");

    // astrid-linear-id is the linearUserId from agents.json for the body that fills "steward"
    expect(mutationBodies.length).toBeGreaterThan(0);
    expect(mutationBodies.some((b) => b.includes("astrid-linear-id"))).toBe(true);
  });
});

// ── Tests: AC3/AC7b — no-op when ticket already has state:* ──────────────

describe("AC3/AC7b: label-add on already-in-state ticket is a no-op", () => {
  it("returns null without calling the mutation when state:* is already present", async () => {
    const mutationCalls: string[] = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationCalls.push(body);
      }
      // Current labels already have state:intake
      return makeBootstrapFetch({
        currentLabelNames: ["wf:dev-impl", "state:intake"],
      })(url, init);
    };

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
      // simulate a re-apply / second label add on a ticket already in-state
      previousLabelIds: [STATE_INTAKE_LABEL_ID],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).toBeNull();
    expect(mutationCalls.length).toBe(0);
  });

  it("returns null when ticket has wf:* and a different state:*", async () => {
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["wf:dev-impl", "state:write-tests"],
    });

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID, "label-state-write-tests-id"],
      previousLabelIds: ["label-state-write-tests-id"],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).toBeNull();
  });
});

// ── Tests: AC4 — fires only on label add ─────────────────────────────────

describe("AC4: fires only on label-add, not other issue updates", () => {
  it("returns null when labelIds unchanged (title-only update)", async () => {
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["wf:dev-impl", "state:intake"],
    });

    // labelIds identical in before and after → not a label-change event
    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
      previousLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).toBeNull();
  });

  it("returns null for a non-Issue event type", async () => {
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: [] });

    const event = {
      type: "Comment" as const,
      action: "create" as const,
      actor: { id: "u1", name: "Human" },
      createdAt: "2026-06-12T10:00:00.000Z",
      data: {
        id: "c1",
        body: "hello",
        issueId: "i1",
        issueIdentifier: "AI-1",
        issueTitle: "Test",
        url: "https://linear.app",
        createdAt: "2026-06-12T10:00:00.000Z",
        updatedAt: "2026-06-12T10:00:00.000Z",
      },
      raw: {},
    };

    const result = await maybeBootstrapWorkflow(event as never, "test-token");

    expect(result).toBeNull();
  });

  it("returns null when no labelIds were added (only labels were removed)", async () => {
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["state:intake"],
    });

    // A label was REMOVED, not added (handled by demote path separately)
    const event = makeIssueUpdateEvent({
      currentLabelIds: [STATE_INTAKE_LABEL_ID],
      previousLabelIds: [STATE_INTAKE_LABEL_ID, WF_LABEL_ID],
    });

    // Bootstrap should not fire here (only fires on add, demote handles the remove)
    const result = await maybeBootstrapWorkflow(event, "test-token");

    // bootstrap action specifically should not fire
    expect(result?.action).not.toBe("bootstrapped");
  });
});

// ── Tests: AC5/AC7c — second workflow resolves its own entry state ────────

describe("AC5/AC7c: a second workflow's entry state resolves correctly", () => {
  it("bootstraps ux-audit with its own entry_state (ux-intake)", async () => {
    const calls: Array<{ body: string }> = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ body });
      return makeBootstrapFetch({ currentLabelNames: ["wf:ux-audit"] })(url, init);
    };

    const event = makeIssueUpdateEvent({
      currentLabelIds: [STATE_WF_UX_LABEL_ID],
      previousLabelIds: [],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).not.toBeNull();
    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("ux-audit");
    // ux-audit def declares entry_state: ux-intake
    expect(result?.entryState).toBe("ux-intake");
  });
});

// ── Tests: AC7d — missing/invalid def fails safe ─────────────────────────

describe("AC7d: missing/invalid def fails safe", () => {
  it("returns null without crashing when wf:unknown workflow has no registered def", async () => {
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["wf:unknown-workflow"],
    });

    const event = makeIssueUpdateEvent({
      currentLabelIds: ["label-wf-unknown-id"],
      previousLabelIds: [],
    });

    // Must not throw; should return null (fail safe)
    await expect(
      maybeBootstrapWorkflow(event, "test-token"),
    ).resolves.toBeNull();
  });

  it("returns null when the Linear fetch fails (network error)", async () => {
    globalThis.fetch = async () => {
      throw new Error("network failure");
    };

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID],
      previousLabelIds: [],
    });

    await expect(
      maybeBootstrapWorkflow(event, "test-token"),
    ).resolves.toBeNull();
  });

  it("returns null when mutation returns non-success from Linear", async () => {
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["wf:dev-impl"],
      mutationSuccess: false,
    });

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID],
      previousLabelIds: [],
    });

    // Non-success mutation: function should still return without crashing.
    // Exact return value is implementation-defined but must not throw.
    await expect(
      maybeBootstrapWorkflow(event, "test-token"),
    ).resolves.toBeDefined();
  });
});

// ── Tests: AC6 — demote / wf:* remove cleanly reverses bootstrap ─────────

describe("AC6: removing wf:* label (demote) cleans up state:* label", () => {
  it("removes state:intake when wf:dev-impl is stripped from an in-flight ticket", async () => {
    const mutationBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationBodies.push(body);
      }
      // Current labels: state:intake present, wf:dev-impl is GONE (removed)
      return makeBootstrapFetch({
        currentLabelNames: ["state:intake"],
      })(url, init);
    };

    // wf:dev-impl was in previous labelIds but is now removed
    const event = makeIssueUpdateEvent({
      currentLabelIds: [STATE_INTAKE_LABEL_ID],
      previousLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).not.toBeNull();
    expect(result?.action).toBe("demoted");

    // Mutation must have been called to remove the state:intake label
    expect(mutationBodies.length).toBeGreaterThan(0);
  });

  it("no-ops when wf:* is removed but no state:* label remains (already clean)", async () => {
    const mutationBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationBodies.push(body);
      }
      // Current labels: neither wf:* nor state:* present
      return makeBootstrapFetch({ currentLabelNames: ["bug"] })(url, init);
    };

    const event = makeIssueUpdateEvent({
      currentLabelIds: ["label-bug-id"],
      previousLabelIds: [WF_LABEL_ID, "label-bug-id"],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    // Nothing to clean up — already in clean ad-hoc state
    expect(result).toBeNull();
    expect(mutationBodies.length).toBe(0);
  });
});

// ── Tests: INF-268 — sprint-spawner auto-binds designated_approver = Ai ──

/**
 * Minimal sprint-spawner-like workflow def with the signoff gate transition.
 * The distinguishing trait is `id: sprint-spawner`; workflow-bootstrap must
 * recognize this and bind designated_approver = Ai on enrollment.
 */
const SPAWNER_YAML = `
id: sprint-spawner
version: 1
archetype: continuous-loop
entry_state: evaluating
break_glass:
  command: escape
  to: evaluating
  owner_role: steward
states:
  - id: evaluating
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: proceed
        to: determining-scope
        generic: continue
  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: propose-brief
        to: spawning-scope
        generic: continue
        requires_capability: sprint:signoff
        designated_approver: true
      - command: deliver-direct
        to: releasing
        requires_capability: sprint:signoff
        designated_approver: true
  - id: spawning-scope
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: done
  - id: releasing
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: release
        to: done
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

/** Non-spawner workflow for AC2 negative control — must NOT bind designated_approver. */
const BACKLOG_YAML = `
id: backlog-triage
version: 1
entry_state: triage
break_glass:
  command: escape
  to: triage
  owner_role: steward
states:
  - id: triage
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

/**
 * INF-268 AC1/AC2 (see AC mapping below).
 * Policy: steward = astrid; ai holds sprint:signoff.
 * agents.json includes both with known linearUserIds.
 */
const SPAWNER_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: sprint:signoff

containers:
  - id: workflow
    grants: [linear:transition]
  - id: ai
    grants: [linear:transition, sprint:signoff]

roles:
  - id: steward
    requires: [linear:transition]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: ai
    container: ai
    fills_roles: []
`;

const SPAWNER_AGENTS_JSON = JSON.stringify({
  agents: [
    { name: "astrid", linearUserId: "astrid-linear-id", clientId: "c1", clientSecret: "s1", accessToken: "tok-astrid", refreshToken: "r1", openclawAgent: "astrid" },
    { name: "ai", linearUserId: "ai-linear-id", clientId: "c2", clientSecret: "s2", accessToken: "tok-ai", refreshToken: "r2", openclawAgent: "ai" },
  ],
});

const SPAWNER_ISSUE_ID = "issue-internal-uuid-456";
const SPAWNER_TEAM_ID = "team-uuid-xyz";
const SPAWNER_WF_LABEL_ID = "label-wf-sprint-spawner-id";
const SPAWNER_STATE_LABEL_ID = "label-state-evaluating-id";

// ── Sprint-spawner bootstrap helpers ──────────────────────────────────────

function makeSpawnerBootstrapFetch(opts: {
  currentLabelNames: string[];
  teamLabels?: Array<{ id: string; name: string }>;
  mutationSuccess?: boolean;
}): typeof globalThis.fetch {
  const teamLabels = opts.teamLabels ?? [
    { id: SPAWNER_STATE_LABEL_ID, name: "state:evaluating" },
    { id: "label-state-determining-scope-id", name: "state:determining-scope" },
    { id: SPAWNER_WF_LABEL_ID, name: "wf:sprint-spawner" },
  ];
  const mutationSuccess = opts.mutationSuccess ?? true;

  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";

    if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: SPAWNER_ISSUE_ID,
              identifier: "INF-268",
              title: "Sprint spawner signoff",
              team: { id: SPAWNER_TEAM_ID },
              labels: {
                nodes: opts.currentLabelNames.map((name) => {
                  const known = teamLabels.find((l) => l.name === name);
                  return { id: known?.id ?? `label-${name}-id`, name };
                }),
              },
              delegate: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (body.includes("labels") && body.includes(SPAWNER_TEAM_ID)) {
      return new Response(
        JSON.stringify({
          data: { team: { labels: { nodes: teamLabels } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeSpawnerIssueUpdateEvent(opts: {
  currentLabelIds: string[];
  previousLabelIds?: string[];
}) {
  return {
    type: "Issue" as const,
    action: "update" as const,
    actor: { id: "human-user-id", name: "Human" },
    createdAt: "2026-07-21T10:00:00.000Z",
    data: {
      id: SPAWNER_ISSUE_ID,
      identifier: "INF-268",
      title: "Sprint spawner signoff",
      description: "Test",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: SPAWNER_TEAM_ID,
      teamKey: "INF",
      labelIds: opts.currentLabelIds,
      url: "https://linear.app/test/issue/INF-268",
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:01.000Z",
    },
    updatedFrom: {
      labelIds: opts.previousLabelIds ?? [],
    },
    raw: {},
  };
}

// Now import what we need for store-based testing
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

describe("INF-268: sprint-spawner enrollment auto-binds designated_approver = Ai", () => {
  let spawnerTmp: string;
  let storeDbPath: string;
  let store: EnrolledTicketsStore;
  let savedFetch: typeof globalThis.fetch;

  const SPAWNER_DEFS_DIR = "spawner-defs";

  beforeAll(async () => {
    spawnerTmp = await fs.mkdtemp(path.join(os.tmpdir(), "spawner-designated-approver-"));

    const defsDir = path.join(spawnerTmp, SPAWNER_DEFS_DIR);
    await fs.mkdir(defsDir);
    await fs.writeFile(path.join(defsDir, "sprint-spawner.yaml"), SPAWNER_YAML);
    await fs.writeFile(path.join(defsDir, "backlog-triage.yaml"), BACKLOG_YAML);

    const policyFile = path.join(spawnerTmp, "policy.yaml");
    await fs.writeFile(policyFile, SPAWNER_POLICY_YAML);

    const agentsFile = path.join(spawnerTmp, "agents.json");
    await fs.writeFile(agentsFile, SPAWNER_AGENTS_JSON);
  });

  beforeEach(async () => {
    savedFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();

    // Each test gets a fresh on-disk store so AC4 can re-open from the same path
    storeDbPath = path.join(spawnerTmp, `enrolled-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new EnrolledTicketsStore(storeDbPath);
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    store.close();
  });

  afterAll(async () => {
    await fs.rm(spawnerTmp, { recursive: true, force: true });
  });

  // ── INF-268 AC1: sprint-spawner enrollment binds designated_approver = Ai ──

  it("AC1: applyBootstrapToIssue records designated_approver = 'ai' for sprint-spawner workflow", async () => {
    // This test MUST fail until the implementation records designated_approver.
    // Currently, sprint-spawner bootstrap is treated identically to any other
    // workflow and does not write the designated_approver field.

    process.env.WORKFLOW_DEFS_DIR = path.join(spawnerTmp, SPAWNER_DEFS_DIR);
    process.env.CAPABILITY_POLICY_PATH = path.join(spawnerTmp, "policy.yaml");
    process.env.AGENTS_PATH = path.join(spawnerTmp, "agents.json");

    globalThis.fetch = makeSpawnerBootstrapFetch({
      currentLabelNames: ["wf:sprint-spawner"],
    });

    const { maybeBootstrapWorkflow } = await import("./workflow-bootstrap.js");

    const event = makeSpawnerIssueUpdateEvent({
      currentLabelIds: [SPAWNER_WF_LABEL_ID],
      previousLabelIds: [],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token", store);

    expect(result).not.toBeNull();
    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("sprint-spawner");

    // Verify the enrolled ticket exists
    const enrolled = store.getByTicketId("INF-268");
    expect(enrolled).not.toBeNull();

    // INF-268 AC1: the enrolled ticket must have designated_approver set to "ai"
    // THIS ASSERTION WILL FAIL until applyBootstrapToIssue is patched to bind
    // designated_approver for sprint-spawner workflows.
    expect((enrolled as Record<string, unknown>).designated_approver).toBe("ai");
  });

  // ── INF-268 AC2: non-spawner enrollment does NOT bind designated_approver ──

  it("AC2: non-sprint-spawner workflow enrollment does NOT set designated_approver", async () => {
    process.env.WORKFLOW_DEFS_DIR = path.join(spawnerTmp, SPAWNER_DEFS_DIR);
    process.env.CAPABILITY_POLICY_PATH = path.join(spawnerTmp, "policy.yaml");
    process.env.AGENTS_PATH = path.join(spawnerTmp, "agents.json");

    const BACKLOG_WF_LABEL_ID = "label-wf-backlog-triage-id";
    const BACKLOG_STATE_LABEL_ID = "label-state-triage-id";
    const BACKLOG_ISSUE_ID = "issue-backlog-uuid-789";

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";

      if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: BACKLOG_ISSUE_ID,
                identifier: "INF-269",
                title: "Backlog triage",
                team: { id: SPAWNER_TEAM_ID },
                labels: {
                  nodes: [{ id: BACKLOG_WF_LABEL_ID, name: "wf:backlog-triage" }],
                },
                delegate: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (body.includes("labels") && body.includes(SPAWNER_TEAM_ID)) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: BACKLOG_STATE_LABEL_ID, name: "state:triage" },
                    { id: BACKLOG_WF_LABEL_ID, name: "wf:backlog-triage" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof globalThis.fetch;

    const { applyBootstrapToIssue } = await import("./workflow-bootstrap.js");

    const issue = {
      id: BACKLOG_ISSUE_ID,
      teamId: SPAWNER_TEAM_ID,
      identifier: "INF-269",
      title: "Backlog triage",
      labels: [{ id: BACKLOG_WF_LABEL_ID, name: "wf:backlog-triage" }],
    };

    const result = await applyBootstrapToIssue(issue, "test-token", undefined, store);

    expect(result).not.toBeNull();
    expect(result?.action).toBe("bootstrapped");

    // Verify the enrolled ticket exists
    const enrolled = store.getByTicketId("INF-269");
    expect(enrolled).not.toBeNull();

    // AC2: non-spawner workflow must NOT set designated_approver
    // (this should pass once the assertion works — implementers make sure
    //  the designated_approver binding is scoped to sprint-spawner only)
    expect((enrolled as Record<string, unknown>).designated_approver).toBeUndefined();
  });

  // ── INF-268 AC3: existing bootstrap behavior preserved for sprint-spawner ──

  it("AC3: sprint-spawner bootstrap still applies entry state label and sets delegate", async () => {
    process.env.WORKFLOW_DEFS_DIR = path.join(spawnerTmp, SPAWNER_DEFS_DIR);
    process.env.CAPABILITY_POLICY_PATH = path.join(spawnerTmp, "policy.yaml");
    process.env.AGENTS_PATH = path.join(spawnerTmp, "agents.json");

    const mutationBodies: string[] = [];
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationBodies.push(body);
      }
      return makeSpawnerBootstrapFetch({ currentLabelNames: ["wf:sprint-spawner"] })(url, init);
    };

    const { maybeBootstrapWorkflow } = await import("./workflow-bootstrap.js");

    const event = makeSpawnerIssueUpdateEvent({
      currentLabelIds: [SPAWNER_WF_LABEL_ID],
      previousLabelIds: [],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token", store);

    expect(result).not.toBeNull();
    expect(result?.workflowId).toBe("sprint-spawner");
    expect(result?.entryState).toBe("evaluating");
    expect(result?.delegateAgentName).toBe("astrid");

    // Mutation should reference entry state label + steward delegate
    const mutationCall = mutationBodies.find(
      (b) => b.includes("issueUpdate") || b.includes("ApplyAtomicTransition"),
    );
    expect(mutationCall).toBeDefined();
    expect(mutationCall).toContain(SPAWNER_STATE_LABEL_ID);
    expect(mutationCall).toContain("astrid-linear-id");
  });

  // ── INF-268 AC4: designated_approver survives store round-trip ──

  it("AC4: designated_approver persisted in enrolled tickets store can be queried after re-open", async () => {
    process.env.WORKFLOW_DEFS_DIR = path.join(spawnerTmp, SPAWNER_DEFS_DIR);
    process.env.CAPABILITY_POLICY_PATH = path.join(spawnerTmp, "policy.yaml");
    process.env.AGENTS_PATH = path.join(spawnerTmp, "agents.json");

    globalThis.fetch = makeSpawnerBootstrapFetch({
      currentLabelNames: ["wf:sprint-spawner"],
    });

    const { maybeBootstrapWorkflow } = await import("./workflow-bootstrap.js");

    const event = makeSpawnerIssueUpdateEvent({
      currentLabelIds: [SPAWNER_WF_LABEL_ID],
      previousLabelIds: [],
    });

    await maybeBootstrapWorkflow(event, "test-token", store);

    // Close and re-open the store from the known path — the designated_approver
    // must survive the connection close (SQLite durability).
    store.close();
    const reopened = new EnrolledTicketsStore(storeDbPath);

    const enrolled = reopened.getByTicketId("INF-268");
    expect(enrolled).not.toBeNull();
    expect((enrolled as Record<string, unknown>).designated_approver).toBe("ai");

    reopened.close();
  });
});

describe("bootstrap wake regression (2026-07-03) — issue query must select identifier + title", () => {
  it("IssueWithLabels selects identifier and title (wake gate depends on them)", async () => {
    // The wake block in webhook/index.ts is gated on result.ticketIdentifier.
    // A query that omits 'identifier' makes it undefined at runtime while the
    // TS cast still claims it exists — every bootstrap wake silently skipped
    // (found live on AI-1755). Pin the selection set.
    const captured: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      captured.push(body);
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof globalThis.fetch;

    await maybeBootstrapWorkflow(
      makeIssueUpdateEvent({ currentLabelIds: [WF_LABEL_ID] }) as never,
      "Bearer test-token",
    );

    const issueQuery = captured.find((b) => b.includes("IssueWithLabels"));
    expect(issueQuery).toBeDefined();
    expect(issueQuery).toContain("identifier");
    expect(issueQuery).toContain("title");
  });
});
