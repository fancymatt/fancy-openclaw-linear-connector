/**
 * INF-203 — Sprint-spawner scan leaves get trapped: mis-enrolled in parent
 * workflow, no governed terminal exit.
 *
 * Four regressions covered:
 *   1. Linear's first-class "duplicate" state type (verified live on the LIF
 *      team: state "Duplicate" reports type "duplicate", NOT "canceled") is
 *      recognized as terminal by the shared predicate.
 *   2. The engagement overlay must never re-drive a natively-terminal ticket
 *      (this is exactly how LIF-143's Duplicate disposition was reverted to
 *      To Do — the overlay resolved native state from the workflow label and
 *      stomped the Duplicate).
 *   3. `park` is B1-legal from any state on a governed ticket for a
 *      workflow:break-glass holder (governed de-enrollment hatch), and blocked
 *      for other agents.
 *   4. workflow-bootstrap's inherited-label guard: a CREATE event whose wf:*
 *      label matches the parent's wf:* label is Linear sub-issue label
 *      inheritance, not intentional enrollment — strip instead of enrolling.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { isTerminalIssueState } from "./linear-actionable.js";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { maybeBootstrapWorkflow } from "./workflow-bootstrap.js";
import { applyEngagementStatus } from "./engagement-status.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import type { LinearEvent } from "./webhook/schema.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEV_IMPL_YAML = `
id: dev-impl
version: 8
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
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: grover
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
`;

const AGENTS_JSON = JSON.stringify({
  agents: [
    {
      name: "grover",
      linearUserId: "grover-linear-id",
      clientId: "c1",
      clientSecret: "s1",
      accessToken: "tok-grover",
      refreshToken: "r1",
      openclawAgent: "grover",
    },
  ],
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inf-203-test-"));
  const defsDir = path.join(tmpDir, "defs");
  await fs.mkdir(defsDir);
  await fs.writeFile(path.join(defsDir, "dev-impl.yaml"), DEV_IMPL_YAML);
  const policyFile = path.join(tmpDir, "policy.yaml");
  await fs.writeFile(policyFile, POLICY_YAML);
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
  resetConfigHealth();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── 1. Duplicate is terminal ─────────────────────────────────────────────────

describe("INF-203 AC: Duplicate state is terminal", () => {
  it("recognizes Linear's first-class 'duplicate' state TYPE as terminal", () => {
    expect(isTerminalIssueState({ name: "Duplicate", type: "duplicate" })).toBe(true);
  });

  it("recognizes a 'Duplicate' state NAME as terminal regardless of type", () => {
    expect(isTerminalIssueState({ name: "Duplicate", type: "started" })).toBe(true);
  });

  it("still treats completed/canceled as terminal and open states as live", () => {
    expect(isTerminalIssueState({ name: "Done", type: "completed" })).toBe(true);
    expect(isTerminalIssueState({ name: "Invalid", type: "canceled" })).toBe(true);
    expect(isTerminalIssueState({ name: "Doing", type: "started" })).toBe(false);
    expect(isTerminalIssueState({ name: "To Do", type: "unstarted" })).toBe(false);
  });
});

// ── 2. Engagement overlay native-terminal immunity ───────────────────────────

describe("INF-203 AC: engagement overlay never re-drives a natively-terminal ticket", () => {
  it("skips a workflow ticket whose native state type is 'duplicate' (LIF-143 stomp repro)", async () => {
    const mutations: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("issueUpdate")) {
        mutations.push(bodyText);
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      // Issue fetch: enrolled labels but native Duplicate.
      return jsonResponse({
        data: {
          issue: {
            id: "lif-143-uuid",
            team: { id: "team-lif" },
            state: { id: "dup-state-id", name: "Duplicate", type: "duplicate" },
            labels: { nodes: [{ name: "wf:sprint-spawner" }, { name: "state:evaluating" }] },
            delegate: null,
          },
        },
      });
    }) as typeof globalThis.fetch;

    await applyEngagementStatus("linear-LIF-143", "doing", "Bearer tok");
    expect(mutations).toHaveLength(0);
  });

  it("skips natively-completed tickets the same way", async () => {
    const mutations: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("issueUpdate")) {
        mutations.push(bodyText);
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      return jsonResponse({
        data: {
          issue: {
            id: "x-uuid",
            team: { id: "team-x" },
            state: { id: "done-id", name: "Done", type: "completed" },
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: null,
          },
        },
      });
    }) as typeof globalThis.fetch;

    await applyEngagementStatus("linear-X-1", "doing", "Bearer tok");
    expect(mutations).toHaveLength(0);
  });
});

// ── 3. park B1 legality — governed de-enrollment hatch ───────────────────────

describe("INF-203 AC: park is the steward's governed de-enrollment hatch", () => {
  /** Label fetch mock for a governed ticket in dev-impl/intake. */
  function governedTicketFetch(): typeof globalThis.fetch {
    return (async (_url: unknown, init?: { body?: unknown }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("delegate")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
              delegate: null,
            },
          },
        });
      }
      return jsonResponse({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
          },
        },
      });
    }) as typeof globalThis.fetch;
  }

  it("allows park from any state for a workflow:break-glass holder", async () => {
    globalThis.fetch = governedTicketFetch();
    const result = await checkWorkflowRules("park", "issue-uuid", "Bearer tok", "grover");
    expect(result).toBeNull();
  });

  it("blocks park for an agent without workflow:break-glass, naming the requirement", async () => {
    globalThis.fetch = governedTicketFetch();
    const result = await checkWorkflowRules("park", "issue-uuid", "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("workflow:break-glass");
  });
});

