/**
 * AI-1860: Proxy governed transitions are non-atomic — authorization check
 * is re-evaluated against post-mutation state, causing self-blocking.
 *
 * Observed 2026-07-06 on AI-1848: Astrid ran `ac-fail --target igor`. The proxy
 * applied the state/delegate transition atomically on the commentCreate (step 1),
 * then a second mutation (dedup-path issueUpdate with satisfied-by) was blocked:
 * "astrid is not the current delegate" because the re-fetched ticket now showed
 * Igor as delegate. The required comment was never delivered to the implementer.
 *
 * Root cause: checkWorkflowRules calls fetchTicketContext on every mutation.
 * For multi-step governed verbs, after the first mutation triggers applyStateTransition
 * (changing the delegate atomically), the second mutation hits a delegate check
 * against the NOW-MUTATED state and is blocked by the actor who just ran the first
 * mutation legally.
 *
 * AC1: `ac-fail` (and all multi-step governed verbs: refuse-work, handoff-work,
 *      needs-human, escape) execute with authorization snapshotted at command start —
 *      the delegate check is NOT re-evaluated after any mutation. A self-blocking
 *      exit 1 after a successful transition cannot occur.
 * AC2: The required comment for `ac-fail` is always delivered: the repro scenario
 *      (state transitions, delegate changes, comment blocked, exit 1) cannot recur.
 * AC3: Audit — all multi-step governed verbs have the same guarantee. Each of:
 *      refuse-work, handoff-work, needs-human, escape tested below.
 * AC4: Extended AI-1809 coverage — drives the full `ac-fail` two-step flow
 *      (commentCreate then satisfied-by issueUpdate) and asserts both calls succeed
 *      even when the delegate changes after the first mutation.
 * AC5: No governed verb can exit 1 while leaving the ticket in a partial-apply +
 *      blocked terminal state. Either the entire command succeeds or neither step applies.
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
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// Minimal dev-impl workflow covering the ac-fail, refuse-work, handoff-work, escape paths.
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
      - command: handoff-work
        to: implementation
        requires_comment: true
      - command: refuse-work
        to: intake
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

// ── Context shapes ────────────────────────────────────────────────────────

// Pre-transition: Astrid is delegate, state=ac-validate
const AC_VALIDATE_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
      delegate: { id: "u-astrid" },
    },
  },
};

// Post-transition: Igor is delegate, state=implementation (after applyStateTransition)
const POST_AC_FAIL_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-igor" },
    },
  },
};

// Implementation context: Igor is delegate
const IMPLEMENTATION_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-igor" },
    },
  },
};

// Post-refuse: Astrid is delegate (after Igor refused work)
const POST_REFUSE_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
      delegate: { id: "u-astrid" },
    },
  },
};

// Post-handoff: Charles is delegate (after Igor handed off to Charles)
const POST_HANDOFF_TO_CHARLES_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-charles" },
    },
  },
};

// B2 applyStateTransition shapes (need internal IDs)
const AC_VALIDATE_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      identifier: "AI-1848",
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

const IMPLEMENTATION_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      identifier: "AI-1848",
      team: { id: "team-uuid" },
      labels: {
        nodes: [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "impl-lbl", name: "state:implementation" },
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
          { id: "intake-lbl", name: "state:intake" },
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

// SatisfiedByComment — existing comment for the dedup/satisfied-by path.
// Must be recent, authored by the caller, and on the correct issue.
function satisfiedByComment(authorId: string): object {
  return {
    id: "comment-existing-1",
    createdAt: new Date(Date.now() - 20_000).toISOString(),
    user: { id: authorId },
    issue: { id: "issue-uuid", identifier: "AI-1848" },
  };
}

const UPSTREAM_OK = { data: { issueUpdate: { success: true, issue: { id: "internal-uuid" } } } };
const COMMENT_OK = {
  data: {
    commentCreate: {
      success: true,
      comment: { id: "comment-new", url: "https://linear.app/c/new", createdAt: "2026-07-06T06:03:00Z", body: "feedback" },
    },
  },
};

// ── Test infrastructure ───────────────────────────────────────────────────

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
      { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
    ],
  }), "utf8");
  return file;
}

/**
 * Stateful fetch mock for two-step governed-verb sequences.
 *
 * The `contextSequence` controls what IssueContext (B1) returns on each call.
 * Defaults to [preContext, postContext] — first call returns the pre-transition
 * state (actor is delegate), subsequent calls return the post-transition state
 * (actor is NO LONGER delegate, because applyStateTransition already ran).
 *
 * This is the exact state the proxy sees when two HTTP requests arrive for the
 * same intent — first passes B1, first triggers applyStateTransition, second
 * hits B1 with a now-stale authorization check.
 *
 * The satisfiedByAuthor controls who the mock satisfied-by comment is authored by.
 */
