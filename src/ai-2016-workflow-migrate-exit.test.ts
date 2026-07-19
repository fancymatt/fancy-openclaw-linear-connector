/**
 * AI-2016: Workflow engine — shipped tickets stranded at a live state,
 * migrate-state target validation broken.
 *
 * ── Current state of the code (baseline these tests run against) ──────────────
 * AC1: Demote guard (AI-1576) blocks demote even on MERGED PRs. A ticket with
 *      merged PR + native Done should be releasable. The fix permutes the guard
 *      to skip when PRs are merged and the native state is terminal, or adds a
 *      new sanctioned terminal-exit verb.
 * AC2: migrate-state handler shares the same error for three failure modes:
 *      (a) wf: label missing → should get "could not resolve the workflow def"
 *      (b) target not in def  → should get "not a state in the live workflow def"
 *      Currently (a) fall-through to (b)'s error because the try/catch doesn't
 *      throw when labels are empty — it passes null to loadWorkflowDefById → null →
 *      falls to the same "not a state" check.
 * AC3: Bootstrap reconciliation sweep only handles UNENROLLED tickets. It does
 *      not close workflow records on enrolled tickets that are native-Done with
 *      merged PRs. A new sweep path or modification is needed.
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
import { runBootstrapReconciliationSweep } from "./bootstrap-reconciliation-sweep.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
    linearUserId: u-astrid
  - id: igor
    container: dev
    fills_roles: [dev]
    linearUserId: u-igor
`;

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
      - command: refuse-work
        to: intake
        requires_comment: true
      - command: handoff-work
        to: implementation
        requires_comment: true
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
      - command: ac-fail
        to: implementation
        requires_comment: true
      - command: request-revision
        to: implementation
        requires_comment: true
        generic: revision
      - command: needs-human
        to: intake
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "AI-2016";

/** IssueContext fetch response. */
function contextFor(state: string, delegateUserId: string | null, labels: string[] = ["wf:dev-impl", `state:${state}`], nativeState?: { id: string; name: string; type: string }): object {
  return {
    data: {
      issue: {
        labels: { nodes: labels.map((n) => ({ name: n })) },
        delegate: delegateUserId ? { id: delegateUserId } : null,
        state: nativeState ?? { id: "s-todo", name: "Todo", type: "unstarted" },
      },
    },
  };
}

/** IssueWithLabels (label ids for applyStateTransition). */
function withIdsFor(state: string): object {
  return {
    data: {
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:dev-impl" },
            ...(state ? [{ id: `${state}-lbl`, name: `state:${state}` }] : []),
          ],
        },
      },
    },
  };
}

const TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "ac-validate-lbl", name: "state:ac-validate" },
          { id: "implementation-lbl", name: "state:implementation" },
          { id: "intake-lbl", name: "state:intake" },
          { id: "done-lbl", name: "state:done" },
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

/** Merged PR attachment response. */
const MERGED_PR_ATTACHMENTS = {
  data: {
    issue: {
      attachments: {
        nodes: [
          {
            url: "https://github.com/fancymatt/some-repo/pull/42",
            sourceType: "githubPullRequest",
            metadata: { state: "merged" },
          },
        ],
      },
    },
  },
};

/** No PRs. */
const NO_PR_ATTACHMENTS = {
  data: {
    issue: {
      attachments: { nodes: [] },
    },
  },
};

/** Native Done state. */
const NATIVE_DONE = { id: "s-done", name: "Done", type: "completed" };

// ── Test infrastructure ──────────────────────────────────────────────────────

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

const errText = (res: request.Response): string =>
  (res.body?.errors?.[0]?.message as string | undefined) ?? "";

/**
 * Build a controlled fetch for the proxy integration tests.
 * - contextLabels: labels returned by IssueContext/IssueLabels queries
 * - withIdsState: state passed to IssueWithLabels
 * - nativeState: native Linear state object
 * - prResponse: attachment/PR data for IssueBranchAndPR
 * - onForwardData: called with the mutation body when a mutation is forwarded
 */
