/**
 * INF-37 — spawn_if conflates "waived" with "evaluation failed".
 *
 * `evaluateSpawnIf` returned `shouldSpawn: false` on read failure, which is
 * indistinguishable from a legitimate waive. A transient Linear error therefore
 * presented as "the predicate waived" → zero children → the barrier vacuously
 * satisfies (AI-1730) → the parent advances past a sprint that never started.
 *
 * This is INF-34's defect one layer up, on a different query. INF-34's fix in
 * `barrier.ts` does NOT cover it: there, the *barrier's own* children read
 * fails. Here the barrier read is perfectly healthy and honestly reports zero
 * children — because the spawn that would have created them never ran. The
 * integration mock below models exactly that: its barrier read always succeeds.
 *
 * Coverage:
 *   - AC1: `SpawnIfResult` carries an `outcome` discriminant; `reason` is prose.
 *   - AC2: BOTH the throwing path (catch) and the non-throwing paths
 *          (GraphQL `errors` on a 200, non-2xx, null issue) yield `failed`.
 *   - AC3: a `failed` evaluation does not produce a vacuously-satisfied barrier.
 *   - AC4: regression — a GraphQL error does not waive and does not advance.
 *   - Waive/fire paths keep their AI-2523 meaning (no contract change).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateSpawnIf, executeFanout, type Finding } from "./fanout.js";
import { applyStateTransition, resetWorkflowCache, type FanoutConfig } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

interface SpawnIfConfig {
  label_present: string;
  scope?: "closed_children";
}

const SPAWN_IF: SpawnIfConfig = { label_present: "ui-impact", scope: "closed_children" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 + AC2 — the discriminant, on every failure path
// ═══════════════════════════════════════════════════════════════════════════

describe("INF-37 AC1/AC2: evaluateSpawnIf distinguishes waived from failed", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── The non-throwing paths: these are the ones that silently waived ──────

  it("AC2: a GraphQL error on a 200 response yields failed, NOT waived", async () => {
    globalThis.fetch = async () =>
      json({ errors: [{ message: "Internal server error" }] });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("failed");
    expect(res.shouldSpawn).toBe(false);
    // The bug: this path returned the same shape as a waive. Assert the
    // discriminant explicitly — a `reason` string is not a contract.
    expect(res.outcome).not.toBe("waived");
  });

  it("AC2: a non-2xx response yields failed, NOT waived", async () => {
    // A 502 whose body still parses must not reach the `?? []` waive path.
    globalThis.fetch = async () => json({ data: { issue: null } }, 502);

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("failed");
    expect(res.shouldSpawn).toBe(false);
  });

  it("AC2: a 200 with a null issue yields failed, NOT waived", async () => {
    // Linear returns 200 + issue:null for an unreadable/absent parent.
    // `data.data?.issue?.children?.nodes ?? []` used to launder this into
    // "parent has no children" → waive.
    globalThis.fetch = async () => json({ data: { issue: null } });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("failed");
    expect(res.shouldSpawn).toBe(false);
  });

  it("AC2: a 200 with a missing children payload yields failed, NOT waived", async () => {
    globalThis.fetch = async () => json({ data: { issue: { id: "x" } } });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("failed");
    expect(res.shouldSpawn).toBe(false);
  });

  // ── The throwing path ───────────────────────────────────────────────────

  it("AC2: a transport throw yields failed", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNRESET"); };

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("failed");
    expect(res.shouldSpawn).toBe(false);
  });

  it("AC2: an unparseable body (HTML error page) yields failed", async () => {
    globalThis.fetch = async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("failed");
    expect(res.shouldSpawn).toBe(false);
  });

  // ── The genuine waive/fire paths keep their AI-2523 meaning ─────────────

  it("a successful read of zero children is waived, not failed (AI-2523 preserved)", async () => {
    globalThis.fetch = async () => json({ data: { issue: { children: { nodes: [] } } } });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("waived");
    expect(res.shouldSpawn).toBe(false);
  });

  it("a successful read whose closed children lack the label is waived", async () => {
    globalThis.fetch = async () =>
      json({
        data: {
          issue: {
            children: {
              nodes: [
                {
                  identifier: "AI-3001",
                  state: { name: "Done", type: "completed" },
                  labels: { nodes: [{ id: "l1", name: "some-other-label" }] },
                },
              ],
            },
          },
        },
      });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("waived");
    expect(res.shouldSpawn).toBe(false);
  });

  it("a matching closed child fires", async () => {
    globalThis.fetch = async () =>
      json({
        data: {
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
        },
      });

    const res = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    expect(res.outcome).toBe("fire");
    expect(res.shouldSpawn).toBe(true);
    expect(res.matchedChildren).toContain("AI-3001");
  });

  it("AC1: outcome is a real discriminant — reason prose is not load-bearing", async () => {
    // Regression guard for the old `reason.startsWith("spawn_if evaluation failed")`
    // caller check: rewording the prose must not reclassify a failure as a waive.
    globalThis.fetch = async () => json({ errors: [{ message: "boom" }] });
    const failed = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    globalThis.fetch = async () => json({ data: { issue: { children: { nodes: [] } } } });
    const waived = await evaluateSpawnIf("parent-uuid", "Bearer tok", SPAWN_IF);

    // Both are "no spawn" — shouldSpawn alone cannot tell them apart. That
    // ambiguity is the defect; `outcome` is what resolves it.
    expect(failed.shouldSpawn).toBe(waived.shouldSpawn);
    expect(failed.outcome).not.toBe(waived.outcome);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// executeFanout surfaces the failure rather than reporting a clean waive
// ═══════════════════════════════════════════════════════════════════════════

describe("INF-37: executeFanout reports a failed predicate as an error", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeFetch(childrenResponse: () => Response): typeof globalThis.fetch {
    return async (url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const query = parsed.query ?? "";
      if (query.includes("ParentChildrenLabels")) return childrenResponse();
      if (query.includes("IssueTeamParent")) {
        return json({
          data: {
            issue: {
              id: "parent-internal-uuid",
              title: "Sprint Parent",
              description: "## Findings\n- **Item One**: Desc one\n",
              team: { id: "team-uuid" },
              parent: null,
            },
          },
        });
      }
      if (query.includes("TeamLabels")) return json({ data: { team: { labels: { nodes: [] } } } });
      if (query.includes("commentCreate")) {
        return json({ data: { commentCreate: { success: true, comment: { id: "cm" } } } });
      }
      return json({ data: {} });
    };
  }

  const findings: Finding[] = [{ title: "UI Audit item" }];
  const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
    spec_source: "findings",
    child_workflow: "wf:dev-impl",
    spawn_if: SPAWN_IF,
  };

  it("a GraphQL error on the children query → created 0, error recorded, outcome failed", async () => {
    globalThis.fetch = makeFetch(() => json({ errors: [{ message: "Internal server error" }] }));

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);
    expect(result.spawnIfResult?.outcome).toBe("failed");
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].message).toMatch(/spawn_if evaluation failed/i);
  });

  it("a genuine waive → created 0, NO error recorded, outcome waived", async () => {
    globalThis.fetch = makeFetch(() => json({ data: { issue: { children: { nodes: [] } } } }));

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);
    expect(result.spawnIfResult?.outcome).toBe("waived");
    // A waive is a legitimate answer, not an error.
    expect(result.errors).toHaveLength(0);
  });

  it("a non-2xx children query is reported as an error, not a silent waive", async () => {
    // This path did NOT start with "spawn_if evaluation failed", so the old
    // prefix-matching caller classified it as a waive and posted a WAIVE comment.
    globalThis.fetch = makeFetch(() => json({ data: { issue: null } }, 502));

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);
    expect(result.spawnIfResult?.outcome).toBe("failed");
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("the failure comment does not claim the parent will waive or advance", async () => {
    const comments: string[] = [];
    const base = makeFetch(() => json({ errors: [{ message: "Internal server error" }] }));
    globalThis.fetch = async (url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string; variables?: Record<string, unknown>;
      };
      if (parsed.query?.includes("commentCreate")) {
        comments.push(String(parsed.variables?.body ?? ""));
      }
      return base(url, init);
    };

    await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(comments.length).toBeGreaterThanOrEqual(1);
    const body = comments.join("\n");
    expect(body).toMatch(/could not be evaluated/i);
    // It must not be reported to the steward as a waive.
    expect(body).not.toMatch(/WAIVE — skipping spawn/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 + AC4 — the payload: a failed predicate must not vacuously satisfy
// ═══════════════════════════════════════════════════════════════════════════

const SPAWN_IF_FANOUT_YAML = `
id: inf37-fanout
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

/**
 * Drives a full `spawn` transition into the barrier state. `childrenQuery`
 * controls what the spawn_if predicate's children read returns.
 */
