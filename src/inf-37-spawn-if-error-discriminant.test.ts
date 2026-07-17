/**
 * INF-37 — `spawn_if` conflates "waived" with "evaluation failed".
 *
 * `evaluateSpawnIf` returns `shouldSpawn: false` on read failure, which is
 * indistinguishable from a legitimate waive. Both suppress the mint; only one is
 * an answer. A transient Linear error therefore presents as "the predicate
 * waived" → zero children → the barrier vacuously satisfies → the parent
 * advances past a sprint that never started.
 *
 * Fail-closed at the mint is fail-open at the barrier. Suppressing the spawn is
 * precisely what manufactures the zero children `evaluateBarrier` reads as
 * satisfaction (`barrier.ts:414`).
 *
 * ACs:
 *   1. `SpawnIfResult` distinguishes waived (predicate evaluated false on a
 *      successful read) from failed (read/eval error). `reason` is not a
 *      discriminant.
 *   2. Both the throwing path (`catch`) and the non-throwing paths
 *      (`data.errors`, `?? []`) yield failed, not waived.
 *   3. A failed evaluation does not produce a vacuously-satisfied barrier.
 *   4. Regression: a spawn_if state whose children query returns a GraphQL error
 *      does not waive and does not advance the parent.
 *   5. Existing AI-2523 tests stay green (see src/ai-2523-spawn-if.test.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeFanout, evaluateSpawnIf, type Finding } from "./fanout.js";
import {
  applyStateTransition,
  resetWorkflowCache,
  type FanoutConfig,
  type SpawnIfConfig,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Fanout state carrying a spawn_if predicate, flowing into a barrier state. */