// ── 4. Bootstrap inherited-label guard ───────────────────────────────────────

describe("INF-203 AC: create-event bootstrap refuses Linear-inherited parent labels", () => {
  const WF_LABEL_ID = "label-wf-dev-impl-id";

  function createEvent(): LinearEvent {
    return {
      type: "Issue",
      action: "create",
      data: {
        id: "leaf-uuid",
        identifier: "LIF-143",
        title: "Scan leaf",
        state: { id: "s1", name: "To Do", type: "unstarted" },
        priority: 0,
        priorityLabel: "No priority",
        teamId: "team-lif",
        teamKey: "LIF",
        labelIds: [WF_LABEL_ID],
        url: "https://linear.app/x/issue/LIF-143",
        createdAt: "2026-07-20T19:45:52.767Z",
        updatedAt: "2026-07-20T19:45:52.767Z",
      },
    } as unknown as LinearEvent;
  }

  it("strips the inherited wf:* label instead of enrolling when the parent carries the same label", async () => {
    const issueUpdates: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("issueUpdate")) {
        issueUpdates.push(bodyText);
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (bodyText.includes("IssueParentLabels")) {
        return jsonResponse({
          data: { issue: { parent: { id: "parent-uuid", labels: { nodes: [{ name: "wf:dev-impl" }] } } } },
        });
      }
      // IssueWithLabels context fetch
      return jsonResponse({
        data: {
          issue: {
            id: "leaf-uuid",
            identifier: "LIF-143",
            title: "Scan leaf",
            team: { id: "team-lif" },
            labels: { nodes: [{ id: WF_LABEL_ID, name: "wf:dev-impl" }] },
            delegate: null,
          },
        },
      });
    }) as typeof globalThis.fetch;

    const result = await maybeBootstrapWorkflow(createEvent(), "Bearer tok");
    expect(result).toEqual({ action: "demoted" });
    // The strip mutation ran and removed the wf label id.
    expect(issueUpdates.length).toBeGreaterThan(0);
    expect(issueUpdates[0]).not.toContain(WF_LABEL_ID);
  });

  it("does NOT strip when the issue has no parent (top-level enroll-at-create still bootstraps)", async () => {
    const issueUpdates: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (bodyText.includes("issueUpdate")) {
        issueUpdates.push(bodyText);
        // Fail the label application so bootstrap returns null without needing
        // the full entry-state fixture chain — the assertion is only that the
        // inherited-label guard did NOT fire ("demoted").
        return jsonResponse({ data: { issueUpdate: { success: false } } });
      }
      if (bodyText.includes("IssueParentLabels")) {
        return jsonResponse({ data: { issue: { parent: null } } });
      }
      if (bodyText.includes("TeamStates")) {
        return jsonResponse({ data: { team: { states: { nodes: [{ id: "todo-id", name: "To Do", type: "unstarted" }] } } } });
      }
      return jsonResponse({
        data: {
          issue: {
            id: "leaf-uuid",
            identifier: "LIF-150",
            title: "Deliberate enroll",
            team: { id: "team-lif" },
            labels: { nodes: [{ id: WF_LABEL_ID, name: "wf:dev-impl" }] },
            delegate: null,
          },
        },
      });
    }) as typeof globalThis.fetch;

    const result = await maybeBootstrapWorkflow(createEvent(), "Bearer tok");
    // Whatever the bootstrap outcome with this minimal fixture, the inherited-label
    // guard must not have demoted the ticket.
    expect(result?.action === "demoted" ? "demoted" : "not-demoted").toBe("not-demoted");
  });
});