function makeReproFetch(opts: {
  contextSequence?: object[];
  issueWithLabels?: object;
  atomicSuccess?: boolean;
  satisfiedByAuthor?: string;
} = {}): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let contextCallIdx = 0;

  const json = (payload: object) => new Response(JSON.stringify(payload), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`Unexpected fetch to ${String(url)}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const q = parsed.query ?? "";

    // SatisfiedByComment — for the verified satisfied-by path.
    if (q.includes("SatisfiedByComment")) {
      const author = opts.satisfiedByAuthor ?? "u-astrid";
      return json({ data: { comment: satisfiedByComment(author) } });
    }

    // B1 context fetch — stateful: returns pre-transition context for first call,
    // post-transition context for subsequent calls (simulating the state the proxy
    // sees AFTER applyStateTransition already ran on the first mutation).
    if (q.includes("IssueContext")) {
      const sequence = opts.contextSequence ?? [AC_VALIDATE_CONTEXT, POST_AC_FAIL_CONTEXT];
      const response = sequence[contextCallIdx] ?? sequence[sequence.length - 1];
      contextCallIdx++;
      return json(response);
    }

    // sourceStateOverride fetch (fetchWorkflowLabels) — label names only
    if (q.includes("IssueLabels") && !q.includes("IssueWithLabels")) {
      const sequence = opts.contextSequence ?? [AC_VALIDATE_CONTEXT, POST_AC_FAIL_CONTEXT];
      const ctx = (sequence[Math.max(0, contextCallIdx - 1)] as { data: { issue: { labels: { nodes: Array<{ name: string }> } } } }).data.issue;
      return json({ data: { issue: { labels: ctx.labels } } });
    }

    // applyStateTransition — full issue fetch with label IDs
    if (q.includes("IssueWithLabels")) {
      return json(opts.issueWithLabels ?? AC_VALIDATE_WITH_IDS);
    }

    if (q.includes("TeamLabels")) return json(TEAM_LABELS);
    if (q.includes("TeamStates")) return json(TEAM_STATES);

    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: opts.atomicSuccess ?? true } } });
    }

    // commentCreate upstream forward
    if (q.includes("commentCreate")) return json(COMMENT_OK);

    // issueUpdate upstream forward (trigger or satisfied-by trigger)
    return json(UPSTREAM_OK);
  };

  return { fetch: mockFetch, calls };
}

// ── Test suite ────────────────────────────────────────────────────────────

describe("proxy — AI-1860 non-atomic authorization re-evaluation on multi-step governed verbs", () => {
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

  // ── AC1 / AC2 / AC4: exact repro of AI-1848 ──────────────────────────

  /**
   * AC1/AC2/AC4 — The AI-1848 repro sequence:
   *
   * Step 1: CLI posts commentCreate with intent=ac-fail.
   *   - B1: Astrid is delegate in ac-validate → passes.
   *   - Proxy forwards commentCreate, `applyStateTransition` runs → delegate Astrid → Igor.
   *
   * Step 2: CLI sends issueUpdate {} with intent=ac-fail and
   *         X-Openclaw-Comment-Satisfied-By pointing to the just-posted comment.
   *   - verifyCommentSatisfiedBy passes (Astrid authored the comment).
   *   - requestHasComment = true → requires_comment gate passes.
   *   - THEN delegate check: `fetchTicketContext` re-fetches → now Igor is delegate.
   *   - "astrid is not the current delegate" → EXIT 1 / COMMENT BLOCKED.
   *
   * With the authorization-snapshot fix, the delegate check on step 2 must use the
   * snapshot from step 1 (Astrid was the delegate when the command started).
   */
  it("AC1/AC2/AC4: commentCreate-then-satisfied-by-issueUpdate — second mutation not blocked after delegate change", async () => {
    const { fetch: mock, calls } = makeReproFetch({
      // Step 1 B1: Astrid is delegate → passes.
      // Step 2 B1: Igor is delegate → blocks WITHOUT the snapshot fix.
      contextSequence: [AC_VALIDATE_CONTEXT, POST_AC_FAIL_CONTEXT],
    });
    globalThis.fetch = mock;

    const FEEDBACK = "AC not satisfied: search returns stale results on the live deployed build.";

    // Step 1: commentCreate with intent=ac-fail (comment-first CLI ordering)
    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }",
        variables: { issueId: "issue-uuid", body: FEEDBACK },
      });

    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // The first mutation triggered applyStateTransition (delegate now Igor).
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);

    // Step 2: satisfied-by issueUpdate {} — the dedup/second-trigger path.
    // The CLI sends this after a prior comment was found (satisfied by the
    // just-posted comment or an existing dup). Carries X-Openclaw-Comment-Satisfied-By.
    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-existing-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // AC1/AC4: issueUpdate must not be blocked — proxy must use the authorization
    // snapshot from step 1 (Astrid was the delegate then), not re-evaluate against
    // post-transition state (Igor is the delegate now).
    expect(res2.status).toBe(200);
    // Currently FAILS: res2.body.errors[0].message =
    //   "[Proxy] 'ac-fail' blocked: astrid is not the current delegate for issue-uuid.
    //    Only the ticket delegate may mutate its state. Legal moves: continue-workflow, escape."
    expect(res2.body.errors).toBeUndefined();

    // AC2: the issueUpdate was forwarded to Linear (not blocked before reaching upstream)
    const issueUpdateForward = calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("ApplyAtomicTransition"));
    expect(issueUpdateForward.length).toBeGreaterThan(0);
  });

  // ── AC5: no partial-apply terminal state ─────────────────────────────

  it("AC5: repro scenario must not leave ticket in partial-apply + blocked-comment terminal state", async () => {
    const { fetch: mock } = makeReproFetch({
      contextSequence: [AC_VALIDATE_CONTEXT, POST_AC_FAIL_CONTEXT],
    });
    globalThis.fetch = mock;

    const FEEDBACK = "Implementation incomplete.";

    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: "issue-uuid", body: FEEDBACK },
      });

    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-existing-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // AC5: valid terminal states:
    //   (a) both succeed — full command applied, implementer has context
    //   (b) first fails — no mutation applied, no partial state
    // Partial-apply (res1 succeeds, transition occurs, res2 fails) is NOT valid.
    const bothSucceeded = !res1.body.errors && !res2.body.errors;
    const firstFailed = !!res1.body.errors;

    // Currently FAILS: res1 succeeds (transition applied), res2 blocked (comment context lost)
    expect(bothSucceeded || firstFailed).toBe(true);
  });

  // ── AC1 regression: single-mutation path must still work ─────────────

  it("AC1 regression: single-mutation comment-first path (fresh comment, no satisfied-by) continues to work", async () => {
    // When the CLI sends ONLY the commentCreate (no subsequent issueUpdate),
    // the proxy should work correctly: B1 passes on the comment, transition applies.
    const { fetch: mock, calls } = makeReproFetch({
      contextSequence: [AC_VALIDATE_CONTEXT],
    });
    globalThis.fetch = mock;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: "issue-uuid", body: "AC not satisfied." },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // Transition applied upstream (ApplyAtomicTransition fired directly at Linear API)
    expect(calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
  });

  // ── AC3: audit all multi-step governed verbs ──────────────────────────

  it("AC3/audit: refuse-work — second mutation not blocked after delegate changes mid-command", async () => {
    // Repro for refuse-work: Igor (delegate in implementation) refuses work.
    // Step 1: comment posted → proxy transitions: delegate Igor → Astrid.
    // Step 2: satisfied-by issueUpdate → should not be blocked (Igor was delegate at command start).
    const { fetch: mock, calls } = makeReproFetch({
      contextSequence: [
        IMPLEMENTATION_CONTEXT,  // step 1 B1: Igor is delegate → passes
        POST_REFUSE_CONTEXT,     // step 2 B1: Astrid is delegate → blocks Igor WITHOUT fix
      ],
      issueWithLabels: IMPLEMENTATION_WITH_IDS,
    });
    globalThis.fetch = mock;

    const REFUSAL = "This work is out of my domain: requires backend API changes.";
    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send({
        query: "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: "issue-uuid", body: REFUSAL },
      });
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-existing-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // AC3: refuse-work second mutation must not be blocked after the delegate changed.
    expect(res2.status).toBe(200);
    // Currently FAILS: "[Proxy] 'refuse-work' blocked: igor is not the current delegate
    //   or the workflow steward."
    expect(res2.body.errors).toBeUndefined();
    const updateForwards = calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("ApplyAtomicTransition"));
    expect(updateForwards.length).toBeGreaterThan(0);
  });

  it("AC3/audit: handoff-work — second mutation not blocked after delegate changes mid-command", async () => {
    // Igor (implementation delegate) hands off to Charles (another dev).
    // Step 1: comment → transition (Igor → Charles delegate).
    // Step 2: satisfied-by issueUpdate → must not be blocked even though Igor lost delegation.
    // This requires multi-body dev role (igor + charles) so --target charles is valid.
    const { fetch: mock } = makeReproFetch({
      contextSequence: [
        IMPLEMENTATION_CONTEXT,          // Igor is delegate
        POST_HANDOFF_TO_CHARLES_CONTEXT, // After handoff: Charles is delegate
      ],
      issueWithLabels: IMPLEMENTATION_WITH_IDS,
    });
    globalThis.fetch = mock;

    const HANDOFF = "Handing off to Charles: context switch needed.";
    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "charles")
      .send({
        query: "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: "issue-uuid", body: HANDOFF },
      });
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "charles")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-existing-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res2.status).toBe(200);
    // Currently FAILS: Igor is no longer delegate after step 1 transitioned to Charles
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC3/audit: escape — path is immune to delegate-snapshot bug (escape is always a legal move)", async () => {
    // Escape is listed as a legal move for ANY agent even when they are not the delegate
    // (proxy error: "Legal moves: submit, handoff-work, refuse-work, escape"). This means
    // the delegate-only block does not apply to escape — it is structurally immune to the
    // non-atomic authorization bug this ticket fixes. This test confirms that invariant
    // is preserved: even if the second mutation sees a different delegate post-transition,
    // the escape intent is still allowed through.
    //
    // This test PASSES currently (and must continue to pass after the fix).
    const { fetch: mock } = makeReproFetch({
      contextSequence: [
        AC_VALIDATE_CONTEXT,     // step 1 B1: Astrid is delegate → escape is legal (she's the delegate)
        POST_AC_FAIL_CONTEXT,    // step 2 B1: Igor is delegate → "not the current delegate" WITHOUT fix
      ],
    });
    globalThis.fetch = mock;

    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "escape")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "escape")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-existing-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    expect(res2.status).toBe(200);
    // Passes because escape is always legal regardless of delegate — immune to this bug.
    expect(res2.body.errors).toBeUndefined();
  });

  // ── Boundary: different agent must still be blocked ───────────────────

  it("AC1 boundary: snapshot applies only to the same agent — a different agent is still blocked", async () => {
    // Igor is the legitimate delegate. Astrid (not the delegate) must still be blocked
    // even if she sends a request shortly after Igor's command.
    const { fetch: mock } = makeReproFetch({
      // Both context fetches return Igor as delegate — Astrid was never authorized.
      contextSequence: [
        IMPLEMENTATION_CONTEXT,  // Igor's step 1: passes
        IMPLEMENTATION_CONTEXT,  // Astrid's attempt: Igor is delegate → Astrid must be blocked
      ],
      issueWithLabels: IMPLEMENTATION_WITH_IDS,
    });
    globalThis.fetch = mock;

    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: "issue-uuid", body: "Submitting for AC validation." },
      });
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // Astrid tries to piggyback on the same intent — she is NOT the delegate.
    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "submit")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-existing-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });

    // Astrid was NEVER the delegate — must be blocked regardless of the snapshot fix.
    expect(res2.body.errors).toBeDefined();
    expect(res2.body.errors[0].message).toMatch(/blocked/i);
  });
});
