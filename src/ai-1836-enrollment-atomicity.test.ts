/**
 * AI-1836 — Enrollment atomicity: wf:* without state:* is a deadlock trap.
 *
 * Problem: Adding a wf:* label without atomically stamping the entry state:*
 * label creates the corrupted projection the workflow gate fail-closes on:
 * wf:* present, state:* absent → every verb blocked, hard deadlock.
 *
 * Root cause of AI-1785 (2026-07-05): Hanzo added wf:dev-impl mid
 * webhook outage (AI-1803); the webhook-driven bootstrap hook never fired;
 * no live heal path existed.
 *
 * Deliverables:
 *   1. Enrollment atomicity — bootstrap failure produces visible error, not
 *      silent null. System guarantee: sweep heals enrollment-gap.
 *   2. Webhook-independent heal — verify the reconciliation sweep (AI-1775)
 *      heals the wf:*-present / state:*-absent shape. Resolve the discrepancy
 *      between Grover's AI-1815 statement ("enrollment-heal is webhook-only")
 *      and the sweep's actual coverage.
 *
 * AC-to-test mapping:
 *   AC1: wf:* add during simulated webhook outage → sweep heals (both labels
 *        land) OR sweep rejects with visible error. The ticket cannot remain
 *        permanently in the deadlock state.
 *   AC1-failure: bootstrap fires but fails (e.g., no workflow def) → returns
 *        { action: "failed" } instead of null; webhook handler emits alert.
 *   AC2: sweep heals a pre-existing wf:*-present / state:*-absent ticket
 *        without webhook delivery. Evidence that the sweep covers this shape,
 *        resolving the AI-1815 discrepancy.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  applyBootstrapToIssue,
  type BootstrapResult,
  type IssueContext,
} from "./workflow-bootstrap.js";
import {
  runBootstrapReconciliationSweep,
  type ReconciliationSweepOptions,
} from "./bootstrap-reconciliation-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const TEAM_ID = "team-uuid-test";
const ISSUE_ID = "issue-uuid-1836";
const ISSUE_IDENTIFIER = "AI-1836-test";
const WF_LABEL_ID = "label-wf-dev-impl";
const WF_LABEL_NAME = "wf:dev-impl";
const STATE_INTAKE_LABEL_ID = "label-state-intake";

const TEST_WORKFLOW_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake",         owner_role: "steward" },
    { id: "write-tests",    owner_role: "test-author" },
    { id: "implementation", owner_role: "dev" },
    { id: "done",           owner_role: undefined },
    { id: "escape",         owner_role: undefined },
  ],
};

const WORKFLOW_REGISTRY = new Map([["dev-impl", TEST_WORKFLOW_DEF]]);

const OLD_TIMESTAMP = new Date(Date.now() - 10 * 60 * 1000).toISOString();

function makeIssueContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    id: ISSUE_ID,
    teamId: TEAM_ID,
    identifier: ISSUE_IDENTIFIER,
    title: "AI-1836 enrollment test",
    labels: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
    ...overrides,
  };
}

function makeTestAlertBus() {
  const collected: Array<import("./alerts/alert-store.js").AlertInput> = [];
  const store = new AlertStore(":memory:");
  const bus = new AlertBus({ store, pushEnabled: false, now: () => new Date() });
  const originalNotify = bus.notify.bind(bus);
  jest.spyOn(bus, "notify").mockImplementation((alert) => {
    collected.push(alert);
    return originalNotify(alert);
  });
  return { bus, alerts: collected, store };
}

/** Build a fetch mock for the reconciliation sweep. */
function makeSweepFetch(opts: {
  unenrolledTickets: Array<{
    id: string;
    identifier: string;
    updatedAt: string;
    labelNodes: Array<{ id: string; name: string }>;
    delegateId?: string | null;
    teamId: string;
  }>;
  mutationSuccess?: boolean;
}) {
  const { unenrolledTickets, mutationSuccess = true } = opts;

  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";

    // Sweep query: wf:* tickets
    if (body.includes("wf:") || body.includes("BootstrapReconciliation")) {
      const nodes = unenrolledTickets.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: t.updatedAt,
        labels: { nodes: t.labelNodes },
        delegate: t.delegateId ? { id: t.delegateId } : null,
        team: { id: t.teamId },
        title: `Ticket ${t.identifier}`,
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Team labels lookup
    if (body.includes("labels") && body.includes(TEAM_ID)) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
                  { id: WF_LABEL_ID, name: WF_LABEL_NAME },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // issueUpdate mutation
    if (body.includes("issueUpdate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueWithLabels re-fetch
    if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
      const ticket = unenrolledTickets[0];
      if (ticket) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: ticket.id,
                identifier: ticket.identifier,
                title: `Ticket ${ticket.identifier}`,
                team: { id: ticket.teamId },
                labels: { nodes: ticket.labelNodes },
                delegate: ticket.delegateId ? { id: ticket.delegateId } : null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  resetWorkflowCache();
  jest.restoreAllMocks();
});

// ── AC1-failure: applyBootstrapToIssue returns failure results ─────────────

describe("AC1-failure: applyBootstrapToIssue returns visible failure instead of silent null", () => {
  it("returns { action: 'failed' } when workflow def is missing (no null)", async () => {
    // Inject an empty registry — no def for "dev-impl"
    const emptyRegistry = new Map<string, unknown>();
    const issue = makeIssueContext();

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await applyBootstrapToIssue(issue, "***", emptyRegistry);

    // Must NOT be null — must be a visible failure
    expect(result).not.toBeNull();
    expect(result!.action).toBe("failed");
    expect(result!.failureReason).toBe("no_workflow_def");
    expect(result!.workflowId).toBe("dev-impl");
    expect(result!.failureMessage).toContain("dev-impl");
  });

  it("returns { action: 'failed' } when workflow def has no entry_state", async () => {
    // Registry has the def but entry_state is missing
    const noEntryRegistry = new Map([
      [
        "dev-impl",
        { ...TEST_WORKFLOW_DEF, entry_state: undefined },
      ],
    ]);
    const issue = makeIssueContext();

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await applyBootstrapToIssue(issue, "***", noEntryRegistry as never);

    expect(result).not.toBeNull();
    expect(result!.action).toBe("failed");
    expect(result!.failureReason).toBe("no_entry_state");
    expect(result!.workflowId).toBe("dev-impl");
  });

  it("returns { action: 'failed' } when label creation fails", async () => {
    const issue = makeIssueContext();

    // Mock fetch so that label creation returns no labels
    globalThis.fetch = async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";

      // Team labels: return empty set — no state:intake label exists
      if (body.includes("labels") && body.includes(TEAM_ID)) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: { nodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await applyBootstrapToIssue(issue, "***", WORKFLOW_REGISTRY as never);

    expect(result).not.toBeNull();
    expect(result!.action).toBe("failed");
    expect(result!.failureReason).toBe("label_creation_failed");
  });

  it("returns { action: 'failed' } when issueUpdateAtomic fails", async () => {
    const issue = makeIssueContext();

    let callCount = 0;
    globalThis.fetch = async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      callCount++;

      // Team labels: return state:intake label
      if (body.includes("labels") && body.includes(TEAM_ID)) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
                    { id: WF_LABEL_ID, name: WF_LABEL_NAME },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // issueUpdate: return failure
      if (body.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: false } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await applyBootstrapToIssue(issue, "***", WORKFLOW_REGISTRY as never);

    expect(result).not.toBeNull();
    expect(result!.action).toBe("failed");
    expect(result!.failureReason).toBe("mutation_failed");
    // Must NOT be "bootstrapped" — the mutation didn't actually apply
    expect(result!.action).not.toBe("bootstrapped");
  });

  it("still returns null for idempotency (state:* already present)", async () => {
    const issue = makeIssueContext({
      labels: [
        { id: WF_LABEL_ID, name: WF_LABEL_NAME },
        { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
      ],
    });

    const result = await applyBootstrapToIssue(issue, "***", WORKFLOW_REGISTRY as never);

    // Already enrolled → null (not a failure, just idempotent)
    expect(result).toBeNull();
  });

  it("still returns null when no wf:* label (not an enrollment)", async () => {
    const issue = makeIssueContext({ labels: [] });

    const result = await applyBootstrapToIssue(issue, "***", WORKFLOW_REGISTRY as never);

    expect(result).toBeNull();
  });
});

// ── AC1: wf:* add during webhook outage → sweep heals (both labels) ──────

describe("AC1: wf:* add during simulated webhook outage → ticket is not permanently deadlocked", () => {
  it("sweep heals wf:*-present / state:*-absent ticket — both labels land", async () => {
    // Simulate: human added wf:* via Linear UI, webhook outage means bootstrap
    // never fired. Ticket sits with wf:* only for 10 minutes.
    const mutationCalls: string[] = [];
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate")) {
        mutationCalls.push(body);
      }
      return makeSweepFetch({
        unenrolledTickets: [
          {
            id: ISSUE_ID,
            identifier: ISSUE_IDENTIFIER,
            updatedAt: OLD_TIMESTAMP, // 10 min ago — past grace window
            labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
            delegateId: null,
            teamId: TEAM_ID,
          },
        ],
      })(url, init);
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "***",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // The ticket was healed — state:* label was applied atomically with wf:*
    expect(result.healed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // The issueUpdate mutation was issued (adding state:intake)
    expect(mutationCalls.length).toBeGreaterThanOrEqual(1);
    const combinedMutations = mutationCalls.join("\n");
    expect(combinedMutations).toContain(STATE_INTAKE_LABEL_ID);

    // Wake was dispatched to the delegate
    expect(wakeDispatches.length).toBeGreaterThanOrEqual(1);

    // A heal alert was emitted (visible evidence)
    const healAlerts = alerts.filter((a) => a.source === "bootstrap-reconciled");
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
    expect(healAlerts[0].severity).toBe("warning");
    expect(healAlerts[0].title).toContain(ISSUE_IDENTIFIER);
  });

  it("sweep rejects with visible error when workflow def is missing", async () => {
    // Simulate: wf:* label added for a non-existent workflow, webhook outage.
    // The sweep finds the ticket but can't heal (no workflow def).
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeSweepFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID,
          identifier: ISSUE_IDENTIFIER,
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: "wf:nonexistent-workflow" }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    // Empty registry — no defs at all
    const emptyRegistry = new Map<string, unknown>();

    const result = await runBootstrapReconciliationSweep({
      authToken: "***",
      workflowRegistry: emptyRegistry as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    // Not healed — the sweep rejected the enrollment
    expect(result.healed).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    // A rejection alert was emitted (visible evidence of failure)
    const rejectAlerts = alerts.filter(
      (a) => a.source === "bootstrap-reconciliation-rejected",
    );
    expect(rejectAlerts.length).toBeGreaterThanOrEqual(1);
    expect(rejectAlerts[0].severity).toBe("warning");
    expect(rejectAlerts[0].title).toContain(ISSUE_IDENTIFIER);

    // Alert detail includes the failure reason
    const detail = rejectAlerts[0].detail as Record<string, unknown> | undefined;
    expect(detail?.reason).toBe("no_workflow_def");
  });

  it("sweep rejects with visible error when mutation fails", async () => {
    // Simulate: wf:* added, webhook outage, sweep runs but Linear API mutation fails
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeSweepFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID,
          identifier: ISSUE_IDENTIFIER,
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
      mutationSuccess: false,
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "***",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.healed).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const rejectAlerts = alerts.filter(
      (a) => a.source === "bootstrap-reconciliation-rejected",
    );
    expect(rejectAlerts.length).toBeGreaterThanOrEqual(1);
    const detail = rejectAlerts[0].detail as Record<string, unknown> | undefined;
    expect(detail?.reason).toBe("mutation_failed");
  });
});

// ── AC2: Sweep heals enrollment-gap without webhook (discrepancy evidence) ─

describe("AC2: reconciliation sweep heals wf:*-present / state:*-absent — discrepancy resolution", () => {
  it("the sweep queries for wf:* labeled tickets and filters for no state:* — covers enrollment-gap shape", async () => {
    /**
     * Discrepancy resolution (AI-1836 deliverable 2):
     *
     * Grover's AI-1815 statement: "The AI-1775 reconciliation sweep can't heal
     * this case: it heals wf-labeled tickets that never enrolled, but here the
     * wf:* label itself was stripped, making the ticket invisible to the sweep."
     *
     * This is CORRECT for AI-1815's scenario (label strip by liveness reset
     * removed wf:*, so sweep can't find the ticket). But AI-1836's scenario
     * is different: the ENROLLMENT GAP (wf:* present, state:* absent due to
     * dropped webhook). In this case wf:* IS present, so the sweep CAN and
     * DOES find and heal the ticket.
     *
     * Evidence: the sweep's query uses `labels: { some: { name: { startsWith:
     * "wf:" } } }` (all wf:* labeled issues), then filters client-side for no
     * state:* label and past grace window. This matches the exact shape
     * described in AI-1836.
     */

    const wakeDispatches: string[] = [];
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeSweepFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID,
          identifier: ISSUE_IDENTIFIER,
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "***",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async (_, id) => wakeDispatches.push(id),
    });

    // Sweep found and healed the enrollment-gap ticket
    expect(result.scanned).toBe(1);
    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0]).toBe(ISSUE_IDENTIFIER);

    // Heal alert confirms the sweep processed this exact shape
    const healAlerts = alerts.filter((a) => a.source === "bootstrap-reconciled");
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
    const detail = healAlerts[0].detail as Record<string, unknown>;
    expect(detail.workflow).toBe("dev-impl");
    expect(detail.entryState).toBe("intake");
  });

  it("sweep skips ticket within grace window — webhook may still arrive", async () => {
    // A ticket just updated (30s ago) should not be healed — the webhook
    // may still be in transit.
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    const freshTimestamp = new Date(Date.now() - 30 * 1000).toISOString();

    globalThis.fetch = makeSweepFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID,
          identifier: ISSUE_IDENTIFIER,
          updatedAt: freshTimestamp,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "***",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async (_, id) => wakeDispatches.push(id),
      graceWindowMs: 2 * 60 * 1000,
    });

    // Not healed — within grace window
    expect(result.healed).toBe(0);
    expect(result.withinGrace).toBe(1);
    expect(wakeDispatches).toHaveLength(0);
  });
});
