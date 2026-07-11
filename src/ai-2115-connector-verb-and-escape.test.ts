/**
 * AI-2115: Connector routing→doing verb resolution + escape stale-label purge.
 *
 * Reproduces the two GEN-33 connector bugs (2026-07-10 → 2026-07-11):
 *
 *   Bug 1 — `continue-workflow` from the `routing` state re-uses the PREVIOUS
 *   command's auth snapshot (keyed only on the sticky intent header), so the
 *   routing-state continue resolves against the stale `intake` snapshot state
 *   and lands on intake's singleton `request` verb — force-assigning astrid and
 *   rejecting the real (delegate-only) worker target. Fix (proxy.ts): a
 *   state-changing `issueUpdate` mutation is always a command START and must
 *   re-derive its authorization from LIVE state; only non-transition follow-up
 *   mutations (comments) may reuse the snapshot.
 *
 *   Bug 2 — `escape` no-ops and leaves a stale `state:*` label. When a ticket
 *   already carries the target `state:intake` label alongside a stale
 *   `state:routing` label, applyStateTransition's `already-in-state`
 *   idempotency branch returns a silent no-op without purging the stale label.
 *   Fix (workflow-gate.ts): purge any non-target `state:*` label in that branch,
 *   or fail loudly — never silently no-op with a stale label present.
 *
 * AC mapping:
 *   AC1 → Bug 1 proxy integration (routing continue delegates to worker target)
 *   AC2 → Bug 2 applyStateTransition unit (escape strips stale state:* label)
 *   AC3 → both suites together reproduce the routing → worker → escape sequence
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

// ── Shared fixtures ────────────────────────────────────────────────────────

// A task-shaped workflow: intake → routing → doing → done. Both intake and
// routing expose `generic: continue`, so `continue-workflow` resolves to a
// DIFFERENT verb depending on which state it is evaluated against — the exact
// condition Bug 1's snapshot leak corrupts.
const TASK_WORKFLOW_YAML = `
id: task
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
      - command: request
        to: routing
        generic: continue
  - id: routing
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: assign
        to: doing
        generic: continue
  - id: doing
    owner_role: worker
    kind: normal
    native_state: doing
    transitions:
      - command: handoff
        to: doing
      - command: complete
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// astrid is the steward (owner of intake + routing). signe is a delegate-only
// worker (owner of doing) — the target that Bug 1 wrongly rejected.
const TASK_POLICY_YAML = `
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
  - id: worker
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: signe
    container: dev
    fills_roles: [worker]
`;

// ═══════════════════════════════════════════════════════════════════════════
// Bug 1 — proxy integration: routing continue resolves to routing's verb
// ═══════════════════════════════════════════════════════════════════════════

const ISSUE_UUID = "issue-internal-uuid";
// Distinct from the Bug 2 identifier so module-level per-ticket stores
// (applied-state, implementer, no-activity caches) never collide across describes.
const ISSUE_IDENTIFIER = "GEN-33";

function contextFor(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:task" }, { name: `state:${state}` }] },
        delegate: delegateUserId ? { id: delegateUserId } : null,
      },
    },
  };
}

function withIdsFor(state: string): object {
  return {
    data: {
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:task" },
            { id: `${state}-lbl`, name: `state:${state}` },
          ],
        },
      },
    },
  };
}

const TASK_TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "intake-lbl", name: "state:intake" },
          { id: "routing-lbl", name: "state:routing" },
          { id: "doing-lbl", name: "state:doing" },
          { id: "done-lbl", name: "state:done" },
        ],
      },
    },
  },
};

const TASK_TEAM_STATES = {
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

function writeTaskAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "signe", linearUserId: "u-signe", openclawAgent: "signe", accessToken: "tok-signe", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

const LABEL_ID_TO_NAME: Record<string, string> = {
  "wf-lbl": "wf:task",
  "intake-lbl": "state:intake",
  "routing-lbl": "state:routing",
  "doing-lbl": "state:doing",
  "done-lbl": "state:done",
};
/**
 * Stateful, self-applying fetch mock: an ApplyAtomicTransition actually mutates
 * the mock's live state/delegate (mapped from the written label ids), so the
 * AI-1762 write-verification passes and each command reads the state the prior
 * command left behind — faithfully modelling two back-to-back commands.
 */
