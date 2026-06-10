/**
 * AI-1498 acceptance gate: conformance walk.
 *
 * Drives a synthetic dev-impl ticket through EVERY governed transition and
 * asserts that, after each step, the proxy emitted exactly ONE issueUpdate
 * mutation (ApplyAtomicTransition) carrying all three facets together:
 *   { labelIds: state:<dest>, delegateId: <dest owner | null>, stateId: <dest native UUID> }
 *
 * Also covers the adversarial direct-write blocks: raw stateId / assigneeId /
 * labelIds mutations with no intent header must each be refused end-to-end.
 *
 * Written in jest style (the project's runner) against the real proxy via
 * supertest, with a stateful fetch mock standing in for the Linear API. This
 * is an end-to-end proof at the proxy boundary, not a unit test of the gate.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, resetTeamStatesCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { recordImplementer, clearImplementerStore } from "./implementer-store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

// Canonical-shaped dev-impl with native_state on every state (AI-1498 item 3:
// non-terminal states MUST carry native_state or the def fails closed at load).
const CONFORMANCE_WORKFLOW_YAML = `
id: dev-impl
version: 6
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: escape
  owner_role: steward

stakes:
  threshold: 2
  levels:
    "stakes:low": 0
    "stakes:medium": 1
    "stakes:high": 2

states:
  - id: intake
    owner_role: steward
    native_state: todo
    kind: normal
    transitions:
      - command: accept
        to: implementation
        capture_ac: true
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    native_state: doing
    kind: normal
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    native_state: thinking
    kind: normal
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation

  - id: deployment
    owner_role: deployment
    native_state: doing
    kind: normal
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
        requires_human_signoff_above_stakes: true
      - command: reject
        to: implementation

  - id: done
    native_state: done
    kind: terminal
    transitions: []

  - id: escape
    native_state: invalid
    kind: terminal
    transitions: []
`;

const CONFORMANCE_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

// Agent → Linear user ID. The proxy resolves the caller's linearUserId from
// here for the delegate-only check, and the mock sets the ticket delegate to
// the owner of the current state so the legal caller always matches.
const AGENTS = {
  agents: [
    { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "t", host: "local" },
    { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "t", host: "local" },
    { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "t", host: "local" },
    { name: "hanzo", linearUserId: "u-hanzo", openclawAgent: "hanzo", accessToken: "t", host: "local" },
  ],
};

// State id → owner agent + that owner's Linear user ID (the ticket delegate
// while the ticket sits in that state).
const STATE_OWNER: Record<string, { agent: string; userId: string }> = {
  intake: { agent: "astrid", userId: "u-astrid" },
  implementation: { agent: "igor", userId: "u-igor" },
  "code-review": { agent: "charles", userId: "u-charles" },
  deployment: { agent: "hanzo", userId: "u-hanzo" },
};

// native_state semantic → the team's resolved Linear workflow-state UUID.
const NATIVE_UUID: Record<string, string> = {
  todo: "ls-todo",
  doing: "ls-doing",
  thinking: "ls-thinking",
  done: "ls-done",
  invalid: "ls-invalid",
  backlog: "ls-backlog",
};

const TEAM_STATES = [
  { id: "ls-backlog", name: "Backlog", type: "backlog" },
  { id: "ls-todo", name: "Todo", type: "unstarted" },
  { id: "ls-doing", name: "Doing", type: "started" },
  { id: "ls-thinking", name: "Thinking", type: "started" },
  { id: "ls-done", name: "Done", type: "completed" },
  { id: "ls-invalid", name: "Invalid", type: "canceled" },
];

const ALL_STATE_IDS = ["intake", "implementation", "code-review", "deployment", "done", "escape"];

function labelId(name: string): string {
  return `lbl:${name}`;
}

// Team label catalogue (findOrCreateLabel lookup): every state:* label plus the
// workflow + stakes labels, each with a deterministic id.
const TEAM_LABELS_NODES = [
  ...ALL_STATE_IDS.map((s) => ({ id: labelId(`state:${s}`), name: `state:${s}` })),
  { id: labelId("wf:dev-impl"), name: "wf:dev-impl" },
  { id: labelId("stakes:low"), name: "stakes:low" },
];

const ISSUE_ID = "AI-9999";
const INTERNAL_ID = "internal-uuid";
const TEAM_ID = "team-uuid";

// ── Harness ─────────────────────────────────────────────────────────────

describe("conformance walk — proxy is sole atomic writer of all facets (AI-1498 AC#1)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-test-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify(AGENTS), "utf8");
    process.env.AGENTS_FILE = agentsFile;

    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CONFORMANCE_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, CONFORMANCE_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    process.env.IMPLEMENTER_STORE_PATH = path.join(dir, "implementer-store.json");

    resetPolicyCache();
    resetWorkflowCache();
    resetTeamStatesCache();
    resetConfigHealth();
    clearImplementerStore();
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

  interface AtomicCall {
    issueId: string;
    labelIds: string[];
    delegateId?: string | null;
    stateId?: string | null;
    hasDelegateKey: boolean;
    hasStateKey: boolean;
  }

  /**
   * Build a stateful fetch mock for a ticket currently in `fromState`.
   * Returns the mock plus a `calls` array capturing every ApplyAtomicTransition
   * mutation seen, decoded into its facet variables.
   */
  function makeWalkFetch(fromState: string): {
    fetch: typeof globalThis.fetch;
    atomicCalls: AtomicCall[];
    forwarded: string[];
  } {
    const atomicCalls: AtomicCall[] = [];
    const forwarded: string[] = [];
    const owner = STATE_OWNER[fromState];
    const contextLabels = [`wf:dev-impl`, `state:${fromState}`, "stakes:low"];

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      const q = parsed.query ?? "";
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });

      // The single atomic transition mutation — capture all facets.
      if (q.includes("ApplyAtomicTransition")) {
        const v = (parsed.variables ?? {}) as Record<string, unknown>;
        atomicCalls.push({
          issueId: v.issueId as string,
          labelIds: (v.labelIds as string[]) ?? [],
          delegateId: v.delegateId as string | null | undefined,
          stateId: v.stateId as string | null | undefined,
          hasDelegateKey: "delegateId" in v,
          hasStateKey: "stateId" in v,
        });
        return json({ data: { issueUpdate: { success: true } } });
      }
      // B2 issue+label fetch (label IDs + team).
      if (q.includes("IssueWithLabels")) {
        return json({
          data: {
            issue: {
              id: INTERNAL_ID,
              team: { id: TEAM_ID },
              labels: { nodes: contextLabels.map((n) => ({ id: labelId(n), name: n })) },
            },
          },
        });
      }
      // Done gate (deploy → done).
      if (q.includes("IssueBranchAndPR")) {
        return json({
          data: { issue: { branch: { id: "b1", name: "feat", updatedAt: "2026-01-01" }, pullRequests: { nodes: [{ id: "pr1", state: "merged" }] } } },
        });
      }
      // Verbatim AC capture (accept).
      if (q.includes("IssueDescription")) {
        return json({ data: { issue: { description: "### Acceptance Criteria\n- The thing works." } } });
      }
      // Team label catalogue (findOrCreateLabel lookup).
      if (q.includes("TeamLabels")) {
        return json({ data: { team: { labels: { nodes: TEAM_LABELS_NODES } } } });
      }
      // Team Linear states (native_state resolution).
      if (q.includes("TeamStates")) {
        return json({ data: { team: { workflow: { states: TEAM_STATES } } } });
      }
      // B1 context fetch (labels + delegate). Delegate = owner of current state.
      if (q.includes("IssueContext") || q.includes("IssueLabels")) {
        return json({
          data: { issue: { labels: { nodes: contextLabels.map((n) => ({ name: n })) }, delegate: owner ? { id: owner.userId } : null } },
        });
      }
      // Anything else would be a forwarded CLI mutation — record it (should not
      // happen for governed transitions under sole-writer).
      forwarded.push(q);
      return json({ data: {} });
    };

    return { fetch: mockFetch, atomicCalls, forwarded };
  }

  async function fire(fromState: string, intent: string, agent: string) {
    const { fetch: mock, atomicCalls, forwarded } = makeWalkFetch(fromState);
    globalThis.fetch = mock;
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", agent)
      .set("X-Openclaw-Linear-Intent", intent)
      .send({ query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }", variables: { id: ISSUE_ID } });
    return { res, atomicCalls, forwarded };
  }

  // Every governed forward edge of dev-impl, with the destination facets the
  // single atomic mutation must carry.
  const EDGES: Array<{
    name: string;
    from: string;
    intent: string;
    agent: string;
    destLabel: string;
    delegate: string | null;
    native: string;
    seedImplementer?: string;
  }> = [
    { name: "accept: intake → implementation", from: "intake", intent: "accept", agent: "astrid", destLabel: "state:implementation", delegate: "u-igor", native: "ls-doing" },
    { name: "submit: implementation → code-review", from: "implementation", intent: "submit", agent: "igor", destLabel: "state:code-review", delegate: "u-charles", native: "ls-thinking" },
    { name: "approve: code-review → deployment", from: "code-review", intent: "approve", agent: "charles", destLabel: "state:deployment", delegate: "u-hanzo", native: "ls-doing" },
    { name: "deploy: deployment → done (terminal)", from: "deployment", intent: "deploy", agent: "hanzo", destLabel: "state:done", delegate: null, native: "ls-done" },
    { name: "request-changes: code-review → implementation", from: "code-review", intent: "request-changes", agent: "charles", destLabel: "state:implementation", delegate: "u-igor", native: "ls-doing", seedImplementer: "igor" },
    { name: "reject: deployment → implementation", from: "deployment", intent: "reject", agent: "hanzo", destLabel: "state:implementation", delegate: "u-igor", native: "ls-doing", seedImplementer: "igor" },
    { name: "escape: implementation → escape (break-glass, terminal)", from: "implementation", intent: "escape", agent: "igor", destLabel: "state:escape", delegate: null, native: "ls-invalid" },
  ];

  it.each(EDGES)(
    "$name — one atomic mutation carries {label, delegate, native} of the destination",
    async (edge) => {
      if (edge.seedImplementer) {
        await recordImplementer(ISSUE_ID, edge.seedImplementer, "dev-impl");
      }

      const { res, atomicCalls, forwarded } = await fire(edge.from, edge.intent, edge.agent);

      // Transition succeeded (no workflow/proxy error).
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      // The proxy synthesizes the CLI's issueUpdate response from the internal id.
      expect(res.body.data.issueUpdate.success).toBe(true);
      expect(res.body.data.issueUpdate.issue.id).toBe(INTERNAL_ID);

      // AC#3: EXACTLY ONE atomic mutation per transition.
      expect(atomicCalls.length).toBe(1);
      const call = atomicCalls[0];
      expect(call.issueId).toBe(INTERNAL_ID);

      // Facet 1 — label: destination state label present, source removed.
      expect(call.labelIds).toContain(labelId(edge.destLabel));
      expect(call.labelIds).not.toContain(labelId(`state:${edge.from}`));

      // Facet 2 — delegate: destination owner, or cleared (null) on terminals.
      expect(call.hasDelegateKey).toBe(true);
      expect(call.delegateId ?? null).toBe(edge.delegate);

      // Facet 3 — native column: destination's native_state UUID.
      expect(call.hasStateKey).toBe(true);
      expect(call.stateId).toBe(edge.native);

      // Sole-writer: the CLI's own facet-writing mutation must NOT be forwarded.
      expect(forwarded.some((q) => q.includes("mutation M"))).toBe(false);
    },
  );

  it("demote: intake → __ad_hoc__ strips wf/state labels and resets native column to backlog", async () => {
    const { res, atomicCalls, forwarded } = await fire("intake", "demote", "astrid");

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.issueUpdate.success).toBe(true);

    expect(atomicCalls.length).toBe(1);
    const call = atomicCalls[0];
    // wf:* and state:* are removed; stakes (a non-governance label) is retained.
    expect(call.labelIds).not.toContain(labelId("wf:dev-impl"));
    expect(call.labelIds).not.toContain(labelId("state:intake"));
    expect(call.labelIds).toContain(labelId("stakes:low"));
    // Delegate cleared, native column parked at backlog so it leaves governance clean.
    expect(call.delegateId ?? null).toBeNull();
    expect(call.stateId).toBe(NATIVE_UUID.backlog);
    expect(forwarded.some((q) => q.includes("mutation M"))).toBe(false);
  });

  // ── Adversarial: direct facet writes must be blocked end-to-end ──────────

  /** Fire a raw issueUpdate with no intent header carrying the given input. */
  async function fireRaw(input: Record<string, unknown>) {
    const { fetch: mock } = makeWalkFetch("implementation");
    globalThis.fetch = mock;
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "igor")
      .send({
        query: "mutation M($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        variables: { id: ISSUE_ID, input },
      });
  }

  it("blocks a direct stateId write (no intent) on a workflow ticket", async () => {
    const res = await fireRaw({ stateId: "ls-done" });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("status");
    expect(res.body.errors[0].message).toContain("blocked on this workflow ticket");
  });

  it("blocks a direct assigneeId write (no intent) on a workflow ticket", async () => {
    const res = await fireRaw({ assigneeId: "u-igor" });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("assignee");
  });

  it("blocks a direct labelIds write (no intent) on a workflow ticket", async () => {
    const res = await fireRaw({ labelIds: [labelId("state:done")] });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("[Proxy]");
    expect(res.body.errors[0].message).toContain("labels");
  });
});