const SYNTHETIC_SPAWN_IF_YAML = `
id: synthetic-spawn-if
version: 1
archetype: orchestrator
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: spawning, assign: { mode: required } }
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:dev-impl
      initial_delegate: igor
      spawn_if:
        label_present: ui-impact
        scope: closed_children
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: engine-1
    container: engine
    fills_roles: [engine]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const SPAWN_IF_CONFIG: FanoutConfig & { spawn_if: SpawnIfConfig } = {
  spec_source: "findings",
  child_workflow: "wf:dev-impl",
  spawn_if: { label_present: "ui-impact", scope: "closed_children" },
};

const FINDINGS: Finding[] = [{ title: "UI Audit item" }];

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Unit-level mock for the spawn_if children query. `childrenResponse` decides
 * what the ParentChildrenLabels query does; everything else succeeds so the
 * only variable under test is the predicate read.
 */
function makeFetch(childrenResponse: () => Response | never): typeof globalThis.fetch {
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call to " + url);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
    };
    const query = parsed.query ?? "";

    if (query.includes("ParentChildrenLabels")) return childrenResponse();
    if (query.includes("IssueTeamParent")) {
      return json({
        issue: {
          id: "parent-internal-uuid",
          title: "Parent",
          description: "## Findings\n- **A**: alpha\n",
          team: { id: "team-uuid" },
          parent: null,
        },
      });
    }
    if (query.includes("TeamLabels")) return json({ team: { labels: { nodes: [] } } });
    if (query.includes("issueLabelCreate")) {
      return json({ issueLabelCreate: { success: true, issueLabel: { id: "label-x" } } });
    }
    if (query.includes("issueCreate")) {
      return json({ issueCreate: { success: true, issue: { id: "c1", identifier: "AI-5001" } } });
    }
    if (query.includes("commentCreate")) {
      return json({ commentCreate: { success: true, comment: { id: "cm" } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 + AC2: the discriminant exists and every failure path sets it
// ═══════════════════════════════════════════════════════════════════════════

describe("INF-37 AC1/AC2: SpawnIfResult discriminates waived from failed", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("AC2: a GraphQL error on a 200 response yields failed, NOT waived", async () => {
    globalThis.fetch = makeFetch(() =>
      new Response(
        JSON.stringify({ errors: [{ message: "Internal server error" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("failed");
    expect(result.shouldSpawn).toBe(false);
  });

  it("AC2: a 200 whose data carries no issue yields failed, NOT waived (the ?? [] hole)", async () => {
    // The non-throwing path: `data.data?.issue?.children?.nodes ?? []` collapsed
    // "the read did not return the issue" into "the parent has no children".
    globalThis.fetch = makeFetch(() => json({ issue: null }));

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("failed");
    expect(result.shouldSpawn).toBe(false);
  });

  it("AC2: a non-OK HTTP response yields failed, NOT waived", async () => {
    globalThis.fetch = makeFetch(() => new Response("upstream boom", { status: 502 }));

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("failed");
    expect(result.shouldSpawn).toBe(false);
  });

  it("AC2: a transport throw yields failed, NOT waived", async () => {
    globalThis.fetch = makeFetch(() => {
      throw new Error("children query network failure");
    });

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("failed");
    expect(result.shouldSpawn).toBe(false);
  });

  it("AC1: a genuine predicate miss on a successful read is waived, not failed", async () => {
    // A real answer: the parent has children, one is closed, none carry the label.
    globalThis.fetch = makeFetch(() =>
      json({
        issue: {
          children: {
            nodes: [
              {
                identifier: "AI-3001",
                state: { name: "Done", type: "completed" },
                labels: { nodes: [{ id: "l1", name: "wf:dev-impl" }] },
              },
            ],
          },
        },
      }),
    );

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("waived");
    expect(result.shouldSpawn).toBe(false);
  });

  it("AC1: a childless parent on a successful read is waived, not failed", async () => {
    // AI-2523's contract: an issue that genuinely has no children is a real
    // answer. This must stay waived — it is the case the `!issue` guard sits
    // next to, and conflating them would break AI-2523 instead of INF-37.
    globalThis.fetch = makeFetch(() => json({ issue: { children: { nodes: [] } } }));

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("waived");
    expect(result.shouldSpawn).toBe(false);
  });

  it("AC1: a matched closed child fires", async () => {
    globalThis.fetch = makeFetch(() =>
      json({
        issue: {
          children: {
            nodes: [
              {
                identifier: "AI-3001",
                state: { name: "Done", type: "completed" },
                labels: { nodes: [{ id: "l1", name: "ui-impact" }] },
              },
            ],
          },
        },
      }),
    );

    const result = await evaluateSpawnIf("parent-internal-uuid", "Bearer tok", {
      label_present: "ui-impact",
    });

    expect(result.outcome).toBe("fire");
    expect(result.shouldSpawn).toBe(true);
  });

  it("AC1: the discriminant survives onto FanoutResult, and reason is not the discriminant", async () => {
    globalThis.fetch = makeFetch(() =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await executeFanout("AI-2000", "Bearer tok", SPAWN_IF_CONFIG, {
      skipPreview: true,
      findingsOverride: FINDINGS,
    });

    expect(result.created).toBe(0);
    expect(result.spawnIfResult?.outcome).toBe("failed");
    // The caller must classify without parsing prose. Guard the classification
    // against a reworded message: the outcome is what routes it to `errors`.
    expect(result.errors.some((e) => e.findingIndex === -1)).toBe(true);
  });

  it("AC1: a waive does NOT record a findingIndex -1 error", async () => {
    globalThis.fetch = makeFetch(() => json({ issue: { children: { nodes: [] } } }));

    const result = await executeFanout("AI-2000", "Bearer tok", SPAWN_IF_CONFIG, {
      skipPreview: true,
      findingsOverride: FINDINGS,
    });

    expect(result.created).toBe(0);
    expect(result.spawnIfResult?.outcome).toBe("waived");
    expect(result.errors.some((e) => e.findingIndex === -1)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 + AC4: a failed evaluation must not vacuously satisfy the barrier
// ═══════════════════════════════════════════════════════════════════════════

describe("INF-37 AC3/AC4: a failed spawn_if does not advance the parent", () => {
  let dir: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let origAgents: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    origAgents = process.env.AGENTS_FILE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf37-"));
    fs.writeFileSync(path.join(dir, "synthetic-spawn-if.yaml"), SYNTHETIC_SPAWN_IF_YAML, "utf8");
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
          { name: "engine-1", linearUserId: "engine1-linear-uuid", clientId: "e", clientSecret: "e", accessToken: "e", refreshToken: "e" },
          { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i", clientSecret: "i", accessToken: "i", refreshToken: "i" },
        ],
      }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    if (origPolicy !== undefined) process.env.CAPABILITY_POLICY_PATH = origPolicy;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (origAgents !== undefined) process.env.AGENTS_FILE = origAgents;
    else delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetPolicyCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Drives `spawning --spawn--> managing` end to end. `spawnIfChildren` decides
   * what the spawn_if predicate read does; the barrier's own children query
   * (`ParentChildren(`, distinct from `ParentChildrenLabels`) always reports a
   * childless parent — which is exactly the vacuous-satisfaction condition the
   * barrier would advance on.
   */
  function makeIntegrationFetch(opts: {
    spawnIfChildren: () => Response | never;
    record: Array<{ query: string; variables: Record<string, unknown> }>;
  }): typeof globalThis.fetch {
    // The parent's state label must track the transition: `applyStateTransition`
    // writes state:spawning → state:managing, and only THEN does the barrier
    // check run. A static label would leave the parent looking like it never
    // entered the barrier state, so the barrier would decline to advance for a
    // reason that has nothing to do with spawn_if — and the AC4 guards would
    // pass without exercising anything.
    let currentStateLabel = "state:spawning";
    const parentLabels = () => [
      { id: "wf-lbl", name: "wf:synthetic-spawn-if" },
      { id: "state-lbl", name: currentStateLabel },
    ];
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      opts.record.push({ query, variables: parsed.variables ?? {} });

      // spawn_if's predicate read (fanout.ts) — the variable under test.
      if (query.includes("ParentChildrenLabels")) return opts.spawnIfChildren();
      // The barrier's own child read (barrier.ts) — childless parent.
      if (query.includes("ParentChildren(")) return json({ issue: { children: { nodes: [] } } });
      // IssueLabels is fetchIssueWithLabels — the barrier's label-id read on the
      // way to the atomic swap. Omitting it made the barrier fail for a reason
      // unrelated to spawn_if, which silently turned the AC4 guards green.
      if (
        query.includes("IssueWithLabels") ||
        query.includes("IssueLabels") ||
        query.includes("ParentState") ||
        query.includes("ParentLabels")
      ) {
        return json({ issue: { id: "parent-internal-uuid", team: { id: "team-uuid" }, labels: { nodes: parentLabels() } } });
      }
      if (query.includes("TeamStates")) {
        return json({
          team: {
            states: {
              nodes: [
                { id: "s-todo", name: "Todo", type: "unstarted" },
                { id: "s-doing", name: "Doing", type: "started" },
                { id: "s-managing", name: "Managing", type: "started" },
                { id: "s-done", name: "Done", type: "completed" },
                { id: "s-invalid", name: "Invalid", type: "canceled" },
              ],
            },
          },
        });
      }
      if (query.includes("ApplyAtomicTransition")) {
        currentStateLabel = "state:managing";
        return json({ issueUpdate: { success: true } });
      }
      if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
        return json({ issue: { parent: null } });
      }
      if (query.includes("IssueTeamParent")) {
        return json({
          issue: {
            id: "parent-internal-uuid",
            title: "Parent",
            description: "## Findings\n- **A**: alpha\n",
            team: { id: "team-uuid" },
            parent: null,
          },
        });
      }
      if (query.includes("TeamLabels")) return json({ team: { labels: { nodes: [] } } });
      if (query.includes("issueLabelCreate")) {
        return json({ issueLabelCreate: { success: true, issueLabel: { id: "label-x" } } });
      }
      if (query.includes("issueCreate")) {
        return json({ issueCreate: { success: true, issue: { id: "c1", identifier: "AI-5001" } } });
      }
      if (query.includes("UpdateLabels")) return json({ issueUpdate: { success: true } });
      if (query.includes("commentCreate")) return json({ commentCreate: { success: true, comment: { id: "cm" } } });
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }


  it("AC4: a GraphQL error on the spawn_if read does not waive and does not advance the parent", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      spawnIfChildren: () =>
        new Response(JSON.stringify({ errors: [{ message: "Internal server error" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await applyStateTransition("spawn", "AI-2000", "Bearer tok");

    // The predicate could not be read, so nothing was minted.
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    // The barrier must not have advanced the parent out of `managing`.
    // `UpdateLabels` is the barrier's atomic state:managing → state:done swap.
    expect(record.some((c) => c.query.includes("UpdateLabels"))).toBe(false);
    // Stronger: the barrier must not even have evaluated — a childless read is
    // vacuous satisfaction, so reaching it at all is the defect.
    expect(record.some((c) => c.query.includes("ParentChildren("))).toBe(false);
  });

  it("AC4: a transport throw on the spawn_if read does not advance the parent", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      spawnIfChildren: () => {
        throw new Error("children query network failure");
      },
    });

    await applyStateTransition("spawn", "AI-2000", "Bearer tok");

    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(record.some((c) => c.query.includes("UpdateLabels"))).toBe(false);
  });

  it("AI-2523 preserved: a legitimate waive still advances the parent through the barrier", async () => {
    // The guard must be narrow. A real waive is a real answer — AI-2523's whole
    // contract is that it proceeds with no steward action. If this goes red, the
    // fix has over-blocked and broken the waive path instead of the error path.
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      spawnIfChildren: () => json({ issue: { children: { nodes: [] } } }),
    });

    await applyStateTransition("spawn", "AI-2000", "Bearer tok");

    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    // The barrier evaluated and advanced — zero children, vacuous satisfaction,
    // which is AI-1730's intended behavior on a state that declared no spawn.
    expect(record.some((c) => c.query.includes("UpdateLabels"))).toBe(true);
  });
});
