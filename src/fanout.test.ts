/**
 * Tests for Phase 5 / B-2 — Fan-out edge (spawning 1→N), AI-1439.
 *
 * Covers:
 *   - extractFindings: finding extraction from ticket descriptions
 *   - executeFanout: full fan-out with mocked Linear API
 *   - shouldTriggerFanout: trigger condition logic
 *   - Integration: applyStateTransition triggers fan-out for ux-audit spawn
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFindings, executeFanout, shouldTriggerFanout, type Finding } from "./fanout.js";
import { applyStateTransition, resetWorkflowCache, type WorkflowDef, type FanoutConfig } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";

const CANONICAL_UX_AUDIT_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-ux-audit.yaml");

// AI-1992: the fan-out is now config-driven. The canonical dev-impl child config
// (spec_source=findings, wf:dev-impl child) that ux-audit/sprint migrated to.
const DEV_IMPL_FANOUT_CONFIG = { spec_source: "findings", child_workflow: "wf:dev-impl" } as FanoutConfig;

// ── Test capability policy with ux-audit roles ────────────────────────────

const UX_AUDIT_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: ux-researcher
    grants: [linear:transition]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: ux-researcher
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: maya
    container: ux-researcher
    fills_roles: [ux-researcher]
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

// ── extractFindings ────────────────────────────────────────────────────────

describe("extractFindings", () => {
  it("returns fallback title when description is null", () => {
    const result = extractFindings(null, "Fallback");
    expect(result).toEqual([{ title: "Fallback" }]);
  });

  it("returns fallback title when description is undefined", () => {
    const result = extractFindings(undefined, "Fallback");
    expect(result).toEqual([{ title: "Fallback" }]);
  });

  it("returns fallback title when description is empty string", () => {
    const result = extractFindings("", "Fallback");
    expect(result).toEqual([{ title: "Fallback" }]);
  });

  it("extracts findings from bullet list in ## Findings section", () => {
    const description = [
      "Some intro text",
      "",
      "## Findings",
      "- **Missing auth on /api/users**: The endpoint has no auth check",
      "- **SQL injection in search**: User input not sanitized",
      "- **XSS in profile name**: Stored XSS vulnerability",
      "",
      "Some trailing text",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("Missing auth on /api/users");
    expect(result[0].description).toBe("The endpoint has no auth check");
    expect(result[1].title).toBe("SQL injection in search");
    expect(result[2].title).toBe("XSS in profile name");
  });

  it("extracts findings from numbered list in ### Findings section", () => {
    const description = [
      "Audit summary",
      "",
      "### Findings",
      "1. First finding here",
      "2. Second finding here",
      "3. Third finding here",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("First finding here");
    expect(result[1].title).toBe("Second finding here");
    expect(result[2].title).toBe("Third finding here");
  });

  it("extracts findings from JSON code block", () => {
    const description = [
      "Audit report",
      "",
      "```json",
      JSON.stringify([
        { title: "Finding A", description: "Desc A" },
        { title: "Finding B", description: "Desc B" },
      ]),
      "```",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Finding A");
    expect(result[0].description).toBe("Desc A");
    expect(result[1].title).toBe("Finding B");
  });

  it("extracts findings from JSON code block with string array", () => {
    const description = [
      "```json",
      JSON.stringify(["Finding X", "Finding Y", "Finding Z"]),
      "```",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("Finding X");
    expect(result[1].title).toBe("Finding Y");
    expect(result[2].title).toBe("Finding Z");
  });

  it("extracts findings from inline HTML comments", () => {
    const description = [
      "Some text",
      "<!-- finding: First finding -->",
      "More text",
      "<!-- finding: Second finding -->",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("First finding");
    expect(result[1].title).toBe("Second finding");
  });

  it("returns fallback when no structured findings found", () => {
    const description = "Just a regular description with no findings.";
    const result = extractFindings(description, "Fallback Title");
    expect(result).toEqual([{ title: "Fallback Title" }]);
  });

  it("handles mixed bullet formats in findings section", () => {
    const description = [
      "## Findings",
      "- **Bold Title**: with description",
      "- Regular bullet item",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Bold Title");
    expect(result[1].title).toBe("Regular bullet item");
  });

  it("handles invalid JSON gracefully", () => {
    const description = [
      "```json",
      "not valid json",
      "```",
    ].join("\n");

    const result = extractFindings(description, "Fallback");
    expect(result).toEqual([{ title: "Fallback" }]);
  });
});

// ── shouldTriggerFanout ────────────────────────────────────────────────────

describe("shouldTriggerFanout (AI-1992: config-driven)", () => {
  // A ux-audit-shaped def: spawning declares a fanout block; auditing/managing do not.
  const uxAuditDef = {
    id: "ux-audit",
    break_glass: { command: "escape", to: "escape" },
    states: [
      { id: "auditing", transitions: [{ command: "complete-audit", to: "spawning" }] },
      { id: "spawning", fanout: { spec_source: "findings", child_workflow: "wf:dev-impl" }, transitions: [{ command: "spawn", to: "managing" }] },
      { id: "managing", barrier: true, transitions: [{ command: "complete", to: "review" }] },
    ],
  } as unknown as WorkflowDef;
  // A dev-impl-shaped def: no fanout blocks anywhere.
  const devImplDef = {
    id: "dev-impl",
    break_glass: { command: "escape", to: "escape" },
    states: [
      { id: "spawning", transitions: [{ command: "spawn", to: "managing" }] },
      { id: "implementation", transitions: [{ command: "submit", to: "code-review" }] },
    ],
  } as unknown as WorkflowDef;

  it("returns the fanout config for a state that declares a fanout block on its command", () => {
    expect(shouldTriggerFanout(uxAuditDef, "spawning", "spawn")).toBeTruthy();
  });

  it("returns falsy for a def whose state has no fanout block", () => {
    expect(shouldTriggerFanout(devImplDef, "spawning", "spawn")).toBeFalsy();
  });

  it("returns falsy for a state with no fanout block", () => {
    expect(shouldTriggerFanout(uxAuditDef, "auditing", "spawn")).toBeFalsy();
  });

  it("returns falsy for a command that is not the fanout state's forward transition", () => {
    expect(shouldTriggerFanout(uxAuditDef, "spawning", "complete-audit")).toBeFalsy();
  });

  it("returns falsy for all wrong", () => {
    expect(shouldTriggerFanout(devImplDef, "implementation", "submit")).toBeFalsy();
  });
});

// ── executeFanout with mocked Linear API ──────────────────────────────────

describe("executeFanout — mocked Linear API", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build a mock fetch that handles the fan-out API calls. */
  function makeFanoutFetch(opts: {
    /** Parent issue context (team, title, description). */
    parentContext?: {
      teamId: string;
      title: string;
      description: string | null;
      parentIssueId: string | null;
    };
    /** Existing team labels. */
    teamLabels?: Array<{ id: string; name: string }>;
    /** Internal UUID for the parent issue. */
    parentInternalId?: string;
    /** Number of successful child creations before failure. -1 = all succeed. */
    successCount?: number;
  }): typeof globalThis.fetch {
    const teamId = opts.parentContext?.teamId ?? "team-uuid";
    const parentInternalId = opts.parentInternalId ?? "parent-internal-uuid";
    const successCount = opts.successCount ?? -1;
    let createdCount = 0;

    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url, body: parsed });

      const query = parsed.query ?? "";

      // Resolve internal UUID + team/parent context
      if (query.includes("IssueTeamParent")) {
        const ctx = opts.parentContext ?? {
          teamId: "team-uuid",
          title: "UX Audit Parent",
          description: null,
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

      // Resolve internal ID for parent
      if (query.includes("issue(id: $id) { id }") && !query.includes("team") && !query.includes("parent") && !query.includes("labels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: parentInternalId } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team labels lookup
      if (query.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({
            data: { team: { labels: { nodes: opts.teamLabels ?? [] } } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Label creation
      if (query.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({
            data: {
              issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Child issue creation
      if (query.includes("issueCreate")) {
        createdCount++;
        if (successCount >= 0 && createdCount > successCount) {
          // Simulate failure
          return new Response(
            JSON.stringify({ data: { issueCreate: { success: false, issue: null } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const input = (parsed.variables as Record<string, unknown>).input as Record<string, unknown>;
        const title = input.title as string;
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

      // Comment creation (fan-out summary)
      if (query.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    };
  }

  it("creates one child per finding with findings override", async () => {
    const findings: Finding[] = [
      { title: "Auth bypass on /api/users" },
      { title: "SQL injection in search" },
      { title: "XSS in profile name" },
    ];

    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(3);
    expect(result.childIdentifiers).toEqual(["AI-2001", "AI-2002", "AI-2003"]);
    expect(result.errors).toHaveLength(0);
    expect(result.refused).toBe(false);
    expect(result.pendingApproval).toBe(false);

    // Verify child issue creation calls
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(3);

    // Verify each child has wf:dev-impl and state:intake labels
    for (const call of createCalls) {
      const input = ((call.body.variables as Record<string, unknown>).input as Record<string, unknown>);
      expect(input.labelIds).toContain("existing-wf-dev-impl");
      expect(input.labelIds).toContain("existing-state-intake");
      // AC2: each child is linked to the parent (parentId set)
      expect(input.parentId).toBe("parent-internal-uuid");
    }
  });

  it("extracts findings from description when no override provided", async () => {
    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
      parentContext: {
        teamId: "team-uuid",
        title: "UX Audit",
        description: "## Findings\n- **Finding A**: Description A\n- **Finding B**: Description B\n",
        parentIssueId: null,
      },
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true });

    expect(result.created).toBe(2);
    expect(result.childIdentifiers).toHaveLength(2);
  });

  it("AI-1992 (AC5): refuses — no children — when the description has no parseable spec", async () => {
    globalThis.fetch = makeFanoutFetch({
      parentContext: {
        teamId: "team-uuid",
        title: "UX Audit Report",
        description: "Just a regular description.",
        parentIssueId: null,
      },
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true });

    // AI-1992: the strict config-driven extractor has NO title fallback — an
    // empty/unparseable spec refuses rather than spawning a guessed child.
    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toHaveLength(0);
    expect(result.refused).toBe(true);
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("uses existing team labels when available", async () => {
    const findings: Finding[] = [{ title: "Test finding" }];
    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-label", name: "wf:dev-impl" },
        { id: "existing-state-label", name: "state:intake" },
      ],
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(1);
    // Should NOT have created new labels (teamLabels already has them)
    const createLabelCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueLabelCreate"));
    expect(createLabelCalls).toHaveLength(0);

    // Child should use existing label IDs
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    const input = ((createCalls[0].body.variables as Record<string, unknown>).input as Record<string, unknown>);
    expect(input.labelIds).toContain("existing-wf-label");
    expect(input.labelIds).toContain("existing-state-label");
  });

  it("returns errors when parent context fetch fails", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: [{ title: "Test" }] });

    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].findingIndex).toBe(-1);
    expect(result.errors[0].message).toContain("Failed to fetch parent issue context");
  });

  it("returns errors when labels cannot be resolved", async () => {
    // Make label creation fail by returning non-success
    const findings: Finding[] = [{ title: "Test finding" }];
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ data: { issue: { title: "Test", description: null, team: { id: "team-uuid" }, parent: null } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("records partial errors when some children fail", async () => {
    const findings: Finding[] = [
      { title: "Finding 1" },
      { title: "Finding 2" },
      { title: "Finding 3" },
    ];

    // Only first child succeeds
    globalThis.fetch = makeFanoutFetch({ successCount: 1, teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ] });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(1);
    expect(result.childIdentifiers).toEqual(["AI-2001"]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].findingIndex).toBe(1);
    expect(result.errors[1].findingIndex).toBe(2);
  });

  // AC4: A child may itself be an orchestrator — minting is uniform regardless (§5.4)
  it("creates children uniformly as dev-impl regardless of content (AC4: §5.4)", async () => {
    const findings: Finding[] = [
      { title: "Regular finding" },
      { title: "Orchestrator-type finding that might spawn its own children" },
    ];

    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(2);
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    // Both children get exactly the same labels — no special-casing
    for (const call of createCalls) {
      const input = ((call.body.variables as Record<string, unknown>).input as Record<string, unknown>);
      expect(input.labelIds).toEqual(["existing-wf-dev-impl", "existing-state-intake"]);
    }
  });

  // AC1: each child is at state:intake, wf:dev-impl
  it("AC1: each child is at state:intake with wf:dev-impl label", async () => {
    const findings: Finding[] = [
      { title: "Finding A" },
      { title: "Finding B" },
    ];

    globalThis.fetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(2);
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    for (const call of createCalls) {
      const input = ((call.body.variables as Record<string, unknown>).input as Record<string, unknown>);
      expect(input.labelIds).toContain("existing-wf-dev-impl");
      expect(input.labelIds).toContain("existing-state-intake");
      // Exactly 2 labels: wf:dev-impl and state:intake
      expect((input.labelIds as string[]).length).toBe(2);
    }
  });

  // AC2: each child is linked to the parent (parent/child relation set)
  it("AC2: each child has parentId set to the parent's internal UUID", async () => {
    const findings: Finding[] = [
      { title: "Finding A" },
      { title: "Finding B" },
    ];

    globalThis.fetch = makeFanoutFetch({ parentInternalId: "parent-uuid-123", teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ] });

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { skipPreview: true, findingsOverride: findings });

    expect(result.created).toBe(2);
    const createCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    for (const call of createCalls) {
      const input = ((call.body.variables as Record<string, unknown>).input as Record<string, unknown>);
      expect(input.parentId).toBe("parent-uuid-123");
    }
  });

  // ── Phase 6.5 / H-2: Spawn-preview gate integration ─────────────────────

  it("H-2 AC1: refuses fan-out when max_children exceeded (not truncated)", async () => {
    // Create more findings than default max_children (20)
    const findings: Finding[] = Array.from({ length: 25 }, (_, i) => ({
      title: `Finding ${i + 1}`,
    }));

    // Mock: parent has no parent (depth 0)
    const baseFetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      // Handle depth walk
      if (bodyText.includes("IssueParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // For commentCreate (preview comment)
      if (bodyText.includes("commentCreate") && !bodyText.includes("issueCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseFetch(url, init);
    };

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { findingsOverride: findings });

    expect(result.refused).toBe(true);
    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toHaveLength(0);
    expect(result.preview).not.toBeNull();
    expect(result.preview!.capResult.allowed).toBe(false);
    expect(result.errors[0].message).toContain("Child count cap exceeded");
  });

  it("H-2: sets pendingApproval when child count > approval_above", async () => {
    // 15 findings > default approval_above (10)
    const findings: Finding[] = Array.from({ length: 15 }, (_, i) => ({
      title: `Finding ${i + 1}`,
    }));

    const baseFetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      if (bodyText.includes("IssueParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (bodyText.includes("commentCreate") && !bodyText.includes("issueCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseFetch(url, init);
    };

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { findingsOverride: findings });

    expect(result.pendingApproval).toBe(true);
    expect(result.created).toBe(0); // No children created until approval
    expect(result.preview).not.toBeNull();
    expect(result.preview!.requiresApproval).toBe(true);
  });

  it("H-2 AC3: generates preview showing proposed children before instantiation", async () => {
    const findings: Finding[] = [
      { title: "Finding A", description: "Desc A" },
      { title: "Finding B" },
    ];

    const baseFetch = makeFanoutFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });
    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      if (bodyText.includes("IssueParent")) {
        // Don't record — just handle the depth walk
        return new Response(
          JSON.stringify({ data: { issue: { parent: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Delegate everything else (including commentCreate) to the base mock
      // which records into fetchCalls
      return baseFetch(url, init);
    };

    const result = await executeFanout("AI-1439", "Bearer tok", DEV_IMPL_FANOUT_CONFIG, { findingsOverride: findings });

    // Should have created children (within caps, no approval needed)
    expect(result.created).toBe(2);
    expect(result.preview).not.toBeNull();
    expect(result.preview!.childCount).toBe(2);
    expect(result.preview!.children[0].title).toBe("Finding A");
    expect(result.preview!.children[0].seedAc).toBe("Finding A: Desc A");
    expect(result.preview!.children[1].title).toBe("Finding B");
    expect(result.preview!.children[1].seedAc).toBe("Finding B");

    // Preview comment was posted
    const commentCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("commentCreate"));
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Integration: applyStateTransition triggers fan-out ─────────────────────

describe("applyStateTransition — fan-out integration (ux-audit spawn)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  let uxDir: string;
  let originalWorkflowDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    uxDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-integration-"));
    const policyFile = path.join(uxDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, UX_AUDIT_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // AI-2359: agents.json must include the policy bodies so singleton delegate
    // resolution (engine-1 for engine, maya for ux-researcher) does not fail-closed.
    const agentsFile = path.join(uxDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "engine-1", linearUserId: "engine-1-linear-uuid", clientId: "e-c", clientSecret: "e-s", accessToken: "e-t", refreshToken: "e-r" },
        { name: "maya", linearUserId: "maya-linear-uuid", clientId: "m-c", clientSecret: "m-s", accessToken: "m-t", refreshToken: "m-r" },
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-c", clientSecret: "c-s", accessToken: "c-t", refreshToken: "c-r" },
        { name: "hanzo", linearUserId: "hanzo-linear-uuid", clientId: "h-c", clientSecret: "h-s", accessToken: "h-t", refreshToken: "h-r" },
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    // INF-41: switch from WORKFLOW_DEF_PATH (single-file) to WORKFLOW_DEFS_DIR
    // so the registry includes both ux-audit AND dev-impl (the fanout config
    // default child_workflow is wf:dev-impl, which must be registered).
    fs.copyFileSync(CANONICAL_UX_AUDIT_FIXTURE, path.join(uxDir, "canonical-ux-audit.yaml"));
    fs.copyFileSync(
      path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml"),
      path.join(uxDir, "canonical-dev-impl.yaml"),
    );
    process.env.WORKFLOW_DEFS_DIR = uxDir;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  afterAll(() => {
    if (originalWorkflowDefsDir !== undefined) {
      process.env.WORKFLOW_DEFS_DIR = originalWorkflowDefsDir;
    } else {
      delete process.env.WORKFLOW_DEFS_DIR;
    }
    // Restore WORKFLOW_DEF_PATH to undefined (was not set before this test)
    delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) {
      process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    } else {
      delete process.env.CAPABILITY_POLICY_PATH;
    }
    if (originalAgentsFile !== undefined) {
      process.env.AGENTS_FILE = originalAgentsFile;
    } else {
      delete process.env.AGENTS_FILE;
    }
    reloadAgents();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Build a mock fetch that handles both the state transition (B2) and
   * the fan-out API calls (B-2) in sequence.
   */
  function makeIntegrationFetch(opts: {
    /** Labels on the parent issue. */
    parentLabels?: Array<{ id: string; name: string }>;
    /** Team labels. */
    teamLabels?: Array<{ id: string; name: string }>;
    /** Parent issue description. */
    parentDescription?: string;
    /** Parent issue title. */
    parentTitle?: string;
  }): typeof globalThis.fetch {
    const parentLabels = opts.parentLabels ?? [
      { id: "wf-lbl", name: "wf:ux-audit" },
      { id: "state-lbl", name: "state:spawning" },
    ];
    const teamLabels = opts.teamLabels ?? [];
    const parentTitle = opts.parentTitle ?? "UX Audit";
    const parentDescription = opts.parentDescription ?? "## Findings\n- **Finding A**: Desc A\n- **Finding B**: Desc B\n";
    let childCount = 0;

    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url, body: parsed });

      const query = parsed.query ?? "";

      // B2: fetch issue with labels
      if (query.includes("IssueWithLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-internal-id",
                team: { id: "team-uuid" },
                labels: { nodes: parentLabels },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // B2: team label lookup
      if (query.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: teamLabels } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // B2: label create
      if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({
            data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // AI-1498: native state resolution (resolveNativeStateId → TeamStates)
      if (query.includes("TeamStates")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                    { id: "state-doing-uuid", name: "Doing", type: "started" },
                    { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                    { id: "state-managing-uuid", name: "Managing", type: "started" },
                    { id: "state-done-uuid", name: "Done", type: "completed" },
                    { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // B2: state transition — single atomic writer (AI-1498)
      if (query.includes("ApplyAtomicTransition")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Spawn-preview: depth resolution (IssueParent from spawn-preview.ts)
      // The parent in integration tests is always a root issue (no parent)
      if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fan-out: fetch parent context (IssueTeamParent) — now also returns internal UUID
      if (query.includes("IssueTeamParent")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-internal-id",
                title: parentTitle,
                description: parentDescription,
                team: { id: "team-uuid" },
                parent: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fan-out: resolve parent internal ID
      if (query.includes("issue(id: $id) { id }") && !query.includes("team") && !query.includes("parent") && !query.includes("labels")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fan-out: create child issue
      if (query.includes("issueCreate")) {
        childCount++;
        const input = (parsed.variables as Record<string, unknown>).input as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: `child-${childCount}`, identifier: `AI-${3000 + childCount}` },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fan-out: summary comment
      if (query.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    };
  }

  // AC3: parent auto-transitions to managing once children are minted
  it("AC3: spawn on ux-audit spawning state triggers fan-out and transitions to managing", async () => {
    globalThis.fetch = makeIntegrationFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });

    await applyStateTransition("spawn", "AI-1439", "Bearer tok");

    // Should have made state transition (spawning → managing)
    const stateUpdateCall = fetchCalls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(stateUpdateCall).toBeDefined();

    // Should have triggered fan-out (child issue creation)
    const childCreateCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(childCreateCalls.length).toBeGreaterThanOrEqual(2); // At least 2 children from findings

    // Summary comment should have been posted with the internal UUID (not human-readable ID)
    const commentCall = fetchCalls.find((c) => (c.body.query ?? "").includes("commentCreate"));
    expect(commentCall).toBeDefined();
    const commentVars = commentCall!.body.variables as Record<string, unknown>;
    expect(commentVars.issueId).toBe("parent-internal-id");
  });

  it("does NOT trigger fan-out for non-ux-audit workflows", async () => {
    // Switch to dev-impl workflow def for this test
    const devImplFixture = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
    process.env.WORKFLOW_DEF_PATH = devImplFixture;
    resetWorkflowCache();

    globalThis.fetch = makeIntegrationFetch({
      parentLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:implementation" },
      ],
    });

    await applyStateTransition("submit", "AI-1439", "Bearer tok");

    // Restore ux-audit workflow def
    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT_FIXTURE;

    // Should have state transition but NO fan-out
    const stateUpdateCall = fetchCalls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(stateUpdateCall).toBeDefined();

    const childCreateCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(childCreateCalls).toHaveLength(0);
  });

  it("does NOT trigger fan-out for wrong command on ux-audit", async () => {
    globalThis.fetch = makeIntegrationFetch({
      parentLabels: [
        { id: "wf-lbl", name: "wf:ux-audit" },
        { id: "state-lbl", name: "state:auditing" },
      ],
    });

    await applyStateTransition("complete-audit", "AI-1439", "Bearer tok");

    // State transition should fire (auditing → spawning) but no fan-out
    const childCreateCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(childCreateCalls).toHaveLength(0);
  });

  it("fan-out still completes even if summary comment fails", async () => {
    let commentFailed = false;
    const baseFetch = makeIntegrationFetch({
      teamLabels: [
        { id: "existing-wf-dev-impl", name: "wf:dev-impl" },
        { id: "existing-state-intake", name: "state:intake" },
      ],
    });

    globalThis.fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      if (bodyText.includes("commentCreate") && !commentFailed) {
        commentFailed = true;
        // Don't record this call, just throw
        throw new Error("comment post failed");
      }
      return baseFetch(url, init);
    };

    // Should not throw — fan-out completes despite comment failure (AI-1809: transition reports applied)
    await expect(applyStateTransition("spawn", "AI-1439", "Bearer tok")).resolves.toMatchObject({ status: "applied" });

    // Children should still have been created
    const childCreateCalls = fetchCalls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(childCreateCalls.length).toBeGreaterThanOrEqual(2);
  });
});
