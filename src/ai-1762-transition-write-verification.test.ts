/**
 * AI-1762: Governed transition writes are verified read-after-write and
 * internally retried (bounded) before the proxy reports success.
 *
 * Live incident (AI-1759, 2026-07-04 ~05:52Z): the ac-fail revision transition
 * applied the state-label change but the delegate write did not persist —
 * Linear returned HTTP 200 / success:true and silently dropped the app-user
 * delegateId. The ticket landed in state:implementation with a stale delegate
 * until a human-in-the-loop noticed and manually retried.
 *
 * AC mapping (AI-1762 deliverables):
 *   AC1: transition execution verifies each written facet (state label,
 *        delegate, native state) read-after-write against Linear and
 *        internally retries failed writes (bounded) before returning success.
 *   AC2: a transition that cannot fully apply after retries returns an
 *        explicit error to the caller AND appends a transition-write-failed
 *        operational event + alert-bus warning — never a silent partial apply.
 *   AC3 (regression): a delegate write that silently fails to persist while
 *        the label write lands is detected and retried.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache, _setTransitionWritePolicyForTests } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

// ── Fixtures (same incident shape as ai-1809) ─────────────────────────────

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

const AC_VALIDATE_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
      delegate: { id: "u-astrid" },
    },
  },
};

const AC_VALIDATE_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      identifier: "AI-1759",
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

const EXISTING_FEEDBACK_COMMENT = {
  id: "comment-dup-1",
  createdAt: new Date(Date.now() - 20_000).toISOString(),
  user: { id: "u-astrid" },
  issue: { id: "issue-uuid", identifier: "AI-1759" },
};

const UPSTREAM_OK = { data: { issueUpdate: { success: true, issue: { id: "issue-uuid" } } } };

/** Post-transition facets when everything persisted (ac-fail → implementation, delegate igor). */
const PERSISTED_VERIFY = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-igor" },
      state: { id: "s-doing" },
    },
  },
};

/** The AI-1759 silent partial apply: label + native landed, delegate dropped. */
const DELEGATE_DROPPED_VERIFY = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: null,
      state: { id: "s-doing" },
    },
  },
};

// ── Test infrastructure ────────────────────────────────────────────────────

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

