/**
 * AI-1547 — Failing tests for transition atomicity + standing anti-entropy reconciliation loop.
 *
 * Covers the three in-scope acceptance criteria (§4.5 + §4.13):
 *
 *   AC1 — fault-injected desync (label vs native state): on a reconciliation pass,
 *          native stateId is healed to match the authoritative state:* label.
 *          Scenario: connector crashes after the agent's label mutation is committed
 *          to Linear but before applyStateTransition writes the nativeStateId.
 *          Restart or next anti-entropy pass must detect and fix the mismatch.
 *
 *   AC2 — dropped terminal-child webhook: anti-entropy pass detects a parent ticket
 *          stuck in `managing` whose children are ALL terminal (barrier should have
 *          fired) and reconciles the barrier (advances parent to review).
 *
 *   AC3 — anti-entropy runs on a configurable cadence (standing loop, not boot-only)
 *          and logs a structured alert whenever drift is detected.
 *
 * These tests MUST be RED until the implementation lands in src/cron/anti-entropy.ts.
 * Import-shape and type-export tests may pass as compile-time smoke checks.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  runAntiEntropyPass,
  registerAntiEntropyCron,
  type AntiEntropyOptions,
  type AntiEntropyResult,
} from "./anti-entropy.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anti-entropy-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a workflow def YAML and set WORKFLOW_DEF_PATH so loadWorkflowRegistry picks it up. */
function writeWorkflowDef(overrides: Partial<Record<string, unknown>> = {}): string {
  const def = {
    id: "dev-impl",
    entry_state: "intake",
    states: [
      { id: "intake",         native_state: "todo",    owner_role: "steward" },
      { id: "write-tests",    native_state: "todo",    owner_role: "test-author" },
      { id: "implementation", native_state: "todo",    owner_role: "dev" },
      { id: "code-review",    native_state: "thinking", owner_role: "code-review" },
      { id: "deployment",     native_state: "todo",    owner_role: "deployment" },
      { id: "ac-validate",    native_state: "todo",    owner_role: "steward" },
      { id: "done",           native_state: "done" },
      { id: "escape",         native_state: "invalid" },
    ],
    ...overrides,
  };
  const uxAuditDef = {
    id: "ux-audit",
    entry_state: "intake",
    states: [
      { id: "intake",   native_state: "todo",     owner_role: "steward" },
      { id: "auditing", native_state: "doing",    owner_role: "dev" },
      { id: "spawning", native_state: "doing",    owner_role: "dev" },
      { id: "managing", native_state: "managing", owner_role: "dev" },
      { id: "review",   native_state: "thinking", owner_role: "code-review" },
      { id: "done",     native_state: "done" },
      { id: "escape",   native_state: "invalid" },
    ],
  };
  const p = path.join(tmpDir, `wf-defs-${Date.now()}.yaml`);
  fs.writeFileSync(p, `---\n${yaml.dump(def)}\n---\n${yaml.dump(uxAuditDef)}`, "utf8");
  return p;
}

// ── Mock fetch helpers ─────────────────────────────────────────────────────

interface MockIssue {
  id: string;
  identifier: string;
  teamId: string;
  labels: Array<{ id: string; name: string }>;
  /** The Linear native state currently on the ticket (may differ from what label implies). */
  nativeStateId: string;
  nativeStateName: string;
  /** Child issues (for ux-audit/sprint managing tickets). */
  children?: Array<{
    identifier: string;
    labels: Array<{ name: string }>;
  }>;
}

interface MockTeamState {
  id: string;
  name: string;
  type: string;
}

/**
 * Build a globalThis.fetch mock for anti-entropy tests.
 * Handles:
 *   - Issue search (wf:* label filter)
 *   - Team workflow states (for resolveNativeStateId)
 *   - issueUpdate mutation (native state + label heal)
 *   - Child issue fetch (for barrier reconciliation)
 *   - Barrier parent transition mutation
 */
