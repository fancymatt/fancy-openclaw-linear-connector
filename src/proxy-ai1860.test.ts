/**
 * AI-1860: Proxy governed transitions are non-atomic — authorization is
 * re-evaluated against POST-mutation state, so a multi-step governed command
 * self-blocks (exit 1) after its own transition applied and the required
 * comment is silently dropped.
 *
 * ── Current state of the code (baseline these tests run against) ──────────────
 * AI-1857 (commit 1a5bae6) added a per-command authorization snapshot
 * (`commandAuthSnapshots` in index.ts / proxy.ts) that snapshots the *delegate*
 * at command start: `checkWorkflowRules(..., snapshotDelegateId)` swaps the
 * snapshotted delegate in place of the live-fetched one. That fixes the
 * DELEGATE re-check dimension only.
 *
 * It does NOT fix the TRANSITION-LEGALITY dimension. In workflow-gate.ts the
 * `labels`/`currentState` used for the legality check
 * ("'<intent>' is not a legal command in state '<state>'", ~line 1772) still
 * come from the LIVE `fetchTicketContext` — so once the command's first
 * mutation flips the state, every subsequent intent-bearing mutation in the
 * same command is legality-checked against the NEW state and blocked. This is
 * exactly the AI-1848 (ac-fail), AI-1872 (continue-workflow/validated) and
 * AI-1924 (request-revision) repros.
 *
 * The implementer's job (Igor): snapshot the source STATE at command start the
 * same way the delegate is snapshotted, so neither the delegate check nor the
 * transition-legality check is re-evaluated against post-mutation state for a
 * mutation belonging to an already-authorized command.
 *
 * ── AC mapping (verbatim AC of record, captured 2026-07-09) ───────────────────
 *   AC1  Authorization (delegate AND legality) snapshotted at command start;
 *        a self-blocking exit 1 after a successful transition cannot occur.
 *          → "AC1: ac-fail second mutation is not blocked ..."
 *          → "AC1 boundary: unrelated agent with no snapshot is still blocked"
 *   AC2  Required comment for ac-fail is always delivered (repro: comment
 *        silently dropped) cannot recur.
 *          → "AC2/AC5/AI-1809: full ac-fail flow delivers the follow-up comment"
 *   AC3  Generic continue path: continue-workflow at ac-validate → validated
 *        (AI-1872) — post-mutation legality re-check cannot fail the command.
 *          → "AC3 continue-path: validated → done second mutation not blocked"
 *   AC4  Server-side audit of all multi-step governed verbs; the audited/tested
 *        set includes ac-fail, refuse-work, handoff-work, needs-human, escape,
 *        request-revision.
 *          → one AC4/* test per verb below
 *   AC5  AI-1809 extension — a test drives the full ac-fail flow and asserts the
 *        comment is posted even when the delegate changes mid-operation.
 *          → "AC2/AC5/AI-1809: full ac-fail flow delivers the follow-up comment"
 *   AC6  No governed verb can exit 1 while leaving the ticket in a state
 *        inconsistent with the command's stated outcome.
 *          → "AC6: ac-fail never exits with a blocked follow-up ..."
 *   AC7  Audit attribution (AI-1909): proxy mutation_audit rows for governed
 *        intents record a real op_name AND the invoking session identity.
 *          → "AC7 audit-attribution: ... records op_name + invoking session identity"
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

// ── Fixtures ────────────────────────────────────────────────────────────────

// astrid (steward) holds the capabilities the ac-validate verbs need
// (human:escalate for needs-human, workflow:break-glass for escape). igor and
// charles are plain dev bodies. This mirrors the real capability-policy split.
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
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: dev
    fills_roles: [dev]
`;

// dev-impl-shaped workflow. Every multi-step governed verb in the AC's audited
// set has a transition here so it can be driven through the proxy:
//   ac-validate: validated (continue), ac-fail, request-revision, needs-human
//   implementation: refuse-work, handoff-work (self-loop)
//   break_glass: escape
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
const ISSUE_IDENTIFIER = "AI-1848";

/** IssueContext (delegate/labels) fetch response for a given state. */
function contextFor(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${state}` }] },
        delegate: delegateUserId ? { id: delegateUserId } : null,
      },
    },
  };
}

/** IssueWithLabels (label ids for applyStateTransition) response. */
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
            { id: `${state}-lbl`, name: `state:${state}` },
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

// ── Test infrastructure ──────────────────────────────────────────────────────

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

/**
 * Stateful fetch mock. `currentContext` is what the delegate/legality check
 * sees; flip it with `setContext` between the two mutations of a command to
 * simulate the proxy's own applyStateTransition mutating state + delegate.
 */
function makeMutableFetch(initial: { state: string; delegate: string | null }): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  setContext: (state: string, delegate: string | null) => void;
  setWithIdsState: (state: string) => void;
} {
  let currentContext = contextFor(initial.state, initial.delegate);
  let withIdsState = initial.state;
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
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    // Delegate/legality context fetch (IssueContext / IssueLabels).
    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      return json(currentContext);
    }
    // applyStateTransition label-id fetch.
    if (q.includes("IssueWithLabels")) {
      return json(withIdsFor(withIdsState));
    }
    if (q.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: TEAM_LABELS.data.team.labels } } } });
    }
    if (q.includes("TeamLabels")) {
      return json(TEAM_LABELS);
    }
    if (q.includes("TeamStates")) {
      return json(TEAM_STATES);
    }
    if (q.includes("VerifyTransitionWrite")) {
      const ctx = currentContext as { data: { issue: { labels: unknown; delegate: unknown } } };
      return json({ data: { issue: { labels: ctx.data.issue.labels, delegate: ctx.data.issue.delegate, state: { id: "s-doing" } } } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    // Any forwarded mutation (commentCreate / issueUpdate) succeeds.
    return json({ data: { commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-09T00:00:00Z", url: "u" } }, issueUpdate: { success: true } } });
  };

  return {
    fetch: mockFetch,
    calls,
    setContext: (state, delegate) => { currentContext = contextFor(state, delegate); },
    setWithIdsState: (state) => { withIdsState = state; },
  };
}

/** commentCreate mutation body (a comment chunk). Carries issueId + a body. */
function commentCreateBody(body: string) {
  return {
    operationName: "AddComment",
    query: `mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id createdAt url } }
    }`,
    variables: { issueId: ISSUE_UUID, body },
  };
}

/** issueUpdate bare-trigger mutation (no label delta — proxy is sole state writer). */
function issueUpdateTriggerBody() {
  return {
    operationName: "TriggerTransition",
    query: `mutation TriggerTransition($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id: ISSUE_UUID },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("proxy — AI-1860: governed transitions are atomic (source-state + delegate snapshot)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai1860-test-"));
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

  /**
   * Drive a two-mutation governed command through the proxy and return the two
   * responses. Mutation 1 runs in `srcState` (caller is delegate) and is
   * expected to pass the gate + store the command auth snapshot. The context is
   * then flipped to (`dstState`, `dstDelegate`) to simulate the command's own
   * applyStateTransition, and mutation 2 (same agent + intent) is sent.
   */
  async function runTwoStepCommand(opts: {
    agent: string;
    token: string;
    intent: string;
    target?: string;
    srcState: string;
    srcDelegate: string | null;
    dstState: string;
    dstDelegate: string | null;
    first: object;
    second: object;
  }) {
    const mf = makeMutableFetch({ state: opts.srcState, delegate: opts.srcDelegate });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState(opts.srcState);

    const send = (payload: object) => {
      let r = request(appState.app)
        .post("/proxy/graphql")
        .set("Authorization", `Bearer ${opts.token}`)
        .set("X-Openclaw-Agent", opts.agent)
        .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
        .set("X-Openclaw-Linear-Intent", opts.intent);
      if (opts.target) r = r.set("X-Openclaw-Linear-Target", opts.target);
      return r.send(payload);
    };

    const res1 = await send(opts.first);
    // Command's own transition applies: state + delegate move.
    mf.setContext(opts.dstState, opts.dstDelegate);
    const res2 = await send(opts.second);
    return { res1, res2, calls: mf.calls };
  }

  const errText = (res: request.Response): string =>
    (res.body?.errors?.[0]?.message as string | undefined) ?? "";

  // ── AC1 / AC2 / AC5 / AC6 — ac-fail ─────────────────────────────────────────

  it("AC1: ac-fail second mutation is not blocked after its own transition applied (ac-validate → implementation)", async () => {
    // astrid is delegate at ac-validate. ac-fail's first comment passes the gate
    // and moves the ticket to implementation (delegate → igor). The second
    // comment chunk must NOT be re-gated against the post-transition state.
    const { res1, res2 } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "ac-fail",
      target: "igor",
      srcState: "ac-validate",
      srcDelegate: "u-astrid",
      dstState: "implementation",
      dstDelegate: "u-igor",
      first: commentCreateBody("AC failure — chunk 1: detailed findings."),
      second: commentCreateBody("AC failure — chunk 2: appendix."),
    });

    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    expect(res2.status).toBe(200);
    // BUG (baseline): legality re-checked against 'implementation' →
    // "'ac-fail' is not a legal command in state 'implementation'". FIX: pass.
    expect(errText(res2)).not.toMatch(/not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC2/AC5/AI-1809: full ac-fail flow delivers the follow-up comment even though delegate+state changed mid-command", async () => {
    // The required ac-fail comment must reach Linear. If the second mutation is
    // blocked, the comment is dropped — exactly the AI-1848 incident.
    const { res2, calls } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "ac-fail",
      target: "igor",
      srcState: "ac-validate",
      srcDelegate: "u-astrid",
      dstState: "implementation",
      dstDelegate: "u-igor",
      first: commentCreateBody("AC failure — reason for the implementer."),
      second: commentCreateBody("AC failure — appendix with repro steps."),
    });

    expect(res2.body.errors).toBeUndefined();
    // The second comment must have been forwarded upstream (delivered), not dropped.
    const forwardedComments = calls.filter(
      (c) => c.query.includes("commentCreate") && String(c.variables.body ?? "").includes("appendix with repro steps"),
    );
    expect(forwardedComments.length).toBeGreaterThan(0);
  });

  it("AC6: ac-fail never exits with a blocked follow-up while its transition already applied", async () => {
    const { res2 } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "ac-fail",
      target: "igor",
      srcState: "ac-validate",
      srcDelegate: "u-astrid",
      dstState: "implementation",
      dstDelegate: "u-igor",
      first: commentCreateBody("chunk 1"),
      second: commentCreateBody("chunk 2"),
    });
    // Partial-apply (transition applied) + blocked comment is not a valid terminal state.
    const partiallyBlocked = res2.status === 200 && res2.body.errors !== undefined;
    expect(partiallyBlocked).toBe(false);
  });

  // ── AC3 — generic continue path (continue-workflow / validated) ──────────────

  it("AC3 continue-path: validated (continue-workflow) → done, second mutation not failed by post-mutation legality re-check", async () => {
    // AI-1872 repro: the `continue-workflow` meta-intent at ac-validate resolves
    // to `validated`, transitions to done + clears delegate, then the same
    // invocation's second mutation re-runs resolveMetaIntent against 'done' →
    // "'continue-workflow' has no continue transition in state 'done'". Driving
    // the raw `validated` intent would exercise checkWorkflowRules, not the
    // meta-intent re-resolution path that AI-1872 actually hit — so this test
    // sends `continue-workflow` to cover the reported code path. FIX: pass.
    const { res1, res2 } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "continue-workflow",
      srcState: "ac-validate",
      srcDelegate: "u-astrid",
      dstState: "done",
      dstDelegate: null,
      first: issueUpdateTriggerBody(),
      second: commentCreateBody("validation notes attached after the transition."),
    });

    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    expect(res2.status).toBe(200);
    expect(errText(res2)).not.toMatch(/no continue transition|not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();
  });

  // ── AC4 — audited verb set ───────────────────────────────────────────────────

  it("AC4/request-revision: second mutation not blocked after ac-validate → implementation (AI-1924)", async () => {
    const { res1, res2 } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "request-revision",
      target: "igor",
      srcState: "ac-validate",
      srcDelegate: "u-astrid",
      dstState: "implementation",
      dstDelegate: "u-igor",
      first: commentCreateBody("revision request — what needs changing."),
      second: commentCreateBody("revision request — specifics."),
    });
    expect(res1.body.errors).toBeUndefined();
    expect(errText(res2)).not.toMatch(/not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC4/refuse-work: second mutation not blocked after implementation → intake", async () => {
    // igor is delegate at implementation; refuse-work returns the ticket to
    // intake (delegate → astrid). Second comment must not re-gate on 'intake'.
    const { res1, res2 } = await runTwoStepCommand({
      agent: "igor",
      token: "tok-igor",
      intent: "refuse-work",
      srcState: "implementation",
      srcDelegate: "u-igor",
      dstState: "intake",
      dstDelegate: "u-astrid",
      first: commentCreateBody("refusing — out of scope, reason attached."),
      second: commentCreateBody("refusing — supporting detail."),
    });
    expect(res1.body.errors).toBeUndefined();
    expect(errText(res2)).not.toMatch(/not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC4/needs-human: second mutation not blocked after ac-validate → intake", async () => {
    const { res1, res2 } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "needs-human",
      srcState: "ac-validate",
      srcDelegate: "u-astrid",
      dstState: "intake",
      dstDelegate: null,
      first: commentCreateBody("needs a human — blocker described."),
      second: commentCreateBody("needs a human — additional context."),
    });
    expect(res1.body.errors).toBeUndefined();
    expect(errText(res2)).not.toMatch(/not a legal command|not the current delegate/i);
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC4/handoff-work: second mutation not blocked after delegate reassignment (self-loop, immune to legality but exercises the snapshot)", async () => {
    // handoff-work stays in 'implementation' (state unchanged) but reassigns the
    // delegate igor → charles. This is covered today by the AI-1857 delegate
    // snapshot; the test guards that the snapshot fix stays working.
    const { res1, res2 } = await runTwoStepCommand({
      agent: "igor",
      token: "tok-igor",
      intent: "handoff-work",
      target: "charles",
      srcState: "implementation",
      srcDelegate: "u-igor",
      dstState: "implementation",
      dstDelegate: "u-charles",
      first: commentCreateBody("handing off — context for charles."),
      second: commentCreateBody("handing off — extra notes."),
    });
    expect(res1.body.errors).toBeUndefined();
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC4/escape: break-glass follow-up not blocked (escape is always a legal move)", async () => {
    // escape is the break_glass command; astrid holds workflow:break-glass.
    // It is legal from any state, so it is structurally immune to the legality
    // re-check — but it belongs to the audited set, so it is exercised here.
    const { res1, res2 } = await runTwoStepCommand({
      agent: "astrid",
      token: "tok-astrid",
      intent: "escape",
      srcState: "implementation",
      srcDelegate: "u-astrid",
      dstState: "intake",
      dstDelegate: null,
      first: commentCreateBody("break-glass — recovering a stranded ticket."),
      second: commentCreateBody("break-glass — recovery detail."),
    });
    expect(res1.body.errors).toBeUndefined();
    expect(res2.body.errors).toBeUndefined();
  });

  // ── AC1 boundary — the fix must not over-open ────────────────────────────────

  it("AC1 boundary: an unrelated agent with no command snapshot is still blocked by the delegate check", async () => {
    // charles never authorized a command on this ticket. His mutation must still
    // be gated on the live delegate — the snapshot must be scoped to the agent
    // that opened the command, not a global bypass.
    const mf = makeMutableFetch({ state: "implementation", delegate: "u-igor" });
    globalThis.fetch = mf.fetch;
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send(commentCreateBody("charles trying to refuse igor's ticket"));
    expect(res.status).toBe(200);
    expect(errText(res)).toMatch(/not the current delegate/i);
  });

  // ── AC7 — audit attribution (AI-1909 forensics gap) ──────────────────────────

  it("AC7 audit-attribution: proxy governed-intent mutation_audit row records a real op_name and the invoking session identity", async () => {
    // AI-1909: the incident audit rows carried op_name "(unnamed)" and no
    // session identity, so "who ran this governed intent" was not a one-query
    // lookup. A governed-intent forward must record both.
    const mf = makeMutableFetch({ state: "ac-validate", delegate: "u-astrid" });
    globalThis.fetch = mf.fetch;
    mf.setWithIdsState("ac-validate");

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .set("X-Openclaw-Session-Key", "agent:astrid:linear-ai-1848")
      .send(commentCreateBody("AC failure — findings"));
    expect(res.status).toBe(200);

    // Proxy audit rows are keyed by `extractIssueIdentifier(body) ?? issueId`;
    // a commentCreate body carries no AI-#### identifier, so the row lands under
    // the issue UUID. Check both so the assertion targets the attribution gap,
    // not the ticket key.
    const rows = [
      ...(appState.mutationAuditStore.byTicket(ISSUE_UUID) as Array<Record<string, unknown>>),
      ...(appState.mutationAuditStore.byTicket(ISSUE_IDENTIFIER) as Array<Record<string, unknown>>),
    ];
    const govRow = rows.find((r) => r.source === "proxy" && r.intent === "ac-fail");
    expect(govRow).toBeDefined();

    // Real op_name (not the "(unnamed)" placeholder from the incident).
    expect(govRow!.opName).toBeTruthy();
    expect(govRow!.opName).not.toBe("(unnamed)");

    // Invoking session identity must be recorded so incidents are a one-query lookup.
    const sessionIdentity =
      (govRow!.sessionKey as string | undefined) ??
      (govRow!.session as string | undefined) ??
      (govRow!.invokerSession as string | undefined);
    expect(sessionIdentity).toBe("agent:astrid:linear-ai-1848");
  });
});