function makeIntegrationFetch(opts: {
  record: Array<{ query: string; variables: Record<string, unknown> }>;
  childrenQuery: () => Response;
}): typeof globalThis.fetch {
  // Mutable: the parent really does move spawning → managing when the
  // transition is applied, and the barrier re-reads this state to decide
  // whether it is even at a barrier. A frozen `state:spawning` here makes the
  // barrier skip itself ("not a barrier state"), which would render every
  // "does not advance" assertion below vacuously true.
  let parentState = "spawning";
  const parentLabels = () => [
    { id: "wf-lbl", name: "wf:inf37-fanout" },
    { id: "state-lbl", name: `state:${parentState}` },
  ];

  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string; variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    opts.record.push({ query, variables: parsed.variables ?? {} });

    // The spawn_if predicate's read — the seam under test.
    if (query.includes("ParentChildrenLabels")) return opts.childrenQuery();

    if (query.includes("IssueWithLabels")) {
      return json({ data: { issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels() } } } });
    }
    if (query.includes("TeamStates")) {
      return json({
        data: {
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
        },
      });
    }
    if (query.includes("ApplyAtomicTransition")) {
      // The transition really lands: the parent is now AT the barrier state.
      parentState = "managing";
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
      return json({ data: { issue: { parent: null } } });
    }
    if (query.includes("IssueTeamParent")) {
      return json({
        data: {
          issue: {
            id: "parent-internal-id",
            title: "Parent",
            description: "## Findings\n- **Item One**: Desc one\n- **Item Two**: Desc two\n",
            team: { id: "team-uuid" },
            parent: null,
          },
        },
      });
    }
    if (query.includes("ParentLabels") || query.includes("ParentState") || query.includes("IssueLabels")) {
      return json({ data: { issue: { id: "parent-internal-id", team: { id: "team-uuid" }, labels: { nodes: parentLabels() } } } });
    }
    if (query.includes("ParentChildren")) {
      // The barrier's OWN children read (barrier.ts). Deliberately healthy and
      // honest: there genuinely are zero children, because the spawn never ran.
      // This is what makes INF-37 distinct from INF-34 — no read here is broken,
      // yet the parent still advances past a sprint that never started.
      return json({ data: { issue: { children: { nodes: [] } } } });
    }
    if (query.includes("TeamLabels")) return json({ data: { team: { labels: { nodes: [] } } } });
    if (query.includes("issueLabelCreate")) {
      const name = (parsed.variables as Record<string, unknown>).name as string;
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } } });
    }
    if (query.includes("UpdateLabels")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "cm" } } } });
    }
    if (query.includes("issueCreate")) {
      return json({ data: { issueCreate: { success: true, issue: { id: "child-uuid", identifier: "CHILD-1" } } } });
    }
    return json({ data: {} });
  };
}

