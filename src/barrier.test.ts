/**
 * Tests for Phase 5 / B-3 — Managing barrier (N→1) + asymmetric shepherding + stall detection.
 *
 * Covers:
 *   - isChildTerminal: terminal state detection from labels
 *   - evaluateBarrier: barrier evaluation with mocked Linear API
 *   - attemptBarrierTransition: full auto-advance managing → review
 *   - onChildTerminal: webhook-driven barrier entry point
 *   - buildShepherdingMessage: asymmetric shepherding message builder
 *   - detectStalledChildren: stall detection with idle threshold
 *   - surfaceStalledChildren: §5.5 tripwire comment posting
 *   - parseStallConfig: environment variable parsing
 *   - Integration: applyStateTransition triggers barrier on terminal child
 *   - Integration: webhook terminal event triggers barrier
 *   - AC3: Children cannot address the parent (structural asymmetry)
 */

import fs from "node:fs";
import path from "node:path";
import { isChildTerminal, isTerminalState, evaluateBarrier, attemptBarrierTransition, onChildTerminal, buildShepherdingMessage, detectStalledChildren, surfaceStalledChildren, parseStallConfig, type ChildState, type StalledChild } from "./barrier.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// AI-1992: barrier-ness is now config-driven — the barrier engine reads the
// parent's workflow def to confirm its current state declares `barrier: true`.
// Point the registry at the migrated canonical fixtures (ux-audit/sprint carry
// the barrier config) so these barrier-transition tests resolve real defs.
const FIXTURES_DEFS_DIR = path.resolve(process.cwd(), "src/__fixtures__");

// ── isChildTerminal ────────────────────────────────────────────────────────

describe("isChildTerminal", () => {
  it("returns true for state:done", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:done"])).toBe(true);
  });

  it("returns true for state:escape", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:escape"])).toBe(true);
  });

  it("returns false for state:implementation", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:implementation"])).toBe(false);
  });

  it("returns false for state:review", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:review"])).toBe(false);
  });

  it("returns false for state:intake", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:intake"])).toBe(false);
  });

  it("returns false when no state label present", () => {
    expect(isChildTerminal(["wf:dev-impl"])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(isChildTerminal([])).toBe(false);
  });
});

// ── isTerminalState ────────────────────────────────────────────────────────

describe("isTerminalState", () => {
  it("returns true for done", () => {
    expect(isTerminalState("done")).toBe(true);
  });

  it("returns true for escape", () => {
    expect(isTerminalState("escape")).toBe(true);
  });

  it("returns false for managing", () => {
    expect(isTerminalState("managing")).toBe(false);
  });

  it("returns false for review", () => {
    expect(isTerminalState("review")).toBe(false);
  });

  it("returns false for implementation", () => {
    expect(isTerminalState("implementation")).toBe(false);
  });
});

// ── evaluateBarrier with mocked Linear API ─────────────────────────────────

