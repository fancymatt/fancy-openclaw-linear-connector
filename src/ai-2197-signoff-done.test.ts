/**
 * AI-2197 — wf:task sign-off→done edge silently declines.
 *
 * Tests that the `accept` transition (continue-workflow from sign-off) actually
 * applies the state label + native state change, reaching the `done` terminal.
 * Reproduces the GEN-129 defect where the review→sign-off edge applied but
 * sign-off→done was silently declined.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  resolveMetaIntent,
  buildStateTransitionReminder,
  applyStateTransition,
  resolveTransitionTargets,
  resolveTransitionDelegate,
  loadWorkflowDefById,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

const TASK_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
bodies:
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: astrid
    container: steward
    fills_roles: [department-head]
  - id: worker1
    container: dev
    fills_roles: [worker]
`;

const TOK = "Bearer test-token";
const ISSUE = "AI-2197";

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeCtxFetch(labelNames: string[]): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("TeamStates")) {
      return jsonResponse({ data: { team: { states: { nodes: [] } } } });
    }
    return jsonResponse({
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
          delegate: null,
        },
      },
    });
  }) as unknown as typeof globalThis.fetch;
}

interface FetchCall {
  body: { query?: string; variables?: Record<string, unknown> };
}

function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamLabels: Array<{ id: string; name: string }>;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mock = (async (_url: string, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as FetchCall["body"];
    calls.push({ body: parsed });
    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: "internal-uuid",
            identifier: ISSUE,
            team: { id: "team-uuid" },
            labels: { nodes: opts.issueLabels },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return jsonResponse({ data: { team: { labels: { nodes: opts.teamLabels } } } });
    }
    if (query.includes("TeamStates")) {
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-doing-uuid", name: "Doing", type: "started" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
                { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("issueLabelCreate")) {
      return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("UpdateDelegate")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: mock, calls };
}

describe("AI-2197 — wf:task sign-off→done edge (silent decline fix)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalDefPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let tmpDir: string;

  beforeAll(() => {
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2197-test-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TASK_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK_FIXTURE;
  });

  afterAll(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    };
    restore("WORKFLOW_DEF_PATH", originalDefPath);
    restore("CAPABILITY_POLICY_PATH", originalPolicyPath);
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // AC1: continue-workflow from sign-off resolves to 'accept'
  it("continue-workflow from sign-off resolves to accept", async () => {
    globalThis.fetch = makeCtxFetch(["wf:task", "state:sign-off"]);
    const res = await resolveMetaIntent("continue-workflow", ISSUE, TOK);
    expect(res).toEqual({ resolved: "accept" });
  });

  // AC2: accept from sign-off transitions to 'done' (terminal)
  it("accept from sign-off transitions to done and clears delegate", async () => {
    const def = await loadWorkflowDefById("task");
    const signOff = def!.states.find((s) => s.id === "sign-off");
    const accept = signOff!.transitions?.find((t) => t.command === "accept");
    expect(accept?.to).toBe("done");
    expect(accept?.generic).toBe("continue");

    const done = def!.states.find((s) => s.id === "done");
    expect(done?.kind).toBe("terminal");
    expect(done?.native_state).toBe("done");

    // Terminal → delegate cleared
    const delegate = await resolveTransitionDelegate("done", accept, def!, ISSUE);
    expect(delegate).toBeNull();

    const targets = await resolveTransitionTargets(accept!, def!);
    expect(targets.mode).toBe("none");
    expect(targets.bodies).toEqual([]);
  });

  // AC3: applyStateTransition from sign-off→done succeeds with correct label swap
  it("accept applies sign-off→done transition — state label changes to state:done", async () => {
    const def = await loadWorkflowDefById("task");
    const stateLabelIds = new Set(["signoff-lbl", "done-lbl"]);
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:task" },
        { id: "signoff-lbl", name: "state:sign-off" },
        { id: "prio-lbl", name: "priority:high" },
      ],
      teamLabels: [
        { id: "done-lbl", name: "state:done" },
      ],
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("accept", ISSUE, TOK, {
      sourceStateOverride: "sign-off",
      delegateOverride: null,
    });
    expect(result.status).toBe("applied");

    // Check the ApplyAtomicTransition was called with correct label set
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const labelIds = (updateCall!.body.variables as { labelIds: string[] }).labelIds;

    // Non-state labels preserved
    expect(labelIds).toContain("wf-lbl");
    expect(labelIds).toContain("prio-lbl");
    // Exactly one state:* label: state:done
    const stateLabels = labelIds.filter((id) => stateLabelIds.has(id));
    expect(stateLabels).toEqual(["done-lbl"]);
    // sign-off label removed
    expect(labelIds).not.toContain("signoff-lbl");
  });

  // AC4: buildStateTransitionReminder returns null for terminal state (done has no transitions)
  it("buildStateTransitionReminder returns null for accept from sign-off (done is terminal)", async () => {
    globalThis.fetch = makeCtxFetch(["wf:task", "state:sign-off"]);
    const msg = await buildStateTransitionReminder("accept", ISSUE, TOK);
    // Terminal state → no reminder needed
    expect(msg).toBeNull();
  });

  // AC5: the full accept path works end-to-end with the canonical task fixture
  it("done state exists in canonical task fixture with correct native_state", async () => {
    const def = await loadWorkflowDefById("task");
    const done = def!.states.find((s) => s.id === "done");
    expect(done).toBeDefined();
    expect(done!.kind).toBe("terminal");
    expect(done!.native_state).toBe("done");
    expect(done!.satisfies_parent_barrier).toBe(true);

    // No state other than sign-off may target done
    const nonSignOffToDone = def!.states
      .filter((s) => s.id !== "sign-off")
      .flatMap((s) => (s.transitions ?? []).map((t) => ({ from: s.id, to: t.to })))
      .filter((e) => e.to === "done");
    expect(nonSignOffToDone).toEqual([]);
  });
});