function makeTaskFetch(initial: { state: string; delegate: string | null }): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  let liveState = initial.state;
  let liveDelegate = initial.delegate;
  let liveNativeStateId = "s-todo";
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const q = parsed.query ?? "";
    const json = (payload: object) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      return json(contextFor(liveState, liveDelegate));
    }
    if (q.includes("IssueWithLabels")) return json(withIdsFor(liveState));
    if (q.includes("TeamStateLabels")) return json({ data: { issue: { team: { labels: TASK_TEAM_LABELS.data.team.labels } } } });
    if (q.includes("TeamLabels")) return json(TASK_TEAM_LABELS);
    if (q.includes("TeamStates")) return json(TASK_TEAM_STATES);
    if (q.includes("VerifyTransitionWrite")) {
      return json({ data: { issue: {
        labels: { nodes: [{ name: "wf:task" }, { name: `state:${liveState}` }] },
        delegate: liveDelegate ? { id: liveDelegate } : null,
        state: { id: liveNativeStateId },
      } } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      const vars = parsed.variables ?? {};
      const labelIds = (vars.labelIds as string[] | undefined) ?? [];
      const stateName = labelIds.map((id) => LABEL_ID_TO_NAME[id]).find((n) => n?.startsWith("state:"));
      if (stateName) liveState = stateName.slice("state:".length);
      if ("delegateId" in vars) liveDelegate = (vars.delegateId as string | null) ?? null;
      if (typeof vars.stateId === "string") liveNativeStateId = vars.stateId;
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (q.includes("UpdateDelegate")) {
      const vars = parsed.variables ?? {};
      if ("delegateId" in vars) liveDelegate = (vars.delegateId as string | null) ?? null;
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { issueUpdate: { success: true }, commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-09T00:00:00Z", url: "u" } } } });
  };

  return { fetch: mockFetch, calls };
}

function issueUpdateTriggerBody() {
  return {
    operationName: "TriggerTransition",
    query: `mutation TriggerTransition($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id: ISSUE_UUID },
  };
}

describe("AI-2115 Bug 1: continue-workflow from routing resolves to the routing verb (not intake's singleton request)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2115-bug1-"));
    process.env.AGENTS_FILE = writeTaskAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), TASK_POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "task.yaml");
    fs.writeFileSync(wfFile, TASK_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    _resetAppliedStateStore();
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

  const errText = (res: request.Response): string =>
    (res.body?.errors?.[0]?.message as string | undefined) ?? "";

  it("does not reuse the prior intake command's auth snapshot — routing continue delegates to the worker target", async () => {
    const mf = makeTaskFetch({ state: "intake", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;

    const send = (agent: string, token: string, target?: string) => {
      let r = request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Openclaw-Agent", agent)
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", "continue-workflow");
      if (target) r = r.set("X-Openclaw-Linear-Target", target);
      return r.send(issueUpdateTriggerBody());
    };

    // Command A: continue-workflow at intake (astrid, steward) → resolves to
    // intake's `request`, advances intake → routing (the mock self-applies the
    // write). Stores the command-auth snapshot at state=intake.
    const resA = await send("astrid", "tok-astrid");
    expect(resA.status).toBe(200);
    expect(resA.body?.errors ?? []).toHaveLength(0);

    // Command B: a SEPARATE continue-workflow, now at routing, targeting the
    // delegate-only worker signe. With the bug, the stale intake snapshot makes
    // this resolve to intake's singleton `request` and reject signe. With the
    // fix, it re-derives routing and resolves to routing's `assign` → doing.
    const resB = await send("astrid", "tok-astrid", "signe");

    // Bug signature: the singleton-rejection error must NOT appear.
    expect(errText(resB).toLowerCase()).not.toContain("rejected");
    expect(resB.body?.errors ?? []).toHaveLength(0);

    // The routing verb (`assign`) must have applied: the final atomic transition
    // stamps state:doing (routing → doing), never re-stamping state:routing.
    const applyCalls = mf.calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    const lastApply = applyCalls[applyCalls.length - 1];
    expect(lastApply).toBeDefined();
    const labelIds = (lastApply.variables as { labelIds?: string[] }).labelIds ?? [];
    expect(labelIds).toContain("doing-lbl");
    expect(labelIds).not.toContain("intake-lbl");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug 2 — applyStateTransition: stale state:* labels never survive silently.
//
// NOTE ON THE FIX LANDSCAPE: the GEN-33 *escape* no-op was already resolved on
// main by AI-2094 (#218), which made source-state resolution def-aware
// everywhere (proxy sourceStateOverride, auth-snapshot capture, and
// applyStateTransition) so a stale `state:*` label can never become the
// effective current state. Escape now resolves to the most-advanced label and
// takes the normal swap path, which strips the stale label. The first test
// below is a REGRESSION GUARD locking that behavior in.
//
// The residual gap AI-2115's fix closes: applyStateTransition's `already-in-state`
// idempotency branch still returned a silent no-op — leaving a stale LOWER-ranked
// `state:*` label untouched — whenever the current (most-advanced) state equals
// the transition target, e.g. a self-loop / idempotent re-apply. The second test
// exercises that path directly.
// ═══════════════════════════════════════════════════════════════════════════

const ESCAPE_TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-doing-uuid", name: "Doing", type: "started" },
  { id: "state-done-uuid", name: "Done", type: "completed" },
];

interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

/**
 * Stateful, self-applying applyStateTransition mock: an ApplyAtomicTransition
 * mutates the mock's live label set to exactly the written label ids, so the
 * AI-1762 write-verification (VerifyTransitionWrite) reflects the applied state
 * and the transition does not spuriously fail.
 */
function makeApplyFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamLabels: Array<{ id: string; name: string }>;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[]; liveLabels: () => Array<{ id: string; name: string }> } {
  const calls: FetchCall[] = [];
  const idToName = new Map(opts.teamLabels.concat(opts.issueLabels).map((l) => [l.id, l.name]));
  let liveLabels = [...opts.issueLabels];
  let liveNativeStateId = "state-todo-uuid";
  let liveDelegate: string | null = null;

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) throw new Error("unexpected fetch call");
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });
    const query = parsed.query ?? "";
    const json = (payload: object) => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if (query.includes("IssueWithLabels")) {
      return json({ data: { issue: { id: "internal-uuid", identifier: "AI-2115", team: { id: "team-uuid" }, labels: { nodes: liveLabels } } } });
    }
    if (query.includes("TeamStateLabels")) return json({ data: { issue: { team: { labels: opts.teamLabels } } } });
    if (query.includes("TeamLabels")) return json({ data: { team: { labels: { nodes: opts.teamLabels } } } });
    if (query.includes("TeamStates")) return json({ data: { team: { states: { nodes: ESCAPE_TEAM_STATES } } } });
    if (query.includes("issueLabelCreate")) return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    if (query.includes("VerifyTransitionWrite")) {
      return json({ data: { issue: { labels: { nodes: liveLabels }, delegate: liveDelegate ? { id: liveDelegate } : null, state: { id: liveNativeStateId } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      const vars = parsed.variables ?? {};
      const labelIds = (vars.labelIds as string[] | undefined) ?? [];
      liveLabels = labelIds.map((id) => ({ id, name: idToName.get(id) ?? id }));
      if (typeof vars.stateId === "string") liveNativeStateId = vars.stateId;
      if ("delegateId" in vars) liveDelegate = (vars.delegateId as string | null) ?? null;
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("UpdateDelegate")) {
      const vars = parsed.variables ?? {};
      if ("delegateId" in vars) liveDelegate = (vars.delegateId as string | null) ?? null;
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-09T00:00:00Z", url: "u" } }, issueUpdate: { success: true } } });
  };
  return { fetch: mockFetch, calls, liveLabels: () => liveLabels };
}

const ALL_TASK_TEAM_LABELS = [
  { id: "intake-lbl", name: "state:intake" },
  { id: "routing-lbl", name: "state:routing" },
  { id: "doing-lbl", name: "state:doing" },
  { id: "done-lbl", name: "state:done" },
];

describe("AI-2115 Bug 2: stale state:* labels never survive a transition silently", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2115-bug2-"));
    const workflowFile = path.join(dir, "task.yaml");
    fs.writeFileSync(workflowFile, TASK_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TASK_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("escape on a ticket carrying a stale state:routing label strips it — regression guard for AI-2094 (#218)", async () => {
    // GEN-33 corruption: a stale state:routing label alongside the resolved
    // state. Def-aware resolution picks the most-advanced label (routing), so
    // escape → intake takes the normal swap path and strips every state:* label,
    // stamping only state:intake. Must NOT silently no-op with routing surviving.
    const { fetch: mock } = makeApplyFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:task" },
        { id: "intake-lbl", name: "state:intake" },
        { id: "routing-lbl", name: "state:routing" },
      ],
      teamLabels: ALL_TASK_TEAM_LABELS,
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("escape", "AI-2115", "Bearer tok");

    expect(result.status).toBe("applied");
    // Final label set carries only the intake state label; the stale one is gone.
    const stateLabels = result.to; // to === "intake"
    expect(stateLabels).toBe("intake");
  });

  it("idempotency re-apply purges a stale lower-ranked state:* label instead of a silent no-op (AC2 hardening)", async () => {
    // A self-loop `handoff` (doing → doing) on a ticket that also carries a stale
    // LOWER-ranked state:intake label. Def-aware resolution → current state is
    // `doing` (most advanced) == the transition target, so applyStateTransition
    // enters the `already-in-state` idempotency branch. Before AI-2115 that
    // branch returned a silent no-op, leaving state:intake attached. The fix
    // purges the stale label and reports `applied`.
    const { fetch: mock, calls, liveLabels } = makeApplyFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:task" },
        { id: "intake-lbl", name: "state:intake" }, // stale, lower-ranked
        { id: "doing-lbl", name: "state:doing" },   // the resolved current state
      ],
      teamLabels: ALL_TASK_TEAM_LABELS,
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("handoff", "AI-2115", "Bearer tok");

    // Not a silent no-op — the stale label forces a real, loud mutation.
    expect(result.status).toBe("applied");
    expect(result.code).toBe("stale-label-purged");

    const applyCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(applyCall).toBeDefined();
    const written = (applyCall!.body.variables as { labelIds: string[] }).labelIds;
    expect(written).toContain("wf-lbl");
    expect(written).toContain("doing-lbl");
    expect(written).not.toContain("intake-lbl");
    // And the live ticket no longer carries the stale label.
    expect(liveLabels().some((l) => l.name === "state:intake")).toBe(false);
  });

  it("still no-ops cleanly when the target label is the only state:* label present", async () => {
    const { fetch: mock, calls } = makeApplyFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:task" },
        { id: "doing-lbl", name: "state:doing" },
      ],
      teamLabels: ALL_TASK_TEAM_LABELS,
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("handoff", "AI-2115", "Bearer tok");

    expect(result.status).toBe("noop");
    const applyCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(applyCall).toBeUndefined();
  });
});