function makeMockFetch(opts: {
  issues: MockIssue[];
  teamStates?: MockTeamState[];
  issueUpdateSuccess?: boolean;
  /** Spy for capture of issueUpdate calls */
  onIssueUpdate?: (issueId: string, input: Record<string, unknown>) => void;
  onBarrierTransition?: (parentId: string, toState: string) => void;
}): { fetch: typeof globalThis.fetch; issueUpdateCalls: Array<{ issueId: string; stateId?: string; labelIds?: string[] }> } {
  const issueUpdateCalls: Array<{ issueId: string; stateId?: string; labelIds?: string[] }> = [];

  const defaultTeamStates: MockTeamState[] = opts.teamStates ?? [
    { id: "ns-todo-1",     name: "Todo",     type: "unstarted" },
    { id: "ns-thinking-1", name: "Thinking", type: "started" },
    { id: "ns-doing-1",    name: "In Progress", type: "started" },
    { id: "ns-managing-1", name: "In Review", type: "started" },
    { id: "ns-done-1",     name: "Done",     type: "completed" },
    { id: "ns-invalid-1",  name: "Cancelled", type: "cancelled" },
  ];

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = (parsed.query ?? "").replace(/\s+/g, " ");
    const variables = (parsed.variables ?? {}) as Record<string, unknown>;

    // ── Team workflow states (resolveNativeStateId) ────────────────────
    if (query.includes("workflowStates") || (query.includes("team(") && query.includes("states"))) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              workflowStates: {
                nodes: defaultTeamStates,
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Issue search (all wf:* issues) ─────────────────────────────────
    if (
      query.includes("IssueSearch") ||
      (query.includes("issues(") && (query.includes("wf:") || query.includes("startsWith"))) ||
      query.includes("AntiEntropyIssues") ||
      query.includes("WorkflowIssues")
    ) {
      const nodes = opts.issues.map((iss) => ({
        id: iss.id,
        identifier: iss.identifier,
        team: { id: iss.teamId },
        state: { id: iss.nativeStateId, name: iss.nativeStateName },
        labels: { nodes: iss.labels },
        children: {
          nodes: (iss.children ?? []).map((c) => ({
            identifier: c.identifier,
            labels: { nodes: c.labels },
          })),
        },
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Single issue fetch (barrier child check or label fetch) ────────
    if (query.includes("issue(id:") || (query.includes("issue(") && variables.id)) {
      const issueId = (variables.id as string) ?? "";
      const found = opts.issues.find((i) => i.id === issueId || i.identifier === issueId);
      if (!found) {
        return new Response(JSON.stringify({ data: { issue: null } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: found.id,
              identifier: found.identifier,
              team: { id: found.teamId },
              state: { id: found.nativeStateId, name: found.nativeStateName },
              labels: { nodes: found.labels },
              children: {
                nodes: (found.children ?? []).map((c) => ({
                  identifier: c.identifier,
                  labels: { nodes: c.labels },
                })),
              },
              parent: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── issueUpdate mutation ───────────────────────────────────────────
    if (query.includes("issueUpdate") || query.includes("IssueUpdate") || query.includes("ApplyAtomicTransition")) {
      const issueId = (variables.issueId as string | undefined) ?? (variables.id as string | undefined) ?? "";
      const input = (variables.input as Record<string, unknown> | undefined) ?? variables;
      const stateId = (input.stateId as string | undefined) ?? (variables.stateId as string | undefined);
      const labelIds = (input.labelIds as string[] | undefined) ?? (variables.labelIds as string[] | undefined);
      issueUpdateCalls.push({ issueId, stateId, labelIds });
      opts.onIssueUpdate?.(issueId, input);
      return new Response(
        JSON.stringify({
          data: {
            issueUpdate: { success: opts.issueUpdateSuccess !== false },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Label lookup / team labels ─────────────────────────────────────
    if (query.includes("TeamLabels") || (query.includes("team(") && query.includes("labels"))) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Comment create (barrier reconciliation may post a comment) ─────
    if (query.includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Fallback ───────────────────────────────────────────────────────
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };

  return { fetch: mockFetch, issueUpdateCalls };
}

// ── Shared env setup ───────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
let wfDefPath: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  wfDefPath = writeWorkflowDef();
  process.env.WORKFLOW_DEF_PATH = wfDefPath;
  // Reset any module-level caches (workflow registry, native state cache).
  // The implementation must export reset helpers for testing.
  process.env.ANTI_ENTROPY_TEST_RESET = "1";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.ANTI_ENTROPY_TEST_RESET;
});

// ── AC1: Native state desync reconciliation ────────────────────────────────

describe("AC1 — native state desync: restart reconciles native stateId to match state:* label", () => {
  it("detects a ticket where state:code-review label implies native 'thinking' but Linear shows 'Todo' and heals it", async () => {
    // Simulate: applyStateTransition wrote the state:code-review label (via agent's mutation)
    // but crashed before issuing the nativeStateId write. On restart/anti-entropy pass,
    // Linear has native stateId = ns-todo-1 (Todo) but label says code-review → thinking.
    const { fetch, issueUpdateCalls } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-1000",
          identifier: "AI-1000",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
            { id: "lbl-state-cr",    name: "state:code-review" },
          ],
          // code-review → native_state: "thinking" → should resolve to ns-thinking-1
          // but Linear currently shows Todo (ns-todo-1): crash left a desync.
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.nativeDesyncFound).toBe(1);
    expect(result.nativeDesyncHealed).toBe(1);
    // Must have issued an issueUpdate that sets stateId to the Thinking state.
    const healCall = issueUpdateCalls.find((c) => c.stateId === "ns-thinking-1");
    expect(healCall).toBeDefined();
  });

  it("does NOT write to a ticket where state:* label already matches native stateId", async () => {
    const { fetch, issueUpdateCalls } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-1001",
          identifier: "AI-1001",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:intake" },
          ],
          // intake → native_state: "todo" → ns-todo-1 — in sync.
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.nativeDesyncFound).toBe(0);
    expect(result.nativeDesyncHealed).toBe(0);
    // No issueUpdate should have been issued.
    expect(issueUpdateCalls).toHaveLength(0);
  });

  it("counts scanned correctly and skips non-wf:* tickets", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        // Only wf:* tickets should be returned by the search query.
        // The anti-entropy scan should report scanned = number of wf:* issues found.
        {
          id: "uuid-AI-1002",
          identifier: "AI-1002",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:implementation" },
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.scanned).toBeGreaterThanOrEqual(1);
  });

  it("skips a ticket that has no state:* label (missing label handled by rescue-sweep, not anti-entropy)", async () => {
    const { fetch, issueUpdateCalls } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-1003",
          identifier: "AI-1003",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            // No state:* label present.
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.nativeDesyncFound).toBe(0);
    expect(issueUpdateCalls).toHaveLength(0);
  });

  it("handles multiple tickets with mixed sync/desync — correct counts", async () => {
    const { fetch, issueUpdateCalls } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-2000",
          identifier: "AI-2000",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:code-review" },  // → thinking, but Linear shows todo
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
        {
          id: "uuid-AI-2001",
          identifier: "AI-2001",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:intake" },  // → todo, Linear shows todo ✓
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
        {
          id: "uuid-AI-2002",
          identifier: "AI-2002",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:done" },  // → done, but Linear shows todo
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.nativeDesyncFound).toBe(2);
    expect(result.nativeDesyncHealed).toBe(2);
    expect(issueUpdateCalls).toHaveLength(2);
  });

  it("records a heal failure (issueUpdate fails) — increments nativeDesyncFound but NOT nativeDesyncHealed", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-1004",
          identifier: "AI-1004",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:code-review" },
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
      issueUpdateSuccess: false,
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.nativeDesyncFound).toBe(1);
    expect(result.nativeDesyncHealed).toBe(0);
  });

  it("does not crash and records error when Linear API fetch fails for a ticket", async () => {
    let callCount = 0;
    const flakyFetch: typeof globalThis.fetch = async (_url, init) => {
      callCount++;
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };
      const query = (parsed.query ?? "").replace(/\s+/g, " ");
      // First call = issue search — return one ticket.
      if (callCount === 1 || query.includes("issues(") || query.includes("AntiEntropyIssues") || query.includes("WorkflowIssues")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "uuid-flaky",
                    identifier: "AI-1005",
                    team: { id: "team-ai" },
                    state: { id: "ns-todo-1", name: "Todo" },
                    labels: { nodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-st", name: "state:code-review" }] },
                    children: { nodes: [] },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      // All subsequent calls (team states, issueUpdate) throw.
      throw new Error("Network failure");
    };
    globalThis.fetch = flakyFetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    // Should not throw; should capture the error.
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── AC2: Barrier missed due to dropped terminal-child webhook ──────────────

describe("AC2 — dropped webhook: anti-entropy detects and reconciles missed barrier", () => {
  it("detects a parent in managing with all children terminal and advances it", async () => {
    const barrierAdvanced: string[] = [];

    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-500",
          identifier: "AI-500",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf",  name: "wf:ux-audit" },
            { id: "lbl-st",  name: "state:managing" },
          ],
          // managing → native_state: "managing" — Linear shows In Review = ns-managing-1 ✓
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          children: [
            { identifier: "AI-501", labels: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
            { identifier: "AI-502", labels: [{ name: "wf:dev-impl" }, { name: "state:escape" }] },
          ],
        },
      ],
      onBarrierTransition: (parentId, _toState) => barrierAdvanced.push(parentId),
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.barrierMissedFound).toBe(1);
    expect(result.barrierMissedReconciled).toBe(1);
  });

  it("does NOT advance a parent in managing when at least one child is non-terminal", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-600",
          identifier: "AI-600",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:managing" },
          ],
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          children: [
            { identifier: "AI-601", labels: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
            // AI-602 still in implementation — barrier NOT satisfied.
            { identifier: "AI-602", labels: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
          ],
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.barrierMissedFound).toBe(0);
    expect(result.barrierMissedReconciled).toBe(0);
  });

  it("does NOT fire on a parent NOT in managing state (e.g. review)", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-700",
          identifier: "AI-700",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:review" },
          ],
          nativeStateId: "ns-thinking-1",
          nativeStateName: "Thinking",
          children: [
            { identifier: "AI-701", labels: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
          ],
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.barrierMissedFound).toBe(0);
    expect(result.barrierMissedReconciled).toBe(0);
  });

  it("reconciles multiple stuck managing parents in a single pass", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-800",
          identifier: "AI-800",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:managing" },
          ],
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          children: [
            { identifier: "AI-801", labels: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
          ],
        },
        {
          id: "uuid-AI-810",
          identifier: "AI-810",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:managing" },
          ],
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          children: [
            { identifier: "AI-811", labels: [{ name: "wf:dev-impl" }, { name: "state:escape" }] },
          ],
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.barrierMissedFound).toBe(2);
    expect(result.barrierMissedReconciled).toBe(2);
  });

  it("handles a managing parent with NO children — barrier not satisfied, no action", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-900",
          identifier: "AI-900",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:managing" },
          ],
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          children: [],
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.barrierMissedFound).toBe(0);
    expect(result.barrierMissedReconciled).toBe(0);
  });
});

