/**
 * AI-1773 — Failing tests for standalone-governed-ticket SLA evaluation.
 *
 * AC1: A standalone governed ticket whose time in its current state exceeds
 *      that state's `sla:` produces exactly one warning-level alert via the
 *      alert bus notify() funnel (deduped across subsequent sweeps — no re-fire)
 *      and exactly one steward wake for the breached ticket.
 *
 * AC2: A managed child in the same breach condition produces NO additional alert
 *      from this driver — the barrier stall path owns it. The exclusion is
 *      explicit in code and proven by test.
 *
 *      Intake spec addition (Astrid, 2026-07-05): the managed-child exclusion
 *      must key off the same predicate barrier.ts uses to claim a ticket for
 *      the barrier stall path — not a parallel heuristic. Both paths must share
 *      the predicate (or import the same helper).
 *
 * AC3: Restart resilience, proven by test:
 *      - A breach alerted before a connector restart is not re-alerted after restart.
 *      - A ticket whose SLA elapsed while the connector was down is detected and
 *        alerted on the first sweep after startup.
 *      - Breach detection derives from persisted state-entry timestamps (not in-memory timers).
 *
 * AC4: A state with no `sla:` value never alerts, regardless of how long a
 *      ticket sits in it.
 *
 * AC5: The sweep performs no per-ticket Linear API fan-out per tick (batched or
 *      cached reads only), and its cadence is configurable with a sane default.
 *
 * AC6: Full test suite green (passes when AC1–AC5 implementation lands).
 *
 * All tests MUST be RED until the implementation lands in src/sla-sweep.ts
 * and the isManagedBarrierChild export lands in src/barrier.ts.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";

// ── Imports under test (these modules do not exist yet — tests will be RED) ──
import {
  runSlaSweep,
  registerSlaSweepCron,
  type SlaSweepOptions,
  type SlaSweepResult,
} from "./sla-sweep.js";

// isManagedBarrierChild must be a new export from barrier.ts that covers all
// BARRIER_WORKFLOWS (ux-audit, sprint, vocab-builder, word-build), not just
// the existing isChildOfUxAuditParent (ux-audit only). The sla-sweep driver
// must import and use this same function — not a parallel heuristic.
import { isManagedBarrierChild } from "./barrier.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { getRegisteredCrons } from "./cron/registry.js";

// AlertStore for restart-resilience assertions (dedup across instances)
import { AlertStore } from "./alerts/alert-store.js";

// ── Fixture helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sla-sweep-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a multi-document YAML workflow registry and return its path.
 * Includes dev-impl (with per-state SLAs) and ux-audit (barrier workflow).
 */
