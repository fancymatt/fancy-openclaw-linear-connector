/**
 * INF-307: Failing tests for spawner guard against spec-hash titles.
 *
 * AC1 — Spawner guard against spec-hash titles:
 *   - Spawner refuses to create an issue whose title contains a dangling `-->`
 *     (spec-hash marker body), proven by a unit test that supplies such a
 *     title and asserts the create is rejected.
 *   - Spawner keeps spec-registry entries as internal HTML-comment markers
 *     inside the parent spec section — never mints them as standalone issues.
 *
 * Implementation will need to:
 *   1. Export a validation function `isSpecEntryMarkerTitle(title): boolean`
 *      from fanout.ts.
 *   2. Call it before minting children in executeFanout, recording an error
 *      (not crashing) for spec-entry titles.
 */

import { it, expect, describe, jest, beforeEach, afterEach } from "@jest/globals";
import { executeFanout, type FanoutResult, type Finding } from "./fanout.js";
import type { FanoutConfig } from "./workflow-gate.js";

// ── Config ────────────────────────────────────────────────────────────────

const DEV_IMPL_FANOUT: FanoutConfig = { spec_source: "findings", child_workflow: "wf:dev-impl" };

// ── Spec-hash titles matching the Cycle 4 leak pattern ────────────────────

const SPEC_HASH_TITLES = [
  "inf-131:spec-hash:f7d9e2c4 for structured (updated for Cycle 3) -->",
  "inf-131:spec-hash:4245a928 for sprint -->",
  "inf-131:spec-hash:1cdb2474 for structured -->",
];

// ── executeFanout assertion helper ────────────────────────────────────────

/**
 * Run executeFanout with one finding and the given title, then assert it was
 * REFUSED (created=0, refused or error recorded).
 */
async function assertTitleRejected(title: string): Promise<void> {
  // Mock the Linear API: if createChildIssue is called, it would succeed.
  // Our asserting expectation is that it is NEVER called for spec-hash titles.
  const createChildCalls: Array<Record<string, unknown>> = [];
  const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };

    if ((parsed.query ?? "").includes("issueCreate")) {
      createChildCalls.push(parsed);
    }

    // IssueTeamParent: return the parent context
    if ((parsed.query ?? "").includes("IssueTeamParent")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "parent-uuid",
              title: "Parent issue",
              description: null,
              team: { id: "team-uuid" },
              parent: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueParent: no parent (depth 0)
    if ((parsed.query ?? "").includes("IssueParent")) {
      return new Response(
        JSON.stringify({ data: { issue: { parent: null } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // TeamLabels lookup
    if ((parsed.query ?? "").includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
                  { id: "lbl-state-intake", name: "state:intake" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // issueLabelCreate: succeed
    if ((parsed.query ?? "").includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: { id: "lbl-new" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // commentCreate: succeed
    if ((parsed.query ?? "").includes("commentCreate")) {
      return new Response(
        JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Existing children fetch
    if ((parsed.query ?? "").includes("children") || (parsed.query ?? "").includes("existingSpawnChildren")) {
      return new Response(
        JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Default: empty response
    return new Response(
      JSON.stringify({ data: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

  try {
    const result = await executeFanout("AI-TEST", "Bearer test-token", DEV_IMPL_FANOUT, {
      skipPreview: true,
      findingsOverride: [{ title }],
    });

    // Expect a rejection: either refused=true or created=0
    // The spec-hash title must NOT result in a child being created.
    expect(result.created).toBe(0);
    expect(createChildCalls).toHaveLength(0);

    // Must record an error for the spec-entry title, not silently skip it
    expect(result.errors.length).toBeGreaterThan(0);
    const specEntryError = result.errors.find(
      (e) => e.message.toLowerCase().includes("spec") || e.message.toLowerCase().includes("-->"),
    );
    expect(specEntryError).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Run executeFanout with a clean title and assert it succeeds (creates child).
 */
async function assertCleanTitleAccepted(title: string): Promise<void> {
  let childCreated = false;
  const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };

    if ((parsed.query ?? "").includes("issueCreate")) {
      childCreated = true;
      return new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "child-uuid", identifier: "AI-9999" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if ((parsed.query ?? "").includes("IssueTeamParent")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "parent-uuid",
              title: "Parent issue",
              description: null,
              team: { id: "team-uuid" },
              parent: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if ((parsed.query ?? "").includes("IssueParent")) {
      return new Response(
        JSON.stringify({ data: { issue: { parent: null } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if ((parsed.query ?? "").includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: { team: { labels: { nodes: [
            { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
            { id: "lbl-state-intake", name: "state:intake" },
          ] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if ((parsed.query ?? "").includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "lbl-new" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if ((parsed.query ?? "").includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c-uuid" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if ((parsed.query ?? "").includes("children") || (parsed.query ?? "").includes("existingSpawnChildren")) {
      return new Response(
        JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

  try {
    const result = await executeFanout("AI-TEST", "Bearer test-token", DEV_IMPL_FANOUT, {
      skipPreview: true,
      findingsOverride: [{ title }],
    });

    // A clean title should result in a child being created
    expect(result.created).toBe(1);
    expect(childCreated).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AC1: Spawner guard against spec-hash titles", () => {
  it("rejects a finding whose title is a spec-hash marker with dangling --> (INF-301 pattern)", async () => {
    await assertTitleRejected(SPEC_HASH_TITLES[0]);
  });

  it("rejects a finding whose title is a sprint spec-hash marker with dangling --> (INF-302 pattern)", async () => {
    await assertTitleRejected(SPEC_HASH_TITLES[1]);
  });

  it("rejects a finding whose title is another spec-hash marker with dangling --> (INF-303 pattern)", async () => {
    await assertTitleRejected(SPEC_HASH_TITLES[2]);
  });

  it("accepts a valid finding title (no spec-hash marker)", async () => {
    await assertCleanTitleAccepted("Missing auth on /api/users");
  });

  it("accepts a finding title that only contains a substring like 'hash' but no -->", async () => {
    await assertCleanTitleAccepted("Hash function collision in password storage");
  });

  it("rejects all spec-hash titles while still minting valid titles in the same fan-out", async () => {
    // Mixed: one valid finding + one spec-hash finding
    const validFinding: Finding = { title: "SQL injection in search" };
    const specHashFinding: Finding = { title: "inf-131:spec-hash:f7d9e2c4 for structured -->" };

    let childCreateCount = 0;
    const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };

      if ((parsed.query ?? "").includes("issueCreate")) {
        childCreateCount++;
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: `child-uuid-${childCreateCount}`, identifier: `AI-${9900 + childCreateCount}` },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("IssueTeamParent")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-uuid",
                title: "Parent",
                description: null,
                team: { id: "team-uuid" },
                parent: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("IssueParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [
            { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
            { id: "lbl-state-intake", name: "state:intake" },
          ] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c-uuid" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("children") || (parsed.query ?? "").includes("existingSpawnChildren")) {
        return new Response(
          JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    try {
      const result = await executeFanout("AI-TEST", "Bearer test-token", DEV_IMPL_FANOUT, {
        skipPreview: true,
        findingsOverride: [validFinding, specHashFinding],
      });

      // Only the valid finding should result in a child
      expect(result.created).toBe(1);
      expect(childCreateCount).toBe(1);
      // The spec-hash error should be recorded
      const specEntryError = result.errors.find(
        (e) => e.findingIndex === 1 && (e.message.toLowerCase().includes("spec") || e.message.includes("-->")),
      );
      expect(specEntryError).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
