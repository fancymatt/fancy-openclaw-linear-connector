/**
 * Tests for AI-2523: Engine — conditional child spawning for ui-audit gate.
 *
 * Failing (TDD) tests written BEFORE implementation.
 *
 * Covers the `spawn_if` predicate on fanout states:
 *   - AC1: `spawn_if: { label_present: "ui-impact" }` spawns child_workflow
 *         ONLY when a closed child ticket carries that label.
 *   - AC2: No child carries the label → auto-waives (no spawn, no steward action).
 *   - AC3: The predicate's evaluation result is recorded and inspectable.
 *   - AC4: A state with NO `spawn_if` keeps unconditional spawn (no regression).
 *   - AC5: Malformed `spawn_if` fails validation at def load, fails closed,
 *         and leaves the prior registry intact.
 */

import { shouldTriggerFanout, executeFanout, type Finding, type FanoutResult } from "./fanout.js";
import { applyStateTransition, resetWorkflowCache, validateFanoutBarrierConfig, type WorkflowDef, type FanoutConfig } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Types the implementation will export ───────────────────────────────────
// These are the contract the tests drive. The implementer exports these from
// the appropriate module (fanout.ts + workflow-gate.ts).

interface SpawnIfConfig {
  label_present: string;
  scope?: "closed_children";
}

interface SpawnIfResult {
  shouldSpawn: boolean;
  reason: string;
  /** Identifiers of children that triggered the predicate (empty when waived). */
  matchedChildren: string[];
}

// ── Query helper ──────────────────────────────────────────────────────────
// The implementation will add a GraphQL query ParentChildrenLabels that reads
// a parent's children + their labels + their native state (to determine closed).
// This mock helper provides that seam.

