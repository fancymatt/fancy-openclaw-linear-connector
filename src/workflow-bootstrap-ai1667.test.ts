/**
 * AI-1667 — Connector does not fully bootstrap tickets created with wf: label already attached.
 *
 * INTENTIONALLY FAILING. These tests define the contract the implementation must satisfy.
 * Run `npm test -- workflow-bootstrap-ai1667` to confirm all are red before implementation.
 *
 * Root cause: maybeBootstrapWorkflow gates on `event.action !== "update"` (workflow-bootstrap.ts:142),
 * which causes it to return null for create events. On a create event with wf:dev-impl already
 * attached, enrollIfMissing stamps state:intake but never sets a delegate — ticket sits idle.
 *
 * AC-to-test mapping:
 *   AC1: create event with wf:dev-impl → bootstrapped (state label + delegate set)
 *   AC2: update path (wf: added later) still works — no regression
 *   AC3: create event with wf:dev-impl in labelIds → maybeBootstrapWorkflow returns "bootstrapped"
 *   AC4: no duplicate bootstrap — create bootstrap + subsequent update with state:* present → null
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { maybeBootstrapWorkflow } from "./workflow-bootstrap.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Workflow defs (mirrors workflow-bootstrap.test.ts) ─────────────────────

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

// ── Constants ──────────────────────────────────────────────────────────────

const ISSUE_INTERNAL_ID = "issue-internal-uuid-1667";
const TEAM_ID = "team-uuid-1667";
const WF_LABEL_ID = "label-wf-dev-impl-1667";
const STATE_INTAKE_LABEL_ID = "label-state-intake-1667";

// ── Setup ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-ai1667-test-"));

  const defsDir = path.join(tmpDir, "defs");
  await fs.mkdir(defsDir);
  await fs.writeFile(path.join(defsDir, "dev-impl.yaml"), DEV_IMPL_YAML);
  await fs.writeFile(path.join(tmpDir, "policy.yaml"), POLICY_YAML);
  await fs.writeFile(path.join(tmpDir, "agents.json"), AGENTS_JSON);

  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
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

// ── Fetch mock ─────────────────────────────────────────────────────────────

const TEAM_LABELS = [
  { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
  { id: WF_LABEL_ID, name: "wf:dev-impl" },
];

function makeBootstrapFetch(opts: {
  currentLabelNames: string[];
  mutationSuccess?: boolean;
}): typeof globalThis.fetch {
  const mutationSuccess = opts.mutationSuccess ?? true;
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";

    if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: ISSUE_INTERNAL_ID,
              team: { id: TEAM_ID },
              labels: {
                nodes: opts.currentLabelNames.map((name) => {
                  const known = TEAM_LABELS.find((l) => l.name === name);
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

    if (body.includes("labels") && body.includes(TEAM_ID)) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: TEAM_LABELS } } } }),
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

// ── Event factory: create event (no updatedFrom) ───────────────────────────

function makeIssueCreateEvent(opts: { currentLabelIds: string[] }) {
  return {
    type: "Issue" as const,
    action: "create" as const,
    actor: { id: "human-user-id", name: "Human" },
    createdAt: "2026-06-22T20:33:00.000Z",
    data: {
      id: ISSUE_INTERNAL_ID,
      identifier: "AI-1667",
      title: "Test ticket created with wf: label pre-attached",
      description: "Reproduces the AI-1667 bootstrap gap",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: TEAM_ID,
      teamKey: "AI",
      labelIds: opts.currentLabelIds,
      url: "https://linear.app/test/issue/AI-1667",
      createdAt: "2026-06-22T20:33:00.000Z",
      updatedAt: "2026-06-22T20:33:00.000Z",
    },
    // No updatedFrom on a create event — all labels in the payload are "added"
    raw: {},
  };
}

function makeIssueUpdateEvent(opts: {
  currentLabelIds: string[];
  previousLabelIds?: string[];
}) {
  return {
    type: "Issue" as const,
    action: "update" as const,
    actor: { id: "human-user-id", name: "Human" },
    createdAt: "2026-06-22T20:34:00.000Z",
    data: {
      id: ISSUE_INTERNAL_ID,
      identifier: "AI-1667",
      title: "Test ticket",
      description: "",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: TEAM_ID,
      teamKey: "AI",
      labelIds: opts.currentLabelIds,
      url: "https://linear.app/test/issue/AI-1667",
      createdAt: "2026-06-22T20:33:00.000Z",
      updatedAt: "2026-06-22T20:34:00.000Z",
    },
    updatedFrom: {
      labelIds: opts.previousLabelIds ?? [],
    },
    raw: {},
  };
}

// ── AC1 / AC3: create event bootstraps fully ──────────────────────────────

describe("AC1/AC3: create event with wf:dev-impl pre-attached → maybeBootstrapWorkflow bootstraps", () => {
  it("returns bootstrapped result (not null) for a create event with wf:dev-impl", async () => {
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] });

    const event = makeIssueCreateEvent({ currentLabelIds: [WF_LABEL_ID] });

    // FAILS against current implementation: maybeBootstrapWorkflow gates on
    // action !== "update" and returns null for create events (workflow-bootstrap.ts:142)
    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).not.toBeNull();
    expect(result?.action).toBe("bootstrapped");
  });

  it("AC1: bootstraps to the correct entry state (intake) on a create event", async () => {
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] });

    const event = makeIssueCreateEvent({ currentLabelIds: [WF_LABEL_ID] });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    // FAILS: returns null today because create events are filtered out
    expect(result?.workflowId).toBe("dev-impl");
    expect(result?.entryState).toBe("intake");
  });

  it("AC1: create event bootstrap calls mutation with state:intake label and astrid delegate", async () => {
    const mutationBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationBodies.push(body);
      }
      return makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] })(url, init);
    };

    const event = makeIssueCreateEvent({ currentLabelIds: [WF_LABEL_ID] });

    await maybeBootstrapWorkflow(event, "test-token");

    // FAILS: no mutation is issued today because the function returns null immediately
    expect(mutationBodies.length).toBeGreaterThan(0);
    expect(mutationBodies.some((b) => b.includes(STATE_INTAKE_LABEL_ID))).toBe(true);
    expect(mutationBodies.some((b) => b.includes("astrid-linear-id"))).toBe(true);
  });
});

// ── AC2: update path still works (regression) ─────────────────────────────

describe("AC2: update path (wf: label added later) still works after fix", () => {
  it("returns bootstrapped for an update event adding wf:dev-impl to an ad-hoc ticket", async () => {
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] });

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID],
      previousLabelIds: [],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    // This path PASSES today — regression test ensures fix doesn't break it
    expect(result).not.toBeNull();
    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("dev-impl");
    expect(result?.entryState).toBe("intake");
  });
});

// ── AC4: no duplicate bootstrap ────────────────────────────────────────────

describe("AC4: no duplicate bootstrap — create event bootstraps, subsequent update is a no-op", () => {
  it("returns null for an update event when state:intake is already present (post-create-bootstrap idempotency)", async () => {
    // Simulates the state after a create-event bootstrap stamped state:intake.
    // The subsequent update event (e.g. from enrollIfMissing or any field change)
    // must NOT re-bootstrap.
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["wf:dev-impl", "state:intake"],
    });

    const event = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
      previousLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
    });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    // Existing idempotency guard (state:* present → return null) covers this.
    // Passes today — confirms the guard still holds after the create-path fix.
    expect(result).toBeNull();
  });

  it("create + update sequence: create bootstraps once, next update is null", async () => {
    // Step 1: create event with wf:dev-impl → should bootstrap
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: ["wf:dev-impl"] });
    const createEvent = makeIssueCreateEvent({ currentLabelIds: [WF_LABEL_ID] });
    const createResult = await maybeBootstrapWorkflow(createEvent, "test-token");

    // FAILS today because create event returns null
    expect(createResult?.action).toBe("bootstrapped");

    // Step 2: subsequent update event (now state:intake is present on the ticket)
    globalThis.fetch = makeBootstrapFetch({
      currentLabelNames: ["wf:dev-impl", "state:intake"],
    });
    const updateEvent = makeIssueUpdateEvent({
      currentLabelIds: [WF_LABEL_ID, STATE_INTAKE_LABEL_ID],
      previousLabelIds: [WF_LABEL_ID],
    });
    const updateResult = await maybeBootstrapWorkflow(updateEvent, "test-token");

    expect(updateResult).toBeNull();
  });
});

// ── Edge: create event with no wf: label is a no-op ──────────────────────

describe("Edge: create event without wf: label is a no-op", () => {
  it("returns null for a create event with no wf: label", async () => {
    globalThis.fetch = makeBootstrapFetch({ currentLabelNames: ["bug"] });

    const event = makeIssueCreateEvent({ currentLabelIds: ["label-bug-id"] });

    const result = await maybeBootstrapWorkflow(event, "test-token");

    expect(result).toBeNull();
  });
});
