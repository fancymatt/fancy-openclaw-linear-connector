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