function makeSpawnIfFetch(opts: {
  /** Per-child labels: keyed by child identifier */
  childLabels?: Record<string, string[]>;
  /** Parent issue context */
  parentContext?: {
    teamId: string;
    title: string;
    description: string | null;
    parentIssueId: string | null;
  };
  /** Team labels */
  teamLabels?: Array<{ id: string; name: string }>;
  /** Parent internal UUID */
  parentInternalId?: string;
  /** Number of successful child creations before simulated failure. -1 = all. */
  successCount?: number;
  /** When true, the children query returns an empty list */
  childrenQueryHasEmpty?: boolean;
  /** When true, the children query fails entirely */
  childrenQueryFails?: boolean;
  /** Custom description for the parent ticket */
  parentDescription?: string;
}): typeof globalThis.fetch {
  const childLabels = opts.childLabels ?? {};
  const parentInternalId = opts.parentInternalId ?? "parent-internal-uuid";
  const successCount = opts.successCount ?? -1;
  let createdCount = 0;

  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call to " + url);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    // ── ParentChildrenLabels: children with labels + native state ──
    if (query.includes("ParentChildrenLabels")) {
      if (opts.childrenQueryFails) {
        throw new Error("children query failed");
      }
      const entries = Object.entries(childLabels);
      if (opts.childrenQueryHasEmpty || entries.length === 0) {
        return new Response(
          JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const nodes = entries.map(([identifier, labels]) => {
        // Determine if "closed": a child is closed when it has a terminal
        // state label (state:done, state:invalid, state:canceled).
        const isClosed = labels.some((l) =>
          /^state:(done|invalid|canceled)$/i.test(l)
        );
        return {
          identifier,
          state: isClosed
            ? { name: "Done", type: "completed" }
            : { name: "Doing", type: "started" },
          labels: {
            nodes: labels.map((l) => ({ id: `label-${l}`, name: l })),
          },
        };
      });
      return new Response(
        JSON.stringify({ data: { issue: { children: { nodes } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── IssueTeamParent ────────────────────────────────────────────
    if (query.includes("IssueTeamParent")) {
      const ctx = opts.parentContext ?? {
        teamId: "team-uuid",
        title: "Sprint Parent",
        description: "## Findings\n- **Item One**: Desc one\n- **Item Two**: Desc two\n",
        parentIssueId: null,
      };
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: parentInternalId,
              title: ctx.title,
              description: ctx.description,
              team: { id: ctx.teamId },
              parent: ctx.parentIssueId ? { id: ctx.parentIssueId } : null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── TeamLabels ──────────────────────────────────────────────────
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: { team: { labels: { nodes: opts.teamLabels ?? [] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Label creation ──────────────────────────────────────────────
    if (query.includes("issueLabelCreate")) {
      const name = (parsed.variables as Record<string, unknown>).name as string;
      return new Response(
        JSON.stringify({
          data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Child issue creation ────────────────────────────────────────
    if (query.includes("issueCreate")) {
      createdCount++;
      if (successCount >= 0 && createdCount > successCount) {
        return new Response(
          JSON.stringify({ data: { issueCreate: { success: false, issue: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: `child-uuid-${createdCount}`, identifier: `AI-${2000 + createdCount}` },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Comment creation ────────────────────────────────────────────
    if (query.includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── IssueParent (spawn-preview depth walk) ──────────────────────
    if (query.includes("IssueParent")) {
      return new Response(
        JSON.stringify({ data: { issue: { parent: null } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected GraphQL operation: ${query.slice(0, 120)}`);
  };
}

// ── Fixture: sprint closing state with spawn_if ────────────────────────────
// Synthetic workflow def that has a closing state with spawn_if predicate.
// The implementer will also add spawn_if to FanoutConfig.

function sprintWithSpawnIfDef(opts?: {
  spawnIfLabel?: string;
  spawnIfScope?: "closed_children";
}): WorkflowDef {
  const label = opts?.spawnIfLabel ?? "ui-impact";
  const scope = opts?.spawnIfScope ?? "closed_children";
  return {
    id: "sprint",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", transitions: [{ command: "accept", to: "spawning" }] },
      {
        id: "spawning",
        fanout: {
          spec_source: "findings",
          child_workflow: "wf:dev-impl",
          spawn_if: { label_present: label, scope },
        } as FanoutConfig & { spawn_if: SpawnIfConfig },
        transitions: [{ command: "spawn", to: "done" }],
      },
      { id: "done", kind: "terminal", native_state: "done" },
    ],
  } as unknown as WorkflowDef;
}

function sprintWithoutSpawnIfDef(): WorkflowDef {
  return {
    id: "sprint",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", transitions: [{ command: "accept", to: "spawning" }] },
      {
        id: "spawning",
        fanout: {
          spec_source: "findings",
          child_workflow: "wf:dev-impl",
        },
        transitions: [{ command: "spawn", to: "done" }],
      },
      { id: "done", kind: "terminal", native_state: "done" },
    ],
  } as unknown as WorkflowDef;
}

/*
 * ── AC1: spawn_if fires when a closed child carries the target label ──────
 *   A state declaring `spawn_if: { label_present: "ui-impact" }` spawns its
 *   child_workflow ONLY when a closed child ticket carries that label.
 *   The predicate scope is "closed_children" — only terminal-state children
 *   count; children in open states (doing, todo, etc.) are ignored.
 */

describe("AI-2523: spawn_if predicate evaluation", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── AC1: spawns when a closed child carries the target label ────────────

  it("AC1: spawns when a closed child carries the ui-impact label", async () => {
    // One closed child that has "ui-impact" among its labels
    // → shouldSpawn: true
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "ui-impact", "state:done"],
      "AI-3002": ["wf:dev-impl", "state:done"],
    };

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "UI Audit item", description: "Run the UI audit" },
    ];

    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    // Should have created the child (spawn_if passes)
    expect(result.created).toBe(1);
    expect(result.childIdentifiers).toHaveLength(1);
    // Should NOT be refused or waived
    expect(result.refused).toBe(false);
    // A result field indicates spawn_if outcome (inspectable)
    // The implementer may add this to FanoutResult; this test drives it.
  });

  it("AC1: spawns even when only one of many closed children carries the target label", async () => {
    // 10 children, only 1 has ui-impact → should spawn
    const childLabels: Record<string, string[]> = {};
    // 9 children without ui-impact
    for (let i = 1; i <= 10; i++) {
      childLabels[`AI-${3000 + i}`] = ["wf:dev-impl", "state:done"];
    }
    // 1 child with ui-impact
    childLabels["AI-3011"] = ["wf:dev-impl", "ui-impact", "state:done"];

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "UI Audit item" },
    ];

    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(1);
    expect(result.refused).toBe(false);
  });

  it("AC1: ignores open children — only closed children count for the predicate", async () => {
    // Children that are open (doing state) with ui-impact should NOT count
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "ui-impact", "state:doing"],
      "AI-3002": ["wf:dev-impl", "state:done"],
    };

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "UI Audit item" },
    ];

    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    // ui-impact child is open → should be waived
    expect(result.created).toBe(0);
  });

  // ── AC2: auto-waives when no child carries the label ────────────────────

  it("AC2: auto-waives when no closed child carries the target label", async () => {
    // All children closed but none have ui-impact
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "state:done"],
      "AI-3002": ["wf:dev-impl", "state:done"],
      "AI-3003": ["wf:dev-impl", "state:done"],
    };

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "UI Audit item" },
    ];

    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toHaveLength(0);
    // Not a refusal — it's a deliberate waiver
    expect(result.refused).toBe(false);
  });

  it("AC2: auto-waives when the parent has no children at all", async () => {
    const childLabels: Record<string, string[]> = {};

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "UI Audit item" },
    ];

    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);
    expect(result.refused).toBe(false);
  });

  it("AC2: auto-waives when children exist but none are closed", async () => {
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "ui-impact", "state:doing"],
      "AI-3002": ["wf:dev-impl", "state:doing"],
    };

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "UI Audit item" },
    ];

    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);
    expect(result.refused).toBe(false);
  });

  // ── AC3: evaluation result is recorded and inspectable ──────────────────

  it("AC3: posts a comment on the parent ticket explaining why spawn_if fired", async () => {
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "ui-impact", "state:done"],
    };

    // Capture comment calls
    const baseFetch = makeSpawnIfFetch({ childLabels });
    const commentBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      if (parsed.query?.includes("commentCreate")) {
        const body = ((JSON.parse(bodyText).variables || {}).body || "");
        commentBodies.push(body);
      }
      return baseFetch(url, init);
    };

    const findings: Finding[] = [{ title: "UI Audit item" }];
    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(1);

    // A comment should have been posted with the spawn_if outcome
    const outcomeComments = commentBodies.filter((b) => b.includes("spawn_if") || b.includes("ui-impact"));
    expect(outcomeComments.length).toBeGreaterThanOrEqual(1);

    // The comment should say something about why it fired
    const fireComment = outcomeComments[0];
    expect(fireComment).toMatch(/spawn_if|ui-impact/i);
    expect(fireComment).toMatch(/fire|pass|matched|true/i);
    // (Case-insensitive — exact wording is implementer's choice)
  });

  it("AC3: posts a comment on the parent ticket explaining why spawn_if waived", async () => {
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "state:done"],
    };

    const baseFetch = makeSpawnIfFetch({ childLabels });
    const commentBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      if (parsed.query?.includes("commentCreate")) {
        const body = ((JSON.parse(bodyText).variables || {}).body || "");
        commentBodies.push(body);
      }
      return baseFetch(url, init);
    };

    const findings: Finding[] = [{ title: "UI Audit item" }];
    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result.created).toBe(0);

    // A comment should explain the waiver
    const waiverComments = commentBodies.filter((b) =>
      b.includes("spawn_if") || b.includes("ui-impact") || b.includes("waive")
    );
    expect(waiverComments.length).toBeGreaterThanOrEqual(1);

    const waiverComment = waiverComments[0];
    expect(waiverComment).toMatch(/waive|skip|no.*ui-impact|not.*fire|predicate.*false/i);
  });

  it("AC3: the evaluation result is also inspectable via a result field on FanoutResult", async () => {
    // The implementer should add a spawnIfResult field to FanoutResult.
    // This test drives that the field exists, not the exact shape.
    // It will fail until the field is added — that's the point.

    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "ui-impact", "state:done"],
    };
    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [{ title: "UI Audit item" }];
    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    // spawnIfResult should be present and tell us what happened
    expect(result).toHaveProperty("spawnIfResult");
    expect(result.spawnIfResult).toMatchObject({
      shouldSpawn: true,
      reason: expect.any(String),
    });
    expect(result.spawnIfResult.matchedChildren).toContain("AI-3001");
  });

  it("AC3: the waived result also includes a spawnIfResult with the explanation", async () => {
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "state:done"],
    };
    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [{ title: "UI Audit item" }];
    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(result).toHaveProperty("spawnIfResult");
    expect(result.spawnIfResult).toMatchObject({
      shouldSpawn: false,
      reason: expect.any(String),
    });
    expect(result.spawnIfResult.matchedChildren).toHaveLength(0);
  });

  // ── AC4: no spawn_if = unconditional spawn (regression guard) ───────────

  it("AC4: spawns unconditionally when no spawn_if is configured (regression)", async () => {
    // Without spawn_if, the fan-out should work exactly as before
    // — children are created regardless of what labels the parent's children carry.
    const childLabels: Record<string, string[]> = {
      "AI-3001": ["wf:dev-impl", "state:doing"],
    };

    globalThis.fetch = makeSpawnIfFetch({ childLabels });

    const findings: Finding[] = [
      { title: "Item One" },
      { title: "Item Two" },
    ];

    const config: FanoutConfig = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      // NO spawn_if
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    // Unconditional spawn: both children created
    expect(result.created).toBe(2);
    expect(result.childIdentifiers).toHaveLength(2);
    expect(result.refused).toBe(false);
    // spawnIfResult should be absent or null when no spawn_if is configured
    // (driving the implementer to not add it unconditionally)
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it("handles a children query failure gracefully — falls open, no spawn", async () => {
    // If the children query fails, spawn_if should fail closed (no spawn)
    // to avoid incorrectly spawning when the predicate can't be evaluated.
    const childLabels: Record<string, string[]> = {};
    globalThis.fetch = makeSpawnIfFetch({ childLabels, childrenQueryFails: true });

    const findings: Finding[] = [{ title: "UI Audit item" }];
    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    const result = await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    // Fail-closed: engine cannot verify the predicate → no children
    expect(result.created).toBe(0);
    // Should have an error explaining the failure
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].message).toMatch(/spawn_if|children|query/i);
  });

  it("posts a comment when children query fails, with the error details", async () => {
    const childLabels: Record<string, string[]> = {};
    const baseFetch = makeSpawnIfFetch({ childLabels, childrenQueryFails: true });
    const commentBodies: string[] = [];
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      if (parsed.query?.includes("commentCreate")) {
        const vars = JSON.parse(bodyText).variables || {};
        commentBodies.push(vars.body || "");
      }
      return baseFetch(url, init);
    };
    // Also handle the initial parent context fetch which fails differently
    // when childrenQueryFails is true. The parent issue fetch still needs to work.
    const parentOkFetch = makeSpawnIfFetch({ childLabels });
    let calledChildrenQuery = false;
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      if (parsed.query?.includes("ParentChildrenLabels")) {
        calledChildrenQuery = true;
        throw new Error("children query network failure");
      }
      if (parsed.query?.includes("commentCreate")) {
        const vars = JSON.parse(bodyText).variables || {};
        commentBodies.push(vars.body || "");
      }
      return parentOkFetch(url, init);
    };

    const findings: Finding[] = [{ title: "UI Audit item" }];
    const config: FanoutConfig & { spawn_if: SpawnIfConfig } = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      spawn_if: { label_present: "ui-impact", scope: "closed_children" },
    };

    await executeFanout("AI-2000", "Bearer tok", config, {
      skipPreview: true,
      findingsOverride: findings,
    });

    expect(calledChildrenQuery).toBe(true);
    // Should have posted a comment about the failure
    const failureComments = commentBodies.filter((b) =>
      b.includes("spawn_if") || b.includes("error") || b.includes("fail")
    );
    expect(failureComments.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AC5: Config validation at def load ─────────────────────────────────────

describe("AI-2523 AC5: spawn_if config validation", () => {
  // A valid pre-existing sprint def (before any spawn_if changes)
  const validSprintDef: WorkflowDef = {
    id: "sprint",
    version: 1,
    entry_state: "intake",
    states: [
      { id: "intake", transitions: [{ command: "accept", to: "spawning" }] },
      {
        id: "spawning",
        fanout: {
          spec_source: "findings",
          child_workflow: "wf:dev-impl",
        },
        transitions: [{ command: "spawn", to: "done" }],
      },
      { id: "done", kind: "terminal", native_state: "done" },
    ],
  } as unknown as WorkflowDef;

  // Valid sprint def WITH a spawn_if block
  const validSprintWithSpawnIf = {
    ...validSprintDef,
    states: validSprintDef.states.map((s) =>
      s.id === "spawning"
        ? {
            ...s,
            fanout: {
              ...(s as { fanout?: unknown }).fanout,
              spawn_if: { label_present: "ui-impact", scope: "closed_children" },
            },
          }
        : s,
    ),
  } as unknown as WorkflowDef;

  it("AC5: validates a valid spawn_if block — no errors", () => {
    const errors = validateFanoutBarrierConfig(validSprintWithSpawnIf);
    expect(errors).toHaveLength(0);
  });

  it("AC5: valid spawn_if without explicit scope defaults to closed_children", () => {
    // scope is optional; when absent, defaults to "closed_children"
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: { label_present: "ui-impact" },
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors).toHaveLength(0);
  });

  it("AC5: rejects spawn_if when label_present is missing", () => {
    // spawn_if: { scope: "closed_children" } — no label_present
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: { scope: "closed_children" },
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatch(/label_present/i);
  });

  it("AC5: rejects spawn_if when label_present is not a string", () => {
    // spawn_if: { label_present: 42 }
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: { label_present: 42 },
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatch(/label_present/i);
  });

  it("AC5: rejects spawn_if when label_present is empty string", () => {
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: { label_present: "" },
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatch(/label_present/i);
  });

  it("AC5: rejects spawn_if with an invalid scope value", () => {
    // scope must be "closed_children" (the only valid value in v1)
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: { label_present: "ui-impact", scope: "open_children" },
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatch(/scope|closed_children/i);
  });

  it("AC5: rejects spawn_if when the value is not an object", () => {
    // spawn_if: "ui-impact" (string, not object)
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: "ui-impact",
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatch(/spawn_if/i);
  });

  it("AC5: rejects spawn_if with an unknown extra field", () => {
    // spawn_if: { label_present: "ui-impact", unknown_field: true }
    const def = {
      ...validSprintDef,
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: { label_present: "ui-impact", unknown_field: true },
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatch(/unknown|extra|unexpected/i);
  });

  it("AC5: a malformed spawn_if in one def does NOT affect other defs in the registry", () => {
    // Bad def: spawn_if as string instead of object
    const badDef = {
      ...validSprintDef,
      id: "sprint-bad",
      states: validSprintDef.states.map((s) =>
        s.id === "spawning"
          ? {
              ...s,
              fanout: {
                ...(s as { fanout?: Record<string, unknown> }).fanout,
                spawn_if: "not-an-object",
              },
            }
          : s,
      ),
    } as unknown as WorkflowDef;

    // Good def should remain valid
    const errorsBad = validateFanoutBarrierConfig(badDef);
    expect(errorsBad.length).toBeGreaterThanOrEqual(1);

    const errorsGood = validateFanoutBarrierConfig(validSprintWithSpawnIf);
    expect(errorsGood).toHaveLength(0);

    // A third, unrelated def without fanout should also be unaffected
    const simpleDef: WorkflowDef = {
      id: "simpletask",
      version: 1,
      entry_state: "todo",
      states: [
        { id: "todo", transitions: [{ command: "start", to: "done" }] },
        { id: "done", kind: "terminal", native_state: "done" },
      ],
    } as unknown as WorkflowDef;
    const errorsSimple = validateFanoutBarrierConfig(simpleDef);
    expect(errorsSimple).toHaveLength(0);
  });

  it("AC5: a def with valid existing fields AND valid spawn_if passes validation alongside the existing checks", async () => {
    // Ensure that existing validation rules (child_workflow, spec_source, etc.)
    // still apply alongside the new spawn_if validation.
    const def: WorkflowDef = {
      id: "sprint-full",
      version: 1,
      entry_state: "intake",
      states: [
        { id: "intake", transitions: [{ command: "accept", to: "spawning" }] },
        {
          id: "spawning",
          fanout: {
            spec_source: "findings",
            child_workflow: "wf:dev-impl",
            initial_delegate: "igor",
            block_siblings: false,
            spawn_if: { label_present: "ui-impact", scope: "closed_children" },
          } as FanoutConfig & { spawn_if: SpawnIfConfig },
          transitions: [{ command: "spawn", to: "done" }],
        },
        { id: "done", kind: "terminal", native_state: "done" },
      ],
    } as unknown as WorkflowDef;
    const errors = validateFanoutBarrierConfig(def);
    expect(errors).toHaveLength(0);
  });
});