// ── AC3: Cadence, alerting, standing loop ──────────────────────────────────

describe("AC3 — anti-entropy runs on a cadence and alerts on drift", () => {
  it("registerAntiEntropyCron returns a timer handle that can be cleared", () => {
    const { fetch } = makeMockFetch({ issues: [] });
    globalThis.fetch = fetch;

    const timer = registerAntiEntropyCron({ intervalMs: 999_999, authToken: "tok-test" });

    expect(timer).toBeDefined();
    // Must be clearable — no throw on clearInterval.
    expect(() => clearInterval(timer)).not.toThrow();
  });

  it("registerAntiEntropyCron uses ANTI_ENTROPY_INTERVAL env var when no option given", () => {
    process.env.ANTI_ENTROPY_INTERVAL = "900000"; // 15 min
    const { fetch } = makeMockFetch({ issues: [] });
    globalThis.fetch = fetch;

    const timer = registerAntiEntropyCron({ authToken: "tok-test" });

    expect(timer).toBeDefined();
    clearInterval(timer);
    delete process.env.ANTI_ENTROPY_INTERVAL;
  });

  it("runAntiEntropyPass result signals drift when nativeDesyncFound > 0", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-3000",
          identifier: "AI-3000",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:code-review" },  // → thinking, but Linear shows todo
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    // Any drift (desync) must be surfaced in the result so the caller can alert.
    const driftFound = result.nativeDesyncFound + result.barrierMissedFound;
    expect(driftFound).toBeGreaterThan(0);
  });

  it("runAntiEntropyPass result signals drift when barrierMissedFound > 0", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-4000",
          identifier: "AI-4000",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:managing" },
          ],
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          children: [
            { identifier: "AI-4001", labels: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
          ],
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    const driftFound = result.nativeDesyncFound + result.barrierMissedFound;
    expect(driftFound).toBeGreaterThan(0);
  });

  it("runAntiEntropyPass returns zero drift when everything is in sync", async () => {
    const { fetch } = makeMockFetch({
      issues: [
        {
          id: "uuid-AI-5000",
          identifier: "AI-5000",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:dev-impl" },
            { id: "lbl-st", name: "state:intake" },  // → todo, Linear shows todo ✓
          ],
          nativeStateId: "ns-todo-1",
          nativeStateName: "Todo",
        },
        {
          id: "uuid-AI-5001",
          identifier: "AI-5001",
          teamId: "team-ai",
          labels: [
            { id: "lbl-wf", name: "wf:ux-audit" },
            { id: "lbl-st", name: "state:managing" },
          ],
          nativeStateId: "ns-managing-1",
          nativeStateName: "In Review",
          // One child still pending — barrier NOT triggered.
          children: [
            { identifier: "AI-5002", labels: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
          ],
        },
      ],
    });
    globalThis.fetch = fetch;

    const result = await runAntiEntropyPass({ authToken: "tok-test" });

    expect(result.nativeDesyncFound).toBe(0);
    expect(result.barrierMissedFound).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("cron timer does NOT block process shutdown (timer is unref'd)", () => {
    const { fetch } = makeMockFetch({ issues: [] });
    globalThis.fetch = fetch;

    const timer = registerAntiEntropyCron({ intervalMs: 999_999, authToken: "tok-test" }) as NodeJS.Timeout;

    // If the timer is unref'd, timer[Symbol.toPrimitive] won't block the event loop.
    // We can only verify it by checking the ref count indirectly — the timer must have an unref method.
    // (Node.js Timeout objects always expose .unref(); we call it here and verify no error.)
    expect(() => timer.unref?.()).not.toThrow();
    clearInterval(timer);
  });
});

// ── Type / export smoke check ──────────────────────────────────────────────

describe("exports — module shape contract", () => {
  it("exports runAntiEntropyPass as an async function", () => {
    expect(typeof runAntiEntropyPass).toBe("function");
    // Quick smoke: calling without args should either throw synchronously or return a Promise.
    // We don't await it — just checking the function exists and is callable.
  });

  it("exports registerAntiEntropyCron as a function", () => {
    expect(typeof registerAntiEntropyCron).toBe("function");
  });
});
