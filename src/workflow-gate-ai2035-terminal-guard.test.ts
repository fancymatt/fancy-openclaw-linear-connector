/**
 * AI-2035: Done→Doing bounce 3s after reviewer close re-triggers dispatch.
 *
 * A reviewer's semantic command emits >1 mutation under one sticky intent
 * header. Write 1 legitimately transitions the ticket to a terminal state
 * (`done`) and calls `recordAppliedState(id, "done")`. Write 2 (the trailing
 * same-turn mutation, ~3s later) re-enters `applyStateTransition`. Because
 * `applyStateTransition` derives its source from lag-prone live reads
 * (`sourceStateOverride ?? actualStateName`) — both still returning the
 * pre-Done state inside Linear's read-after-write window — and NEVER consults
 * the authoritative `getAppliedState(id)` that write 1 just populated, it
 * matches a forward edge off the stale pre-Done state and overwrites Done.
 *
 * ── AC of record (captured at intake by astrid, 2026-07-10) ──────────────────
 *   AC2 (guard A) — terminal re-entry guard in `applyStateTransition`: resolve
 *        source as `getAppliedState(id) ?? sourceStateOverride ?? actualStateName`,
 *        and return a loud `terminal-reentry-guard` block instead of writing when
 *        that state is terminal (and intent ≠ break-glass).
 *   AC3 — "Plus a direct `applyStateTransition` unit test for the new guard"
 *        (per astrid's write-tests note: "including the break-glass exemption path").
 *
 * These tests exercise `applyStateTransition` directly. They are RED against the
 * current code: with the applied-state store recording `done`, the current
 * source resolution ignores it, matches the pre-Done `validated` edge, and
 * issues an `ApplyAtomicTransition` (status "applied"). After guard A they must
 * return status "blocked" / code "terminal-reentry-guard" with no atomic write.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { reloadAgents } from "./agents.js";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { recordAppliedState, _resetAppliedStateStore } from "./store/applied-state-store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// dev-impl-shaped workflow whose ac-validate → validated edge lands on a
// TERMINAL `done`. This is the exact edge the trailing mutation matches off the
// stale pre-Done source.
const TEST_WORKFLOW_YAML = `
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
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const IDENTIFIER = "AI-2035";

interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

/**
 * Transition-phase fetch mock (mirrors makeTransitionFetch from
 * ai-1813-escape-no-state-label.test.ts). `issueLabels` is the LIVE read the
 * proxy uses for `sourceStateOverride`/`actualStateName` — in the lag window it
 * still reflects the pre-Done state. Fully mocks the atomic-write path so the
 * CURRENT (buggy) code runs to a clean "applied" outcome and the assertion —
 * not an unexpected-query throw — is what fails.
 */
function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamLabels: Array<{ id: string; name: string }>;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });
    const query = parsed.query ?? "";
    const json = (payload: object) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: "internal-uuid",
            identifier: IDENTIFIER,
            team: { id: "team-uuid" },
            labels: { nodes: opts.issueLabels },
          },
        },
      });
    }
    if (query.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: { nodes: opts.teamLabels } } } } });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: opts.teamLabels } } } });
    }
    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-doing-uuid", name: "Doing", type: "started" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("issueLabelCreate")) {
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      // Unreadable read-back → issueUpdateAtomicVerified accepts the write as
      // unverified (fail-open, AI-1762). Keeps the mock destination-agnostic so
      // legit forward writes land "applied" without the mock tracking labels.
      return json({ data: { issue: null } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("UpdateDelegate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };
  return { fetch: mockFetch, calls };
}

const atomicCalls = (calls: FetchCall[]) =>
  calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));

// ── Suite ────────────────────────────────────────────────────────────────────

describe("AI-2035: applyStateTransition terminal re-entry guard (AC2 guard A / AC3 unit)", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2035-guard-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    // AI-2359: agents.json must include astrid with linearUserId so singleton
    // delegate resolution for steward role does not fail-closed.
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The trailing mutation: write 1 already recorded the authoritative
  // destination `done`; the live read still lags at ac-validate.
  const LAG_LABELS = [
    { id: "wf-lbl", name: "wf:dev-impl" },
    { id: "ac-validate-lbl", name: "state:ac-validate" },
  ];
  const TEAM_LABELS = [
    { id: "done-lbl", name: "state:done" },
    { id: "intake-lbl", name: "state:intake" },
    { id: "implementation-lbl", name: "state:implementation" },
    { id: "ac-validate-lbl", name: "state:ac-validate" },
  ];

  it("AC3-unit: blocks the trailing 'validated' re-entry when getAppliedState records a terminal 'done' (lag: live read still ac-validate)", async () => {
    // Simulate write 1 having recorded the authoritative terminal destination.
    recordAppliedState(IDENTIFIER, "done");

    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: LAG_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    // sourceStateOverride is the proxy's lag-prone live capture (pre-Done).
    const result = await applyStateTransition("validated", IDENTIFIER, "Bearer tok", {
      sourceStateOverride: "ac-validate",
    });

    // Guard A must resolve source from getAppliedState (= "done", terminal) and
    // refuse to write, loudly. CURRENT code ignores it → matches validated→done
    // → status "applied".
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("terminal-reentry-guard");
  });

  it("AC3-unit: the guarded trailing re-entry issues NO ApplyAtomicTransition off the terminal state", async () => {
    recordAppliedState(IDENTIFIER, "done");
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: LAG_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    await applyStateTransition("validated", IDENTIFIER, "Bearer tok", { sourceStateOverride: "ac-validate" });

    // No native write may leave `done`. CURRENT code issues exactly one here.
    expect(atomicCalls(calls).length).toBe(0);
  });

  it("AC2 break-glass exemption: escape is NOT blocked by the guard even when the recorded state is terminal", async () => {
    // Boundary (non-regression): break-glass is the recovery path and must remain
    // legal from a terminal state. The guard exempts intent === break_glass.command.
    // Passes both before and after the fix — proves the guard does not over-block.
    recordAppliedState(IDENTIFIER, "done");
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: LAG_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    const result = await applyStateTransition("escape", IDENTIFIER, "Bearer tok", { sourceStateOverride: "ac-validate" });

    expect(result.status).toBe("applied");
    expect(result.to).toBe("intake");
    expect(atomicCalls(calls).length).toBeGreaterThan(0);
  });

  it("AC2 non-regression: a genuine forward transition from a non-terminal recorded state still applies", async () => {
    // Boundary: when the recorded state is NOT terminal, the guard must be inert
    // and the normal forward write proceeds. Passes both before and after the fix.
    recordAppliedState(IDENTIFIER, "ac-validate"); // non-terminal recorded state
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: LAG_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    const result = await applyStateTransition("validated", IDENTIFIER, "Bearer tok", { sourceStateOverride: "ac-validate" });

    expect(result.status).toBe("applied");
    expect(result.to).toBe("done");
    expect(atomicCalls(calls).length).toBe(1);
  });
});