describe("proxy — AI-1762 transition write verification + bounded retry", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let alertStore: AlertStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai1762-test-"));
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
    _setTransitionWritePolicyForTests({ retryDelayMs: 0 });
    _resetAlertBusForTests();
    alertStore = new AlertStore(":memory:");
    initAlertBus({ store: alertStore, pushEnabled: false });
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTransitionWritePolicyForTests();
    _resetAlertBusForTests();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  /**
   * Fetch mock for the full ac-fail path with scriptable per-call outcomes:
   *   atomicResults — success flag per ApplyAtomicTransition call (last repeats)
   *   verifyResults — VerifyTransitionWrite payload per call (last repeats)
   */
  function makeVerifyingFetch(opts: {
    atomicResults?: boolean[];
    verifyResults?: object[];
  } = {}): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: Record<string, unknown> }> } {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    let atomicIdx = 0;
    let verifyIdx = 0;
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
        return json({ data: { comment: EXISTING_FEEDBACK_COMMENT } });
      }
      if (q.includes("VerifyTransitionWrite")) {
        const results = opts.verifyResults ?? [PERSISTED_VERIFY];
        const payload = results[Math.min(verifyIdx, results.length - 1)];
        verifyIdx++;
        return json(payload);
      }
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
        return json(AC_VALIDATE_CONTEXT);
      }
      if (q.includes("IssueWithLabels")) {
        return json(AC_VALIDATE_WITH_IDS);
      }
      if (q.includes("TeamLabels")) {
        return json(TEAM_LABELS);
      }
      if (q.includes("TeamStates")) {
        return json(TEAM_STATES);
      }
      if (q.includes("ApplyAtomicTransition")) {
        const results = opts.atomicResults ?? [true];
        const success = results[Math.min(atomicIdx, results.length - 1)];
        atomicIdx++;
        return json({ data: { issueUpdate: { success } } });
      }
      return json(UPSTREAM_OK);
    };

    return { fetch: mockFetch, calls };
  }

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

  const atomicCalls = (calls: Array<{ query: string }>) =>
    calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
  const verifyCalls = (calls: Array<{ query: string }>) =>
    calls.filter((c) => c.query.includes("VerifyTransitionWrite"));

  // ── AC1: read-after-write verification on the happy path ────────────────

  it("AC1: a fully-persisted write verifies read-after-write and applies on the first attempt", async () => {
    const { fetch: mock, calls } = makeVerifyingFetch();
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(atomicCalls(calls).length).toBe(1);
    expect(verifyCalls(calls).length).toBe(1);
    // Verification reads back the just-written issue, not agent-supplied state.
    expect(verifyCalls(calls)[0]).toBeDefined();
  });

  // ── AC3 regression: the AI-1759 silent delegate drop, recovered by retry ─

  it("AC3: a delegate write that silently fails to persist is detected and retried until it lands", async () => {
    const { fetch: mock, calls } = makeVerifyingFetch({
      // Mutation reports success every time (that's the bug: HTTP 200, facet dropped)…
      atomicResults: [true],
      // …but the first read-back shows the delegate missing; the retry persists.
      verifyResults: [DELEGATE_DROPPED_VERIFY, PERSISTED_VERIFY],
    });
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition.status).toBe("applied");
    expect(res.body._workflowTransition.to).toBe("implementation");
    // One retry: two atomic writes, two verification reads.
    expect(atomicCalls(calls).length).toBe(2);
    expect(verifyCalls(calls).length).toBe(2);
    // Every attempt carried the full bundled tuple including the delegate.
    for (const call of atomicCalls(calls)) {
      expect((call as { variables: Record<string, unknown> }).variables.delegateId).toBe("u-igor");
    }
  });

  // ── AC2: exhausted retries fail loudly — error + op event + alert ────────

  it("AC2: a write that never persists returns an explicit error after bounded retries", async () => {
    const { fetch: mock, calls } = makeVerifyingFetch({
      atomicResults: [true],
      verifyResults: [DELEGATE_DROPPED_VERIFY], // dropped on every read-back
    });
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition.status).toBe("failed");
    expect(res.body._workflowTransition.code).toBe("transition-write-unverified");
    expect(res.body._workflowTransition.detail).toMatch(/delegate/);
    // Bounded retry: default policy is 3 attempts, then stop.
    expect(atomicCalls(calls).length).toBe(3);
    expect(verifyCalls(calls).length).toBe(3);
  });

  it("AC2: exhausted retries append a transition-write-failed operational event", async () => {
    const { fetch: mock } = makeVerifyingFetch({
      atomicResults: [true],
      verifyResults: [DELEGATE_DROPPED_VERIFY],
    });
    globalThis.fetch = mock;

    await acFailWithSatisfiedBy();

    const events = appState.operationalEventStore.query({ outcome: "transition-write-failed" });
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("AI-1759");
    expect(events[0].agent).toBe("astrid");
    const detail = events[0].detail as { attempts: number; failureKind: string; to: string };
    expect(detail.attempts).toBe(3);
    expect(detail.failureKind).toBe("verification");
    expect(detail.to).toBe("implementation");
  });

  it("AC2: exhausted retries raise an alert-bus warning", async () => {
    const { fetch: mock } = makeVerifyingFetch({
      atomicResults: [true],
      verifyResults: [DELEGATE_DROPPED_VERIFY],
    });
    globalThis.fetch = mock;

    await acFailWithSatisfiedBy();

    const alerts = alertStore.query({ source: "workflow-gate" });
    const alert = alerts.find((a) => a.dedupKey === "transition-write-failed|AI-1759");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
    expect(alert?.ticket).toBe("AI-1759");
  });

  // ── AC1: mutation-level failures are also retried ────────────────────────

  it("AC1: a transient mutation failure (success:false) is retried and succeeds", async () => {
    const { fetch: mock, calls } = makeVerifyingFetch({
      atomicResults: [false, true],
      verifyResults: [PERSISTED_VERIFY],
    });
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition.status).toBe("applied");
    // First mutation failed (no verify read for it), second succeeded and verified.
    expect(atomicCalls(calls).length).toBe(2);
    expect(verifyCalls(calls).length).toBe(1);
  });

  it("AC2: a mutation that fails on every attempt keeps the atomic-mutation-failed code and emits the event", async () => {
    const { fetch: mock, calls } = makeVerifyingFetch({ atomicResults: [false] });
    globalThis.fetch = mock;

    const res = await acFailWithSatisfiedBy();

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition.status).toBe("failed");
    expect(res.body._workflowTransition.code).toBe("atomic-mutation-failed");
    expect(atomicCalls(calls).length).toBe(3);
    expect(verifyCalls(calls).length).toBe(0);
    const events = appState.operationalEventStore.query({ outcome: "transition-write-failed" });
    expect(events.length).toBe(1);
    expect((events[0].detail as { failureKind: string }).failureKind).toBe("mutation");
  });
});
