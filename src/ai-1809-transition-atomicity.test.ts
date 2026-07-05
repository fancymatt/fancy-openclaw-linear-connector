/**
 * AI-1809: Workflow transitions must not partially apply when the required
 * comment was duplicate-blocked client-side.
 *
 * Live incident (AI-1773, 2026-07-05 ~11:15Z): a prior blocked handoff-work
 * attempt had already posted the ac-fail feedback comment. The subsequent
 * `ac-fail --target <dev>` hit the CLI's near-duplicate detection, so the
 * transition trigger arrived at the proxy WITHOUT a commentCreate, carrying
 * X-Openclaw-Comment-Satisfied-By instead (CLI ≥0.3.6). The ticket ended up
 * split: native status advanced, `state:ac-validate` label and delegate did
 * not — and the proxy then refused normal recovery because it still read the
 * ticket as ac-validate. Nothing machine-readable surfaced the failure.
 *
 * AC mapping (AI-1809 deliverables):
 *   AC1 (regression): pre-existing identical comment → ac-fail with
 *       satisfied-by → the FULL transition applies atomically (state label +
 *       delegate + native status in one ApplyAtomicTransition mutation) and
 *       the response carries `_workflowTransition.status === "applied"`.
 *   AC2 (no silent partial apply): when the atomic mutation genuinely fails,
 *       the response carries a machine-readable
 *       `_workflowTransition: { status: "failed", code: "atomic-mutation-failed" }`
 *       — never a success payload with only a server-side log line.
 *   AC3 (shape preservation): non-workflow (ad-hoc) traffic keeps its exact
 *       upstream response shape — no `_workflowTransition` annotation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// Minimal dev-impl shaped workflow: the ac-validate → ac-fail → implementation
// edge from the incident, with requires_comment on ac-fail (as canonical).
// dev is a MULTI-body role (charles + igor) so delegate resolution requires the
// explicit CLI target — exactly the `ac-fail --target igor` shape from AI-1773.
const WORKFLOW_YAML = `
id: dev-impl
version: 9
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
        to: ac-validate
        requires_comment: true
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
      - command: ac-fail
        to: implementation
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// B1 context fetch: ticket sits in ac-validate, delegated to the steward.
const AC_VALIDATE_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
      delegate: { id: "u-astrid" },
    },
  },
};

// B2 transition fetch: label IDs + team + internal id.
const AC_VALIDATE_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      identifier: "AI-1773",
      team: { id: "team-uuid" },
      labels: {
        nodes: [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "acv-lbl", name: "state:ac-validate" },
        ],
      },
    },
  },
};

const TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "acv-lbl", name: "state:ac-validate" },
          { id: "impl-lbl", name: "state:implementation" },
        ],
      },
    },
  },
};

const TEAM_STATES = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-doing", name: "Doing", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    },
  },
};

// The pre-existing feedback comment the CLI dedup'd against: recent, on this
// issue, authored by the calling steward.
const EXISTING_FEEDBACK_COMMENT = {
  id: "comment-dup-1",
  createdAt: new Date(Date.now() - 20_000).toISOString(),
  user: { id: "u-astrid" },
  issue: { id: "issue-uuid", identifier: "AI-1773" },
};

const AD_HOC_CONTEXT = {
  data: { issue: { labels: { nodes: [] as Array<{ name: string }> }, delegate: null } },
};

const AD_HOC_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      identifier: "AI-1773",
      team: { id: "team-uuid" },
      labels: { nodes: [] as Array<{ id: string; name: string }> },
    },
  },
};

const UPSTREAM_OK = { data: { issueUpdate: { success: true, issue: { id: "issue-uuid" } } } };

// ── Test infrastructure ──────────────────────────────────────────────────

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok1", host: "local" },
      { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok2", host: "local" },
      { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok3", host: "local" },
    ],
  }), "utf8");
  return file;
}

describe("proxy — AI-1809 transition atomicity on dedup-blocked comments", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai1809-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  /**
   * Full-stack fetch mock for the ac-fail-with-satisfied-by path. Handles:
   *   IssueContext/IssueLabels — B1 validation fetch
   *   SatisfiedByComment       — AI-1769 satisfied-by verification
   *   IssueWithLabels          — B2 transition fetch
   *   TeamLabels / TeamStates  — label + native-state resolution
   *   ApplyAtomicTransition    — the single atomic facet write
   * Records every call for assertions.
   */
  function makeIncidentFetch(opts: {
    contextResponse?: object;
    satisfiedComment?: object | null;
    atomicSuccess?: boolean;
    adHoc?: boolean;
  } = {}): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: Record<string, unknown> }> } {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const json = (payload: object) => new Response(JSON.stringify(payload), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
      const q = parsed.query ?? "";

      if (q.includes("SatisfiedByComment")) {
        const comment = opts.satisfiedComment === undefined ? EXISTING_FEEDBACK_COMMENT : opts.satisfiedComment;
        return json({ data: { comment } });
      }
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
        return json(opts.contextResponse ?? AC_VALIDATE_CONTEXT);
      }
      if (q.includes("IssueWithLabels")) {
        return json(opts.adHoc ? AD_HOC_WITH_IDS : AC_VALIDATE_WITH_IDS);
      }
      if (q.includes("TeamLabels")) {
        return json(TEAM_LABELS);
      }
      if (q.includes("TeamStates")) {
        return json(TEAM_STATES);
      }
      if (q.includes("ApplyAtomicTransition")) {
        return json({ data: { issueUpdate: { success: opts.atomicSuccess ?? true } } });
      }
      return json(UPSTREAM_OK);
    };

    return { fetch: mockFetch, calls };
  }

  /** The exact request shape CLI ≥0.3.6 sends for a dedup-satisfied ac-fail. */
  function acFailWithSatisfiedBy() {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-dup-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });
  }

  // ── AC1: the AI-1773 sequence now fully applies ────────────────────────

  it("AC1: pre-existing identical comment → ac-fail applies label + delegate + native state atomically", async () => {
    const { fetch: mock, calls } = makeIncidentFetch();
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();

    // The full transition tuple went out in ONE atomic mutation.
    const atomic = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomic).toBeDefined();
    const vars = atomic!.variables as { issueId: string; labelIds: string[]; delegateId?: string; stateId?: string };
    expect(vars.issueId).toBe("internal-uuid");
    expect(vars.labelIds).toContain("impl-lbl");      // state label advanced…
    expect(vars.labelIds).not.toContain("acv-lbl");   // …and the stale one stripped
    expect(vars.delegateId).toBe("u-igor");           // delegate = explicit --target
    expect(vars.stateId).toBe("s-doing");             // native status = implementation's Doing

    // Machine-readable confirmation in the agent's response.
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(res.body._workflowTransition.from).toBe("ac-validate");
    expect(res.body._workflowTransition.to).toBe("implementation");
  });

  // ── AC2: a genuinely failed write surfaces machine-readably ────────────

  it("AC2: atomic mutation failure surfaces as _workflowTransition failed/atomic-mutation-failed", async () => {
    const { fetch: mock } = makeIncidentFetch({ atomicSuccess: false });
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("failed");
    expect(res.body._workflowTransition.code).toBe("atomic-mutation-failed");
  });

  it("AC2: an unverifiable satisfied-by reference still blocks the transition entirely (no partial apply)", async () => {
    const { fetch: mock, calls } = makeIncidentFetch({ satisfiedComment: null });
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    // Gate rejected → nothing forwarded, nothing applied: a true no-op.
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
  });

  // ── AC3: ad-hoc traffic keeps its exact response shape ─────────────────

  it("AC3: non-workflow tickets get no _workflowTransition annotation", async () => {
    const { fetch: mock } = makeIncidentFetch({ contextResponse: AD_HOC_CONTEXT, adHoc: true });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "consider-work")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: { stateId: \"s-thinking\" }) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toBeUndefined();
  });
});