function proxyFetch(opts: {
  contextLabels: string[];
  delegate: string | null;
  withIdsState: string;
  nativeState: { id: string; name: string; type: string };
  prResponse?: object;
}): typeof globalThis.fetch {
  const { contextLabels, delegate, withIdsState, nativeState, prResponse } = opts;
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected non-Linear fetch: ${url}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const q = parsed.query ?? "";

    const json = (payload: object) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    // Delegate/labels context.
    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels") && !q.includes("IssueBranchAndPR")) {
      return json(contextFor("", delegate, contextLabels, nativeState));
    }
    // Label IDs.
    if (q.includes("IssueWithLabels")) {
      return json(withIdsFor(withIdsState));
    }
    if (q.includes("TeamLabels")) return json(TEAM_LABELS);
    if (q.includes("TeamStates")) return json(TEAM_STATES);
    // Branch/PR status.
    if (q.includes("IssueBranchAndPR")) {
      return json(prResponse ?? NO_PR_ATTACHMENTS);
    }
    // Mutations succeed.
    if (q.includes("VerifyTransitionWrite") || q.includes("PreAuthWriteCheck")) {
      return json({
        data: {
          issue: {
            labels: { nodes: contextLabels.map((n) => ({ name: n })) },
            delegate: delegate ? { id: delegate } : null,
            state: nativeState,
          },
        },
      });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { commentCreate: { success: true, comment: { id: "c-1" } }, issueUpdate: { success: true } } });
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("AI-2016: workflow migrate-exit for shipped tickets", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2016-test-"));
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
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1 ────────────────────────────────────────────────────────────────

  it("AC1: demote should release a shipped ticket (merged PR + native Done) from the spine — currently blocked by AI-1576 guard", async () => {
    // A ticket at state:intake with merged PR evidence and native Done should
    // be releasable by the steward via demote. The fix either skips the demote
    // guard when all PRs are merged, or adds a terminal-exit verb.
    //
    // THIS TEST FAILS because the current AI-1576 demote guard blocks demote
    // when ANY branch/PR exists — merged or not. The test expects success
    // (no error), but gets a "demote blocked" error.
    globalThis.fetch = proxyFetch({
      contextLabels: ["wf:dev-impl", "state:intake"],
      delegate: "u-astrid",
      withIdsState: "intake",
      nativeState: NATIVE_DONE,
      prResponse: MERGED_PR_ATTACHMENTS,
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "demote")
      .send({
        operationName: "IssueUpdate",
        query: `mutation IssueUpdate($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
        variables: { id: ISSUE_UUID },
      });

    expect(res.status).toBe(200);
    // A shipped ticket with merged PRs + native Done should be releasable.
    // The current code blocks this with a demote-guard error — the fix
    // should make this test pass (no error, ticket is demoted).
    const msg = errText(res);
    expect(msg).toBe("");
  });

  // ── AC2 ────────────────────────────────────────────────────────────────

  it("AC2: migrate-state to a valid live-def state succeeds", async () => {
    // Baselines: the current code CAN handle a valid migrate-state when
    // labels are present. This test documents that shape works.
    globalThis.fetch = proxyFetch({
      contextLabels: ["wf:dev-impl", "state:intake"],
      delegate: "u-astrid",
      withIdsState: "intake",
      nativeState: { id: "s-todo", name: "Todo", type: "unstarted" },
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "implementation")
      .send({
        operationName: "IssueUpdate",
        query: `mutation IssueUpdate($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
        variables: { id: ISSUE_UUID },
      });

    expect(res.status).toBe(200);
    const msg = errText(res);
    expect(msg).toBe("");
  });

  it("AC2: migrate-state to invalid target returns 'not a live-def state' (not the def-resolution error)", async () => {
    globalThis.fetch = proxyFetch({
      contextLabels: ["wf:dev-impl", "state:intake"],
      delegate: "u-astrid",
      withIdsState: "intake",
      nativeState: { id: "s-todo", name: "Todo", type: "unstarted" },
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "nonexistent-state")
      .send({
        operationName: "IssueUpdate",
        query: `mutation IssueUpdate($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
        variables: { id: ISSUE_UUID },
      });

    expect(res.status).toBe(200);
    const msg = errText(res);
    expect(msg).toContain("not a state in the live workflow def");
    expect(msg).not.toContain("could not resolve the workflow def");
  });

  it("AC2: migrate-state with no wf: label should return def-resolution error (not the invalid-target error)", async () => {
    // When the issue has NO wf:* label, fetchWorkflowLabels returns [], then
    // getWorkflowId([]) returns null, then loadWorkflowDefById(null) returns
    // null. Nothing throws inside the try block, so we fall through to the
    // `if (!migrateTarget || !def || ...)` check and get the WRONG error:
    // "not a state in the live workflow def" instead of
    // "could not resolve the workflow def".
    //
    // THIS TEST FAILS because the current code returns the wrong error.
    globalThis.fetch = proxyFetch({
      contextLabels: [], // NO wf:* label
      delegate: null,
      withIdsState: "", // no state
      nativeState: { id: "s-todo", name: "Todo", type: "unstarted" },
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "implementation")
      .send({
        operationName: "IssueUpdate",
        query: `mutation IssueUpdate($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
        variables: { id: ISSUE_UUID },
      });

    expect(res.status).toBe(200);
    const msg = errText(res);
    // Should report the def-resolution failure because the wf: label is missing.
    // But current code returns the "not a state" error instead.
    expect(msg).toContain("could not resolve the workflow def");
    // Must NOT say "not a state" — that's the wrong error for missing wf label.
    expect(msg).not.toContain("not a state in the live workflow def");
  });

  // ── AC3 ────────────────────────────────────────────────────────────────

  it("AC3: reconciliation sweep should close workflow record on native-Done + merged PR tickets (currently does nothing)", async () => {
    // The bootstrap reconciliation sweep only handles UNENROLLED tickets
    // (wf:* present, no state:*). An enrolled ticket that is native-Done
    // with merged PRs should have its wf:/state: labels stripped and
    // delegate cleared — but the current sweep does NOT do this.
    //
    // We call runBootstrapReconciliationSweep with a fetch that returns
    // an ENROLLED ticket (wf:dev-impl + state:intake) that is native-Done
    // with merged PRs. The current sweep skips it because it has a state:*
    // label. After the fix, the sweep should detect and close it.
    let sweepCalls = 0;
    const sweepFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected non-Linear fetch in test");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const q = parsed.query ?? "";

      const json = (payload: object) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      // Bootstrap reconciliation sweep's issue query.
      if (q.includes("BootstrapReconciliation")) {
        sweepCalls++;
        return json({
          data: {
            issues: {
              nodes: [
                {
                  id: ISSUE_UUID,
                  identifier: ISSUE_IDENTIFIER,
                  updatedAt: "2026-07-17T00:00:00.000Z",
                  labels: {
                    nodes: [
                      { id: "wf-lbl", name: "wf:dev-impl" },
                      { id: "intake-lbl", name: "state:intake" },
                    ],
                  },
                  delegate: { id: "u-astrid" },
                  team: { id: "team-uuid" },
                  title: "Shipped ticket",
                },
              ],
            },
          },
        });
      }
      // IssueBranchAndPR — merged PRs exist.
      if (q.includes("IssueBranchAndPR")) {
        return json(MERGED_PR_ATTACHMENTS);
      }
      // IssueContext — enrolled + native Done.
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels") && !q.includes("IssueBranchAndPR")) {
        return json(contextFor("intake", "u-astrid", ["wf:dev-impl", "state:intake"], NATIVE_DONE));
      }
      // IssueWithLabels
      if (q.includes("IssueWithLabels")) {
        return json(withIdsFor("intake"));
      }
      if (q.includes("TeamLabels")) return json(TEAM_LABELS);
      if (q.includes("TeamStates")) return json(TEAM_STATES);
      return json({ data: { issueUpdate: { success: true } } });
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "tok-astrid",
      nowMs: Date.now(),
      graceWindowMs: 0,
      fetchFn: sweepFetch,
    });

    expect(result.scanned).toBe(1);
    expect(sweepCalls).toBeGreaterThanOrEqual(1);

    // The fix should make the sweep strip labels and clear the delegate.
    // Current behavior: sweep skips enrolled tickets entirely (healed == 0).
    // After fix: healed should be 1 (the ticket was cleaned up).
    expect(result.healed).toBe(1);
  });

  it("AC3: reconciliation sweep must NOT strip labels on NON-terminal tickets with merged PRs (safe guard)", async () => {
    // A ticket that is NOT native-Done (still in progress) with merged PRs
    // should NOT be touched. Only native-Done + merged PR triggers the close.
    let sweepCalls = 0;
    const sweepFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected non-Linear fetch in test");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const q = parsed.query ?? "";

      const json = (payload: object) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (q.includes("BootstrapReconciliation")) {
        sweepCalls++;
        return json({
          data: {
            issues: {
              nodes: [
                {
                  id: ISSUE_UUID,
                  identifier: ISSUE_IDENTIFIER,
                  updatedAt: "2026-07-17T00:00:00.000Z",
                  labels: {
                    nodes: [
                      { id: "wf-lbl", name: "wf:dev-impl" },
                      { id: "intake-lbl", name: "state:intake" },
                    ],
                  },
                  delegate: { id: "u-astrid" },
                  team: { id: "team-uuid" },
                  title: "Non-terminal ticket",
                },
              ],
            },
          },
        });
      }
      if (q.includes("IssueBranchAndPR")) {
        return json(MERGED_PR_ATTACHMENTS);
      }
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels") && !q.includes("IssueBranchAndPR")) {
        // NON-terminal state (Todo, not Done)
        return json(contextFor("intake", "u-astrid", ["wf:dev-impl", "state:intake"], { id: "s-todo", name: "Todo", type: "unstarted" }));
      }
      if (q.includes("IssueWithLabels")) {
        return json(withIdsFor("intake"));
      }
      if (q.includes("TeamLabels")) return json(TEAM_LABELS);
      if (q.includes("TeamStates")) return json(TEAM_STATES);
      return json({ data: { issueUpdate: { success: true } } });
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "tok-astrid",
      nowMs: Date.now(),
      graceWindowMs: 0,
      fetchFn: sweepFetch,
    });

    expect(result.scanned).toBe(1);
    expect(sweepCalls).toBeGreaterThanOrEqual(1);
    // Non-terminal ticket must NOT be healed even after the fix.
    // But wait — the current code only handles unenrolled, so healed IS 0.
    // After the fix, the sweep MUST still skip non-terminal. So this
    // test should pass both before AND after the fix IF the fix is correct.
    // However against current code: the sweep currently skips ALL enrolled
    // tickets, so healed is 0. This test documents correct future behavior.
    // It currently passes because the sweep doesn't touch enrolled at all.
    expect(result.healed).toBe(0);
  });
});