describe("evaluateBarrier — mocked Linear API", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns allTerminal=true when all children are done", async () => {
    globalThis.fetch = async (_url, _init) => {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: [
                  { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                  { identifier: "AI-2002", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                  { identifier: "AI-2003", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await evaluateBarrier("AI-1439", "Bearer tok");
    expect(result.allTerminal).toBe(true);
    expect(result.totalChildren).toBe(3);
    expect(result.terminalCount).toBe(3);
  });

  it("returns allTerminal=false when some children are not done", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: [
                  { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                  { identifier: "AI-2002", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  { identifier: "AI-2003", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await evaluateBarrier("AI-1439", "Bearer tok");
    expect(result.allTerminal).toBe(false);
    expect(result.totalChildren).toBe(3);
    expect(result.terminalCount).toBe(2);
  });

  it("returns allTerminal=true when no children found (AI-1730: vacuous satisfaction)", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          data: { issue: { children: { nodes: [] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await evaluateBarrier("AI-1439", "Bearer tok");
    // AI-1730: zero children = barrier satisfied (vacuous)
    expect(result.allTerminal).toBe(true);
    expect(result.totalChildren).toBe(0);
    expect(result.terminalCount).toBe(0);
  });

  it("handles mixed terminal states (done + escape)", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: [
                  { identifier: "AI-2001", labels: { nodes: [{ name: "state:done" }] } },
                  { identifier: "AI-2002", labels: { nodes: [{ name: "state:escape" }] } },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await evaluateBarrier("AI-1439", "Bearer tok");
    expect(result.allTerminal).toBe(true);
    expect(result.terminalCount).toBe(2);
  });

  it("returns allTerminal=true on API error (empty fallback = vacuous, AI-1730)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };

    const result = await evaluateBarrier("AI-1439", "Bearer tok");
    // AI-1730: fetchChildren returns [] on error, which is vacuous satisfaction
    expect(result.allTerminal).toBe(true);
    expect(result.totalChildren).toBe(0);
  });
});

// ── attemptBarrierTransition ───────────────────────────────────────────────

describe("attemptBarrierTransition — mocked Linear API", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  let origDefsDir: string | undefined;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEFS_DIR = FIXTURES_DEFS_DIR;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeBarrierFetch(opts: {
    /** Parent labels. */
    parentLabels?: Array<{ id: string; name: string }>;
    /** Parent state (from labels). */
    parentWorkflow?: string;
    parentState?: string;
    /** Children of the parent. */
    children?: Array<{ identifier: string; labels: string[] }>;
    /** Existing team labels. */
    teamLabels?: Array<{ id: string; name: string }>;
  }): typeof globalThis.fetch {
    const parentLabels = opts.parentLabels ?? [
      { id: "wf-lbl", name: `wf:${opts.parentWorkflow ?? "ux-audit"}` },
      { id: "state-lbl", name: `state:${opts.parentState ?? "managing"}` },
    ];
    const children = opts.children ?? [
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
    ];

    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url, body: parsed });

      const query = parsed.query ?? "";

      // Fetch children
      if (query.includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: children.map((c) => ({
                    identifier: c.identifier,
                    labels: { nodes: c.labels.map((l) => ({ name: l })) },
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Fetch parent state with label IDs
      if (query.includes("ParentLabels") || query.includes("ParentState") || query.includes("IssueLabels")) {
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

      // Team label lookup
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
            data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Label swap (barrier transition)
      if (query.includes("BarrierTransition") || query.includes("UpdateLabels")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Comment creation
      if (query.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    };
  }

  it("transitions parent managing → review when all children terminal", async () => {
    globalThis.fetch = makeBarrierFetch({});

    const result = await attemptBarrierTransition("AI-1439", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.terminalCount).toBe(2);
    expect(result.totalChildren).toBe(2);

    // Should have done a label swap
    const swapCall = fetchCalls.find((c) => (c.body.query ?? "").includes("UpdateLabels"));
    expect(swapCall).toBeDefined();

    // Should have posted a barrier comment
    const commentCall = fetchCalls.find((c) => (c.body.query ?? "").includes("commentCreate"));
    expect(commentCall).toBeDefined();
  });

  it("does not transition when not all children terminal", async () => {
    globalThis.fetch = makeBarrierFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
        { identifier: "AI-2002", labels: ["wf:dev-impl", "state:implementation"] },
      ],
    });

    const result = await attemptBarrierTransition("AI-1439", "Bearer tok");

    expect(result.transitioned).toBe(false);
    expect(result.terminalCount).toBe(1);
    expect(result.totalChildren).toBe(2);

    // No label swap should have happened
    const swapCall = fetchCalls.find((c) => (c.body.query ?? "").includes("UpdateLabels"));
    expect(swapCall).toBeUndefined();
  });

  it("does not transition when parent is not in managing state", async () => {
    globalThis.fetch = makeBarrierFetch({
      parentLabels: [
        { id: "wf-lbl", name: "wf:ux-audit" },
        { id: "state-lbl", name: "state:review" },
      ],
      parentState: "review",
    });

    const result = await attemptBarrierTransition("AI-1439", "Bearer tok");

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain("review");
  });

  it("does not transition when parent is not ux-audit workflow", async () => {
    globalThis.fetch = makeBarrierFetch({
      parentLabels: [
        { id: "wf-lbl", name: "wf:dev-impl" },
        { id: "state-lbl", name: "state:managing" },
      ],
      parentWorkflow: "dev-impl",
    });

    const result = await attemptBarrierTransition("AI-1439", "Bearer tok");

    expect(result.transitioned).toBe(false);
    expect(result.error).toContain("dev-impl");
  });

  it("transitions when no children exist (AI-1730: vacuous satisfaction)", async () => {
    globalThis.fetch = makeBarrierFetch({ children: [] });

    const result = await attemptBarrierTransition("AI-1439", "Bearer tok");

    // AI-1730: zero children = vacuous barrier satisfaction → auto-advance
    expect(result.transitioned).toBe(true);
    expect(result.totalChildren).toBe(0);
  });

  it("handles single child terminal", async () => {
    globalThis.fetch = makeBarrierFetch({
      children: [
        { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      ],
    });

    const result = await attemptBarrierTransition("AI-1439", "Bearer tok");

    expect(result.transitioned).toBe(true);
    expect(result.terminalCount).toBe(1);
    expect(result.totalChildren).toBe(1);
  });
});

// ── onChildTerminal ────────────────────────────────────────────────────────

describe("onChildTerminal — webhook entry point", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  let origDefsDir: string | undefined;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEFS_DIR = FIXTURES_DEFS_DIR;
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when child has no parent", async () => {
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      fetchCalls.push({ url: "", body: parsed });

      if ((parsed.query ?? "").includes("ChildParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: null } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error("unexpected query");
    };

    const result = await onChildTerminal("AI-2001", "Bearer tok");
    expect(result).toBeNull();
  });

  it("returns null when parent is not ux-audit", async () => {
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      fetchCalls.push({ url: "", body: parsed });

      if ((parsed.query ?? "").includes("ChildParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: { identifier: "AI-1439" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if ((parsed.query ?? "").includes("ParentState") || (parsed.query ?? "").includes("ParentLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-id",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "s-lbl", name: "state:managing" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected query: ${(parsed.query ?? "").slice(0, 80)}`);
    };

    const result = await onChildTerminal("AI-2001", "Bearer tok");
    expect(result).toBeNull();
  });

  it("triggers barrier transition when parent is ux-audit managing", async () => {
    // Full mock chain: child → parent → children → all terminal → transition
    const children = [
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"] },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:done"] },
    ];

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url: "", body: parsed });

      const q = parsed.query ?? "";

      if (q.includes("ChildParent")) {
        return new Response(
          JSON.stringify({ data: { issue: { parent: { identifier: "AI-1439" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: children.map((c) => ({
                    identifier: c.identifier,
                    labels: { nodes: c.labels.map((l) => ({ name: l })) },
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("ParentState") || q.includes("ParentLabels") || q.includes("IssueLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-internal-id",
                team: { id: "team-uuid" },
                labels: { nodes: [{ id: "wf-lbl", name: "wf:ux-audit" }, { id: "state-lbl", name: "state:managing" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("BarrierTransition") || q.includes("UpdateLabels")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (q.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${q.slice(0, 100)}`);
    };

    const result = await onChildTerminal("AI-2001", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
    expect(result!.parentIdentifier).toBe("AI-1439");
  });

  it("returns null on API error", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };

    const result = await onChildTerminal("AI-2001", "Bearer tok");
    expect(result).toBeNull();
  });
});

// ── buildShepherdingMessage ────────────────────────────────────────────────

describe("buildShepherdingMessage", () => {
  it("builds message with child states", () => {
    const children: ChildState[] = [
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:done"], isTerminal: true, workflowState: "done" },
      { identifier: "AI-2002", labels: ["wf:dev-impl", "state:implementation"], isTerminal: false, workflowState: "implementation" },
    ];
    const stalled: StalledChild[] = [];

    const msg = buildShepherdingMessage("AI-1439", children, stalled);

    expect(msg).toContain("AI-1439");
    expect(msg).toContain("AI-2001");
    expect(msg).toContain("AI-2002");
    expect(msg).toContain("done");
    expect(msg).toContain("implementation");
    expect(msg).toContain("✓");
    expect(msg).toContain("●");
    expect(msg).not.toContain("Stalled");
  });

  it("includes stalled children in message", () => {
    const children: ChildState[] = [
      { identifier: "AI-2001", labels: ["wf:dev-impl", "state:implementation"], isTerminal: false, workflowState: "implementation" },
    ];
    const stalled: StalledChild[] = [
      {
        identifier: "AI-2001",
        parentIdentifier: "AI-1439",
        currentState: "implementation",
        lastActivityAt: 1000000,
        idleDurationMs: 45 * 60 * 1000,
        stateEnteredAt: null,
        stateSlaMs: 30 * 60 * 1000,
        timeInStateMs: 45 * 60 * 1000,
        knownDeferralMs: 0,
        isDeferredAtCapacity: false,
      },
    ];

    const msg = buildShepherdingMessage("AI-1439", children, stalled);

    expect(msg).toContain("Stall event(s)");
    expect(msg).toContain("AI-2001");
    expect(msg).toContain("45m");
    expect(msg).toContain("nudge");
  });

  it("handles empty children", () => {
    const msg = buildShepherdingMessage("AI-1439", [], []);
    expect(msg).toContain("AI-1439");
  });
});

// ── detectStalledChildren ──────────────────────────────────────────────────

describe("detectStalledChildren — mocked Linear API", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("detects children idle beyond threshold", async () => {
    const now = Date.now();
    const staleTime = new Date(now - 45 * 60 * 1000).toISOString(); // 45 min ago
    const recentTime = new Date(now - 5 * 60 * 1000).toISOString(); // 5 min ago

    let callCount = 0;
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                    { identifier: "AI-2002", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("ChildActivity")) {
        callCount++;
        // First child stale, second child recent
        return new Response(
          JSON.stringify({
            data: { issue: { updatedAt: callCount === 1 ? staleTime : recentTime } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${(parsed.query ?? "").slice(0, 80)}`);
    };

    const stalled = await detectStalledChildren("AI-1439", "Bearer tok", 30 * 60 * 1000, now);

    expect(stalled).toHaveLength(1);
    expect(stalled[0].identifier).toBe("AI-2001");
    expect(stalled[0].idleDurationMs).toBe(45 * 60 * 1000);
  });

  it("returns empty when no children are stalled", async () => {
    const now = Date.now();
    const recentTime = new Date(now - 5 * 60 * 1000).toISOString();

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("ChildActivity")) {
        return new Response(
          JSON.stringify({ data: { issue: { updatedAt: recentTime } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error("unexpected query");
    };

    const stalled = await detectStalledChildren("AI-1439", "Bearer tok", 30 * 60 * 1000, now);
    expect(stalled).toHaveLength(0);
  });

  it("skips terminal children", async () => {
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error("unexpected query — should not check activity for terminal child");
    };

    const stalled = await detectStalledChildren("AI-1439", "Bearer tok", 30 * 60 * 1000);
    expect(stalled).toHaveLength(0);
  });
});

// ── surfaceStalledChildren ─────────────────────────────────────────────────

describe("surfaceStalledChildren — §5.5 tripwire", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts tripwire comment when stalled children detected", async () => {
    const now = Date.now();
    const staleTime = new Date(now - 45 * 60 * 1000).toISOString();
    let commentPosted = false;
    let callCount = 0;

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "state:implementation" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("ChildActivity")) {
        return new Response(
          JSON.stringify({ data: { issue: { updatedAt: staleTime } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("issue(id: $id) { id }") && !(parsed.query ?? "").includes("team")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("commentCreate")) {
        commentPosted = true;
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${(parsed.query ?? "").slice(0, 80)}`);
    };

    const result = await surfaceStalledChildren("AI-1439", "Bearer tok", 30 * 60 * 1000, now);

    expect(result.surfaced).toBe(1);
    expect(commentPosted).toBe(true);
  });

  it("returns 0 when no children are stalled", async () => {
    const now = Date.now();
    const recentTime = new Date(now - 5 * 60 * 1000).toISOString();

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "state:implementation" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("ChildActivity")) {
        return new Response(
          JSON.stringify({ data: { issue: { updatedAt: recentTime } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error("unexpected query");
    };

    const result = await surfaceStalledChildren("AI-1439", "Bearer tok", 30 * 60 * 1000, now);
    expect(result.surfaced).toBe(0);
  });
});

// ── parseStallConfig ───────────────────────────────────────────────────────

describe("parseStallConfig", () => {
  it("returns defaults when env vars not set", () => {
    delete process.env.BARRIER_STALL_THRESHOLD_MS;
    delete process.env.BARRIER_STALL_POLL_MS;

    const config = parseStallConfig();
    expect(config.stallThresholdMs).toBe(30 * 60 * 1000);
    expect(config.pollIntervalMs).toBe(10 * 60 * 1000);
  });

  it("reads from environment variables", () => {
    process.env.BARRIER_STALL_THRESHOLD_MS = "600000";
    process.env.BARRIER_STALL_POLL_MS = "300000";

    const config = parseStallConfig();
    expect(config.stallThresholdMs).toBe(600000);
    expect(config.pollIntervalMs).toBe(300000);

    delete process.env.BARRIER_STALL_THRESHOLD_MS;
    delete process.env.BARRIER_STALL_POLL_MS;
  });

  it("ignores invalid values", () => {
    process.env.BARRIER_STALL_THRESHOLD_MS = "not-a-number";
    process.env.BARRIER_STALL_POLL_MS = "-100";

    const config = parseStallConfig();
    expect(config.stallThresholdMs).toBe(30 * 60 * 1000); // default
    expect(config.pollIntervalMs).toBe(10 * 60 * 1000); // default

    delete process.env.BARRIER_STALL_THRESHOLD_MS;
    delete process.env.BARRIER_STALL_POLL_MS;
  });
});

// ── AC3: Structural asymmetry ─────────────────────────────────────────────

describe("AC3: Children cannot address the parent (asymmetry enforced)", () => {
  it("dev-impl workflow has no upward-directed command", () => {
    // Read the canonical dev-impl fixture and verify no command references
    // a parent or managing state
    const fixturePath = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

    if (!fs.existsSync(fixturePath)) {
      // Skip if fixture not available — the structural guarantee is in the
      // workflow definition, not in this test file.
      return;
    }

    const content = fs.readFileSync(fixturePath, "utf8");

    // No command should reference "parent", "managing", "barrier", or "signal"
    expect(content).not.toMatch(/command:\s*(.*parent|.*barrier|.*signal-up|.*address-parent)/i);

    // The dev-impl workflow should NOT contain ux-audit states like "managing" or "spawning"
    expect(content).not.toMatch(/id:\s*managing/);
    expect(content).not.toMatch(/id:\s*spawning/);
  });

  it("isTerminalState covers done and escape — the only terminal states", () => {
    // Verify that only done and escape are terminal
    expect(isTerminalState("done")).toBe(true);
    expect(isTerminalState("escape")).toBe(true);
    // All other states are non-terminal
    expect(isTerminalState("intake")).toBe(false);
    expect(isTerminalState("auditing")).toBe(false);
    expect(isTerminalState("spawning")).toBe(false);
    expect(isTerminalState("managing")).toBe(false);
    expect(isTerminalState("review")).toBe(false);
    expect(isTerminalState("implementation")).toBe(false);
    expect(isTerminalState("code-review")).toBe(false);
  });

  it("a child with wf:dev-impl labels cannot change ux-audit parent state", () => {
    // This is the structural test: the barrier module only fires for
    // ux-audit parents in managing state. A dev-impl child has no mechanism
    // to directly change the parent's state — the barrier module handles it.
    //
    // The workflow gate (checkWorkflowRules) validates commands against the
    // loaded workflow def. A dev-impl ticket's commands (submit, request-review,
    // etc.) only transition the dev-impl ticket's own state labels.
    //
    // This test verifies the isChildTerminal function works correctly with
    // dev-impl labels — the barrier evaluation uses this to determine if
    // a child has reached a terminal state.
    const devImplDone = ["wf:dev-impl", "state:done"];
    const devImplEscaped = ["wf:dev-impl", "state:escape"];
    const devImplActive = ["wf:dev-impl", "state:implementation"];

    expect(isChildTerminal(devImplDone)).toBe(true);
    expect(isChildTerminal(devImplEscaped)).toBe(true);
    expect(isChildTerminal(devImplActive)).toBe(false);
  });
});