/**
 * Did the barrier actually advance the parent out of the barrier state?
 *
 * Keyed on the barrier resolving its forward target label (`managing → done`).
 * `UpdateLabels` alone is NOT a valid signal — the gate issues it for unrelated
 * label purges too, so asserting on it would conflate the barrier's swap with
 * ordinary bookkeeping. Only the barrier resolves `state:done` in this workflow.
 */
function barrierAdvanced(record: Array<{ query: string; variables: Record<string, unknown> }>): boolean {
  return record.some(
    (c) => c.query.includes("issueLabelCreate") && c.variables.name === "state:done",
  );
}

describe("INF-37 AC3/AC4: a failed spawn_if does not vacuously satisfy the barrier", () => {
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
    // Keep the defs dir pure — the registry tries to load every YAML in it.
    const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf37-support-"));
    fs.writeFileSync(path.join(dir, "inf37-fanout.yaml"), SPAWN_IF_FANOUT_YAML, "utf8");
    // INF-41: the fanout config validation (validateFanoutSpec) requires the
    // child_workflow label (wf:dev-impl) to reference a registered workflow def.
    // Without this file, the validation rejects the transition before the fan-out
    // engine ever reaches the spawn_if evaluation.
    const devImplYaml = `
id: dev-impl
version: 1
archetype: dev
entry_state: intake
states:
  - id: intake
    owner_role: dev
    native_state: todo
    transitions:
      - { command: begin, to: implementation }
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
`;
    fs.writeFileSync(path.join(dir, "dev-impl.yaml"), devImplYaml.trimStart(), "utf8");
    const policyFile = path.join(supportDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    const agentsFile = path.join(supportDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "engine-1", linearUserId: "engine1-linear-uuid", clientId: "e1-client", clientSecret: "e1-secret", accessToken: "e1-token", refreshToken: "e1-refresh" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-client", clientSecret: "i-secret", accessToken: "i-token", refreshToken: "i-refresh" },
      ],
    }, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir; else delete process.env.WORKFLOW_DEFS_DIR;
    if (origPolicy !== undefined) process.env.CAPABILITY_POLICY_PATH = origPolicy; else delete process.env.CAPABILITY_POLICY_PATH;
    if (origAgents !== undefined) process.env.AGENTS_FILE = origAgents; else delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetPolicyCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("AC4: a GraphQL error on the children query does NOT advance the parent past the barrier", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      childrenQuery: () => json({ errors: [{ message: "Internal server error" }] }),
    });

    await applyStateTransition("spawn", "INF-37-P", "Bearer tok");

    // No children were spawned — the predicate could not be evaluated.
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);

    // THE REGRESSION: the barrier must not fire. Before the fix, the error
    // waived → zero children → AI-1730 vacuous satisfaction → the parent
    // advanced out of `managing` on a transient API blip, logged as healthy.
    expect(barrierAdvanced(record)).toBe(false);
  });

  it("AC4: the steward is told the predicate failed, not that it waived", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      childrenQuery: () => json({ errors: [{ message: "Internal server error" }] }),
    });

    await applyStateTransition("spawn", "INF-37-P", "Bearer tok");

    const comments = record
      .filter((c) => c.query.includes("commentCreate"))
      .map((c) => String(c.variables.body ?? ""));
    expect(comments.length).toBeGreaterThanOrEqual(1);
    // The error is a failed evaluation (not a successful waive). The exact
    // error message depends on whether the failure is a transport error, a
    // GraphQL error, or a config validation error (INF-41). The contract is:
    // the steward is told the predicate failed and the transition was refused.
    expect(comments.join("\n")).toMatch(/(could not be evaluated|spawn_if evaluation failed|fan-out refused)/i);
  });

  it("AC3: a transport throw on the children query also does NOT advance the parent", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      childrenQuery: () => { throw new Error("ECONNRESET"); },
    });

    await applyStateTransition("spawn", "INF-37-P", "Bearer tok");

    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(barrierAdvanced(record)).toBe(false);
  });

  it("AC3: a non-2xx on the children query also does NOT advance the parent", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      childrenQuery: () => json({ data: { issue: null } }, 502),
    });

    await applyStateTransition("spawn", "INF-37-P", "Bearer tok");

    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(barrierAdvanced(record)).toBe(false);
  });

  it("a genuine waive DOES still advance the parent (AI-2523/AI-1730 contract preserved)", async () => {
    // The other half of the contract, and the positive control for this whole
    // describe block: without it, every "does not advance" assertion above
    // would pass vacuously if the harness never reached the barrier at all.
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = makeIntegrationFetch({
      record,
      childrenQuery: () => json({ data: { issue: { children: { nodes: [] } } } }),
    });

    await applyStateTransition("spawn", "INF-37-P", "Bearer tok");

    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(barrierAdvanced(record)).toBe(true);
  });
});