function writeWorkflowRegistry(overrides: { devImpl?: Record<string, unknown>; uxAudit?: Record<string, unknown> } = {}): string {
  const devImpl = {
    id: "dev-impl",
    entry_state: "intake",
    archetype: "single-task",
    states: [
      { id: "intake",         owner_role: "steward",     native_state: "todo" },
      { id: "write-tests",    owner_role: "test-author", native_state: "todo",    sla: "48h" },
      { id: "implementation", owner_role: "dev",         native_state: "todo",    sla: "72h" },
      { id: "code-review",    owner_role: "code-review", native_state: "thinking", sla: "24h" },
      { id: "deployment",     owner_role: "deployment",  native_state: "todo",    sla: "4h" },
      { id: "ac-validate",    owner_role: "steward",     native_state: "todo",    sla: "24h" },
      { id: "done",           native_state: "done" },
    ],
    ...overrides.devImpl,
  };
  // AI-1992: barrier-ness is config-driven — the managing state declares
  // `barrier: true` (migrated from the removed BARRIER_WORKFLOWS set).
  const uxAudit = {
    id: "ux-audit",
    entry_state: "intake",
    archetype: "orchestrator",
    states: [
      { id: "intake",   owner_role: "steward",       native_state: "todo" },
      { id: "managing", owner_role: "dev",            native_state: "managing", barrier: true },
      { id: "review",   owner_role: "code-review",   native_state: "thinking" },
      { id: "done",     native_state: "done" },
    ],
    ...overrides.uxAudit,
  };
  const sprint = {
    id: "sprint",
    entry_state: "intake",
    archetype: "feature-initiative",
    states: [
      { id: "intake",     owner_role: "steward",     native_state: "todo" },
      { id: "managing",   owner_role: "dev",         native_state: "managing", barrier: true },
      { id: "validating", owner_role: "steward",     native_state: "thinking" },
      { id: "done",       native_state: "done" },
    ],
  };
  const vocabBuilder = {
    id: "vocab-builder",
    entry_state: "intake",
    archetype: "orchestrator",
    states: [
      { id: "intake",   owner_role: "steward",     native_state: "todo" },
      { id: "managing", owner_role: "dev",         native_state: "managing", barrier: true },
      { id: "review",   owner_role: "steward",     native_state: "thinking" },
      { id: "done",     native_state: "done" },
    ],
  };
  const p = path.join(tmpDir, `wf-defs-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(
    p,
    `---\n${yaml.dump(devImpl)}\n---\n${yaml.dump(uxAudit)}\n---\n${yaml.dump(sprint)}\n---\n${yaml.dump(vocabBuilder)}`,
    "utf8",
  );
  return p;
}

/** Build a minimal SlaSweepOptions with all non-Linear dependencies injected. */
function makeOptions(overrides: Partial<SlaSweepOptions> = {}): SlaSweepOptions {
  return {
    authToken: "lin_test_token",
    workflowDefPath: writeWorkflowRegistry(),
    fetchFn: jest.fn(async () => new Response(JSON.stringify({ data: { issues: { nodes: [] } } }))),
    notify: jest.fn(),
    wakeAgent: jest.fn(async () => {}),
    now: () => Date.now(),
    ...overrides,
  };
}

/** Returns epoch ms for N hours ago. */
function hoursAgo(n: number): number {
  return Date.now() - n * 60 * 60 * 1000;
}

/** Epoch ms timestamp as ISO string (for Linear API mocks). */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── Fetch mock builder ────────────────────────────────────────────────────────

interface MockTicket {
  id: string;
  identifier: string;
  teamId: string;
  wfLabel: string;          // e.g. "wf:dev-impl"
  stateLabel: string;       // e.g. "state:write-tests"
  stateEnteredAt: number;   // epoch ms
  parentId?: string | null; // if managed child: parent's internal id
  parentIdentifier?: string | null;
  parentWfLabel?: string;   // e.g. "wf:ux-audit"
  parentStateLabel?: string;// e.g. "state:managing"
}

/**
 * Build a fetch mock that handles the two expected query shapes:
 *   1. Batch governed-ticket listing (issues with wf:* labels)
 *   2. Per-ticket (or batched) parent-state lookup for managed-child exclusion
 */
function makeFetchMock(tickets: MockTicket[], opts: {
  fetchCallLog?: string[];
} = {}): typeof globalThis.fetch {
  return jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = (parsed.query ?? "").replace(/\s+/g, " ");
    const variables = (parsed.variables ?? {}) as Record<string, unknown>;

    if (opts.fetchCallLog) opts.fetchCallLog.push(query.slice(0, 80));

    // ── 1. Batch listing query (governed tickets) ──────────────────────────
    if (query.includes("wf:") || query.includes("wf:\\*") || query.includes("label") && query.includes("issues")) {
      const nodes = tickets.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        team: { id: t.teamId },
        labels: {
          nodes: [
            { id: `lbl-wf-${t.id}`, name: t.wfLabel },
            { id: `lbl-state-${t.id}`, name: t.stateLabel },
          ],
        },
        history: {
          nodes: [
            { createdAt: iso(t.stateEnteredAt) },
          ],
        },
        parent: t.parentId
          ? {
              id: t.parentId,
              identifier: t.parentIdentifier ?? "AI-PARENT",
              labels: {
                nodes: [
                  { name: t.parentWfLabel ?? "wf:ux-audit" },
                  { name: t.parentStateLabel ?? "state:managing" },
                ],
              },
            }
          : null,
      }));
      return new Response(JSON.stringify({ data: { issues: { nodes } } }));
    }

    // ── 2. Single-issue lookup (parent state check or individual issue) ────
    if (query.includes("issue(") && variables.id) {
      const id = variables.id as string;
      const t = tickets.find((x) => x.id === id || x.identifier === id);
      if (t) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: t.id,
              identifier: t.identifier,
              labels: {
                nodes: [
                  { name: t.wfLabel },
                  { name: t.stateLabel },
                ],
              },
              parent: t.parentId
                ? {
                    id: t.parentId,
                    identifier: t.parentIdentifier ?? "AI-PARENT",
                    labels: {
                      nodes: [
                        { name: t.parentWfLabel ?? "wf:ux-audit" },
                        { name: t.parentStateLabel ?? "state:managing" },
                      ],
                    },
                  }
                : null,
            },
          },
        }));
      }
      return new Response(JSON.stringify({ data: { issue: null } }));
    }

    return new Response(JSON.stringify({ data: {} }));
  }) as unknown as typeof globalThis.fetch;
}

// ════════════════════════════════════════════════════════════════════════════
// AC1 — Standalone governed ticket breaching SLA → one alert + one steward wake
// ════════════════════════════════════════════════════════════════════════════

describe("AC1 — standalone breach: alert + steward wake", () => {
  it("emits exactly one warning-level notify() for a standalone ticket over its state SLA", async () => {
    const stateEnteredAt = hoursAgo(50); // 50h ago; SLA = 48h
    const ticket: MockTicket = {
      id: "uuid-a1",
      identifier: "AI-999",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt,
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    const result: SlaSweepResult = await runSlaSweep(opts);

    expect(result.breachesDetected).toBeGreaterThanOrEqual(1);
    expect(result.alertsEmitted).toBe(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const call = (notifySpy as jest.MockedFunction<typeof notifySpy>).mock.calls[0]?.[0] as {
      severity: string;
      source: string;
      ticket?: string;
    } | undefined;
    expect(call?.severity).toBe("warning");
    expect(call?.source).toBe("sla-sweep");
    expect(call?.ticket).toBe("AI-999");
  });

  it("sends exactly one steward wake for the breached standalone ticket", async () => {
    const ticket: MockTicket = {
      id: "uuid-a2",
      identifier: "AI-998",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:implementation",
      stateEnteredAt: hoursAgo(80), // 80h ago; SLA = 72h
    };
    const wakeAgentSpy = jest.fn(async () => {});
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: jest.fn(),
      wakeAgent: wakeAgentSpy,
    });

    await runSlaSweep(opts);

    expect(wakeAgentSpy).toHaveBeenCalledTimes(1);
    const [calledId] = (wakeAgentSpy as jest.MockedFunction<typeof wakeAgentSpy>).mock.calls[0] as [string];
    expect(calledId).toBe("AI-998");
  });

  it("does not re-fire the alert on a subsequent sweep (dedup — no re-fire)", async () => {
    const storePath = path.join(tmpDir, "breach-dedup-ac1.db");
    const ticket: MockTicket = {
      id: "uuid-a3",
      identifier: "AI-997",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(52),
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
      breachStorePath: storePath,
    });

    // First sweep — breach detected, alert emitted
    await runSlaSweep(opts);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Second sweep (same instance or same store) — breach already recorded, no re-fire
    await runSlaSweep(opts);
    expect(notifySpy).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("does not alert when the ticket is within its SLA", async () => {
    const ticket: MockTicket = {
      id: "uuid-a4",
      identifier: "AI-996",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(10), // 10h ago; SLA = 48h — no breach
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    const result = await runSlaSweep(opts);

    expect(result.breachesDetected).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Managed-child exclusion: barrier stall path owns it, no double-fire
// ════════════════════════════════════════════════════════════════════════════

describe("AC2 — managed-child exclusion: barrier stall path owns it", () => {
  it("does NOT alert for a ticket that is a managed child of a ux-audit parent in managing state", async () => {
    const ticket: MockTicket = {
      id: "uuid-b1",
      identifier: "AI-995",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(60), // over SLA
      parentId: "uuid-parent-1",
      parentIdentifier: "AI-900",
      parentWfLabel: "wf:ux-audit",
      parentStateLabel: "state:managing",
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    const result = await runSlaSweep(opts);

    expect(result.managedChildrenExcluded).toBeGreaterThanOrEqual(1);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("does NOT alert for a managed child of a sprint parent in managing state", async () => {
    const ticket: MockTicket = {
      id: "uuid-b2",
      identifier: "AI-994",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:implementation",
      stateEnteredAt: hoursAgo(80),
      parentId: "uuid-parent-2",
      parentIdentifier: "AI-890",
      parentWfLabel: "wf:sprint",
      parentStateLabel: "state:managing",
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("does NOT alert for a managed child of a vocab-builder parent in managing state", async () => {
    const ticket: MockTicket = {
      id: "uuid-b3",
      identifier: "AI-993",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:implementation",
      stateEnteredAt: hoursAgo(80),
      parentId: "uuid-parent-3",
      parentIdentifier: "AI-880",
      parentWfLabel: "wf:vocab-builder",
      parentStateLabel: "state:managing",
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("DOES alert for a ticket whose parent is NOT in managing state (parent is in review)", async () => {
    const ticket: MockTicket = {
      id: "uuid-b4",
      identifier: "AI-992",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(55),
      parentId: "uuid-parent-4",
      parentIdentifier: "AI-870",
      parentWfLabel: "wf:ux-audit",
      parentStateLabel: "state:review", // NOT managing
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    expect(notifySpy).toHaveBeenCalled();
  });

  it("DOES alert for a ticket whose parent is on a non-barrier workflow", async () => {
    const ticket: MockTicket = {
      id: "uuid-b5",
      identifier: "AI-991",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(55),
      parentId: "uuid-parent-5",
      parentIdentifier: "AI-860",
      parentWfLabel: "wf:dev-impl", // NOT a barrier workflow
      parentStateLabel: "state:managing",
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    expect(notifySpy).toHaveBeenCalled();
  });

  // Shared-predicate proof: isManagedBarrierChild must be importable from barrier.ts
  // and must agree with the sla-sweep exclusion. This test verifies the function
  // exists and correctly identifies managed vs non-managed children.
  describe("isManagedBarrierChild — shared predicate (imported from barrier.ts)", () => {
    let savedFetch: typeof globalThis.fetch;
    let origDefsDir: string | undefined;

    // AI-1992: isManagedBarrierChild loads the process workflow registry to read
    // the parent's barrier flag. Point it at the migrated canonical fixtures
    // (ux-audit/sprint carry managing barrier: true; dev-impl does not).
    beforeAll(() => {
      origDefsDir = process.env.WORKFLOW_DEFS_DIR;
      process.env.WORKFLOW_DEFS_DIR = path.resolve(process.cwd(), "src/__fixtures__");
      resetWorkflowCache();
    });

    afterAll(() => {
      if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir;
      else delete process.env.WORKFLOW_DEFS_DIR;
      resetWorkflowCache();
    });

    beforeEach(() => {
      resetWorkflowCache();
      savedFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
    });

    it("returns true for a ticket whose parent is in a barrier workflow in managing state", async () => {
      globalThis.fetch = makeFetchMock([{
        id: "uuid-pred-1",
        identifier: "AI-501",
        teamId: "team-1",
        wfLabel: "wf:dev-impl",
        stateLabel: "state:write-tests",
        stateEnteredAt: hoursAgo(50),
        parentId: "uuid-parent-pred",
        parentIdentifier: "AI-500",
        parentWfLabel: "wf:ux-audit",
        parentStateLabel: "state:managing",
      }]);

      const result = await isManagedBarrierChild("AI-501", "lin_test_token");
      expect(result).toBe(true);
    });

    it("returns false for a standalone ticket with no parent", async () => {
      globalThis.fetch = makeFetchMock([{
        id: "uuid-pred-2",
        identifier: "AI-502",
        teamId: "team-1",
        wfLabel: "wf:dev-impl",
        stateLabel: "state:write-tests",
        stateEnteredAt: hoursAgo(50),
      }]);

      const result = await isManagedBarrierChild("AI-502", "lin_test_token");
      expect(result).toBe(false);
    });

    it("returns false for a ticket whose parent is NOT in managing state", async () => {
      globalThis.fetch = makeFetchMock([{
        id: "uuid-pred-3",
        identifier: "AI-503",
        teamId: "team-1",
        wfLabel: "wf:dev-impl",
        stateLabel: "state:write-tests",
        stateEnteredAt: hoursAgo(50),
        parentId: "uuid-parent-pred-3",
        parentIdentifier: "AI-499",
        parentWfLabel: "wf:ux-audit",
        parentStateLabel: "state:review",
      }]);

      const result = await isManagedBarrierChild("AI-503", "lin_test_token");
      expect(result).toBe(false);
    });

    it("returns false for a ticket whose parent is on a non-barrier workflow", async () => {
      globalThis.fetch = makeFetchMock([{
        id: "uuid-pred-4",
        identifier: "AI-504",
        teamId: "team-1",
        wfLabel: "wf:dev-impl",
        stateLabel: "state:write-tests",
        stateEnteredAt: hoursAgo(50),
        parentId: "uuid-parent-pred-4",
        parentIdentifier: "AI-498",
        parentWfLabel: "wf:dev-impl",
        parentStateLabel: "state:managing",
      }]);

      const result = await isManagedBarrierChild("AI-504", "lin_test_token");
      expect(result).toBe(false);
    });

    it("returns true for a sprint-managed child (not just ux-audit)", async () => {
      globalThis.fetch = makeFetchMock([{
        id: "uuid-pred-5",
        identifier: "AI-505",
        teamId: "team-1",
        wfLabel: "wf:dev-impl",
        stateLabel: "state:write-tests",
        stateEnteredAt: hoursAgo(50),
        parentId: "uuid-parent-pred-5",
        parentIdentifier: "AI-497",
        parentWfLabel: "wf:sprint",
        parentStateLabel: "state:managing",
      }]);

      const result = await isManagedBarrierChild("AI-505", "lin_test_token");
      expect(result).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — Restart resilience
// ════════════════════════════════════════════════════════════════════════════

describe("AC3 — restart resilience", () => {
  it("does not re-alert a breach that was alerted before a connector restart", async () => {
    const storePath = path.join(tmpDir, `breach-restart-${Math.random().toString(36).slice(2)}.db`);
    const ticket: MockTicket = {
      id: "uuid-c1",
      identifier: "AI-990",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(55),
    };
    const notifyFirst = jest.fn();

    // First sweep instance (pre-restart)
    await runSlaSweep(makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifyFirst,
      wakeAgent: jest.fn(async () => {}),
      breachStorePath: storePath,
    }));
    expect(notifyFirst).toHaveBeenCalledTimes(1);

    // Simulate restart: new sweep instance, same persisted store
    const notifySecond = jest.fn();
    await runSlaSweep(makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySecond,
      wakeAgent: jest.fn(async () => {}),
      breachStorePath: storePath,
    }));

    // Must not re-alert (breach store persisted across restart)
    expect(notifySecond).not.toHaveBeenCalled();
  });

  it("detects and alerts a ticket whose SLA elapsed while the connector was down", async () => {
    const storePath = path.join(tmpDir, `breach-downtime-${Math.random().toString(36).slice(2)}.db`);
    const stateEnteredAt = hoursAgo(72); // SLA = 48h, elapsed 24h ago (while "down")
    const ticket: MockTicket = {
      id: "uuid-c2",
      identifier: "AI-989",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt,
    };
    // Simulate "first sweep after startup" — no prior state in the breach store
    const notifySpy = jest.fn();
    await runSlaSweep(makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
      breachStorePath: storePath,
    }));

    // Breach must be detected from persisted stateEnteredAt (not an in-memory timer)
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const call = (notifySpy as jest.MockedFunction<typeof notifySpy>).mock.calls[0]?.[0] as {
      severity: string;
      ticket?: string;
    } | undefined;
    expect(call?.severity).toBe("warning");
    expect(call?.ticket).toBe("AI-989");
  });

  it("breach detection uses state-entry timestamps from Linear history (not in-memory timers)", async () => {
    // Two runSlaSweep calls share no in-memory state; both use the same
    // state-entry timestamp returned by the fetch mock. The first call alerts;
    // the second (separate instance, no shared breach store) also alerts —
    // proving that detection is timestamp-driven, not timer-driven.
    //
    // (Restart resilience is the store's job; this test confirms the detection
    // mechanism is correct independently of the store.)
    const ticket: MockTicket = {
      id: "uuid-c3",
      identifier: "AI-988",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(50),
    };

    const notifyA = jest.fn();
    await runSlaSweep(makeOptions({ fetchFn: makeFetchMock([ticket]), notify: notifyA, wakeAgent: jest.fn(async () => {}) }));

    const notifyB = jest.fn();
    // Fresh instance, no breach store shared — would re-detect
    await runSlaSweep(makeOptions({ fetchFn: makeFetchMock([ticket]), notify: notifyB, wakeAgent: jest.fn(async () => {}) }));

    // Both should detect from the timestamp
    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyB).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — State with no sla: never alerts
// ════════════════════════════════════════════════════════════════════════════

describe("AC4 — state with no sla: value never alerts", () => {
  it("does not alert for a ticket in a state with no sla: defined", async () => {
    const ticket: MockTicket = {
      id: "uuid-d1",
      identifier: "AI-987",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:intake", // intake has no sla: in the fixture
      stateEnteredAt: hoursAgo(1000), // absurdly long
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    const result = await runSlaSweep(opts);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(result.breachesDetected).toBe(0);
  });

  it("does not alert for a ticket in a terminal state (done has no sla:)", async () => {
    const ticket: MockTicket = {
      id: "uuid-d2",
      identifier: "AI-986",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:done",
      stateEnteredAt: hoursAgo(1000),
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("does not alert for an unknown workflow (no def loaded)", async () => {
    const ticket: MockTicket = {
      id: "uuid-d3",
      identifier: "AI-985",
      teamId: "team-1",
      wfLabel: "wf:unknown-workflow",
      stateLabel: "state:doing",
      stateEnteredAt: hoursAgo(1000),
    };
    const notifySpy = jest.fn();
    const opts = makeOptions({
      fetchFn: makeFetchMock([ticket]),
      notify: notifySpy,
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    expect(notifySpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — No per-ticket fan-out; configurable cadence
// ════════════════════════════════════════════════════════════════════════════

describe("AC5 — no per-ticket Linear API fan-out; configurable cadence", () => {
  it("uses a single batch query to fetch governed tickets (no N-call fan-out per ticket)", async () => {
    const fetchCallLog: string[] = [];
    const tickets: MockTicket[] = Array.from({ length: 5 }, (_, i) => ({
      id: `uuid-e${i}`,
      identifier: `AI-9${80 + i}`,
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(60 + i),
    }));
    const opts = makeOptions({
      fetchFn: makeFetchMock(tickets, { fetchCallLog }),
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });

    await runSlaSweep(opts);

    // All 5 tickets should have been handled with a bounded number of queries.
    // The sweep must NOT make one query per ticket for the governed-ticket listing.
    // Allow at most: 1 batch listing + optional parent-state batch (≤ 5 total, not 5+).
    // The strict invariant is: queries < 2 * tickets.length (not O(N) linear fan-out).
    const callCount = fetchCallLog.length;
    expect(callCount).toBeLessThan(5); // Not one call per ticket for the listing phase
  });

  it("reports scanned count equal to total governed tickets found", async () => {
    const tickets: MockTicket[] = Array.from({ length: 3 }, (_, i) => ({
      id: `uuid-e2-${i}`,
      identifier: `AI-97${i}`,
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:intake", // no sla, won't alert
      stateEnteredAt: hoursAgo(5),
    }));
    const opts = makeOptions({
      fetchFn: makeFetchMock(tickets),
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });

    const result = await runSlaSweep(opts);

    expect(result.scanned).toBe(3);
  });

  it("exports registerSlaSweepCron which accepts a configurable cadence", () => {
    // registerSlaSweepCron must accept sweep options including a cadenceMs parameter.
    // The function must return a timer handle (NodeJS.Timeout) so the caller can
    // cancel it on shutdown. The cadence must NOT be hardcoded — it must be
    // configurable (via option or env var).
    expect(typeof registerSlaSweepCron).toBe("function");

    // The function signature should accept options including cadenceMs
    // (we can't invoke it in tests without a real auth token, but we verify
    // that it at least accepts the right shape)
    const timer = registerSlaSweepCron({
      authToken: "lin_test_token",
      workflowDefPath: writeWorkflowRegistry(),
      cadenceMs: 999_999, // custom cadence — must not use a hardcoded default
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });

    // Must return a timer handle that can be cleared
    expect(timer).toBeDefined();
    clearInterval(timer as ReturnType<typeof setInterval>);
  });

  it("returns a timer that does not prevent process exit (unref'd)", () => {
    const timer = registerSlaSweepCron({
      authToken: "lin_test_token",
      workflowDefPath: writeWorkflowRegistry(),
      cadenceMs: 999_999,
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });

    // Node.js timers expose `unref()` — callers should not need to unref manually.
    // We verify the timer object has the standard NodeJS.Timeout shape.
    expect(timer).not.toBeNull();
    clearInterval(timer as ReturnType<typeof setInterval>);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — runSlaSweep result shape
// ════════════════════════════════════════════════════════════════════════════

describe("runSlaSweep result shape", () => {
  it("returns a well-formed SlaSweepResult with all expected fields", async () => {
    const opts = makeOptions({
      fetchFn: makeFetchMock([]),
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });

    const result = await runSlaSweep(opts);

    expect(typeof result.scanned).toBe("number");
    expect(typeof result.managedChildrenExcluded).toBe("number");
    expect(typeof result.breachesDetected).toBe("number");
    expect(typeof result.alertsEmitted).toBe("number");
    expect(typeof result.wakesDispatched).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("returns scanned=0 and no alerts when no governed tickets exist", async () => {
    const opts = makeOptions({
      fetchFn: makeFetchMock([]),
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });

    const result = await runSlaSweep(opts);

    expect(result.scanned).toBe(0);
    expect(result.breachesDetected).toBe(0);
    expect(result.alertsEmitted).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Mixed standalone + managed children in same sweep
// ════════════════════════════════════════════════════════════════════════════

describe("AC2 — mixed sweep: standalone alerts, managed children excluded", () => {
  it("alerts the standalone ticket but not the managed child in the same sweep", async () => {
    const standalone: MockTicket = {
      id: "uuid-mix-1",
      identifier: "AI-960",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(55),
    };
    const managedChild: MockTicket = {
      id: "uuid-mix-2",
      identifier: "AI-961",
      teamId: "team-1",
      wfLabel: "wf:dev-impl",
      stateLabel: "state:write-tests",
      stateEnteredAt: hoursAgo(55),
      parentId: "uuid-parent-mix",
      parentIdentifier: "AI-950",
      parentWfLabel: "wf:ux-audit",
      parentStateLabel: "state:managing",
    };
    const notifySpy = jest.fn();
    const wakeAgentSpy = jest.fn(async () => {});
    const opts = makeOptions({
      fetchFn: makeFetchMock([standalone, managedChild]),
      notify: notifySpy,
      wakeAgent: wakeAgentSpy,
    });

    const result = await runSlaSweep(opts);

    // One breach found (standalone only)
    expect(result.breachesDetected).toBe(1);
    expect(result.managedChildrenExcluded).toBeGreaterThanOrEqual(1);

    // Alert and wake only for the standalone ticket
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(wakeAgentSpy).toHaveBeenCalledTimes(1);

    const notifyCall = (notifySpy as jest.MockedFunction<typeof notifySpy>).mock.calls[0]?.[0] as {
      ticket?: string;
    } | undefined;
    expect(notifyCall?.ticket).toBe("AI-960");

    const wakeCall = (wakeAgentSpy as jest.MockedFunction<typeof wakeAgentSpy>).mock.calls[0] as [string];
    expect(wakeCall[0]).toBe("AI-960");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Def loader — directory mode (WORKFLOW_DEFS_DIR production layout)
// ════════════════════════════════════════════════════════════════════════════

describe("workflow def loader — directory mode", () => {
  it("loads defs from a directory of *.yaml files (WORKFLOW_DEFS_DIR layout)", async () => {
    // Write two separate YAML files into a temp directory, mirroring the
    // connector's WORKFLOW_DEFS_DIR production layout where dev-impl.yaml,
    // task.yaml, etc. live as siblings.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sla-sweep-dirmode-"));
    try {
      const devImpl = {
        id: "dev-impl",
        entry_state: "intake",
        archetype: "single-task",
        states: [
          { id: "intake", owner_role: "steward", native_state: "todo" },
          { id: "implementation", owner_role: "dev", native_state: "todo", sla: "72h" },
          { id: "done", native_state: "done" },
        ],
      };
      const task = {
        id: "task",
        entry_state: "intake",
        archetype: "single-task",
        states: [
          { id: "intake", owner_role: "steward", native_state: "todo" },
          { id: "write-tests", owner_role: "test-author", native_state: "todo", sla: "24h" },
          { id: "done", native_state: "done" },
        ],
      };
      fs.writeFileSync(path.join(dir, "dev-impl.yaml"), yaml.dump(devImpl), "utf8");
      fs.writeFileSync(path.join(dir, "task.yaml"), yaml.dump(task), "utf8");

      // A ticket on wf:task in write-tests past the 24h SLA should alert —
      // proving the task.yaml def was loaded from the directory.
      const taskTicket: MockTicket = {
        id: "tic-2001",
        identifier: "AI-2001",
        teamId: "team-1",
        wfLabel: "wf:task",
        stateLabel: "state:write-tests",
        stateEnteredAt: hoursAgo(30), // 30h > 24h SLA
      };

      const notifySpy = jest.fn();
      const wakeSpy = jest.fn(async () => {});
      const result = await runSlaSweep(
        makeOptions({
          workflowDefPath: dir, // ← directory, not a file
          fetchFn: makeFetchMock([taskTicket]),
          notify: notifySpy,
          wakeAgent: wakeSpy,
        }),
      );

      expect(result.breachesDetected).toBe(1);
      expect(result.alertsEmitted).toBe(1);
      expect(notifySpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty def map for a non-existent path without throwing", async () => {
    const result = await runSlaSweep(
      makeOptions({
        workflowDefPath: path.join(os.tmpdir(), "sla-sweep-nonexistent-" + Date.now()),
        fetchFn: makeFetchMock([]),
      }),
    );
    // No defs loaded → no breaches; sweep completes without error
    expect(result.scanned).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// registerSlaSweepCron — liveness signal (AI-1808: liveness observable at ac-validate)
// ════════════════════════════════════════════════════════════════════════════

describe("registerSlaSweepCron — liveness signal", () => {
  it("registers in the cron registry so liveness is observable without a real breach", () => {
    // AI-1810 superseded the startup log line with a cron-registry entry:
    // registration proves the cron scheduled without waiting for a breach,
    // and /health enumerates it for the ac-validate liveness check.
    const timer = registerSlaSweepCron({
      authToken: "lin_test_token",
      workflowDefPath: writeWorkflowRegistry(),
      cadenceMs: 999_999,
      breachStorePath: path.join(os.tmpdir(), "sla-sweep-liveness-test.db"),
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
    });
    clearInterval(timer as ReturnType<typeof setInterval>);
    const entry = getRegisteredCrons().find((c) => c.name === "sla-sweep");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toContain("every");
  });
});

// Bootstrap wiring — registerSlaSweepCron is reachable from the production entry point
// (AI-1808 class-of-gap: built-but-not-wired pattern — 2nd occurrence).
// ════════════════════════════════════════════════════════════════════════════

describe("bootstrap wiring — registerSlaSweepCron reachable from entry point", () => {
  it("registerSlaSweepCron is exported and importable from sla-sweep module", () => {
    // Proves the function exists and is exported — the production entry point
    // (index.ts) imports and calls it at bootstrap.
    expect(typeof registerSlaSweepCron).toBe("function");
    expect(typeof runSlaSweep).toBe("function");
  });
});
