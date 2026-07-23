/**
 * AI-1807 — Failing tests for the delegation reconciliation sweep.
 *
 * Problem: when Linear webhook ingress is down, every delegation made during
 * the gap strands silently — the delegate-change webhook never reaches the
 * connector, so no wake is dispatched. Existing sweeps (bootstrap
 * reconciliation, rescue, stuck-delegate, no-activity) do not catch this
 * class because the ticket is enrolled AND has a delegate AND the agent has
 * not been dispatched.
 *
 * This test suite covers the delegation-reconciliation sweep + admin
 * /redispatch endpoint.
 *
 * AC-to-test mapping:
 *   AC1: periodic sweep detects governed, non-terminal tickets whose current
 *        delegate has no dispatch record since delegation → re-dispatches the
 *        standard delegation wake through the normal delivery path.
 *   AC2: sweep also detects wf-labeled tickets with no state:* label AND no
 *        delegate (dropped enrollment webhooks) → routes through the normal
 *        bootstrap path (complementing, not duplicating, AI-1775).
 *   AC3: each heal emits an operational event AND an alert-bus notify; failures
 *        alert rather than dying silently.
 *   AC4: idempotent — ticket whose delegate was already woken (dispatch record
 *        exists) is never re-woken.
 *   AC5: POST /redispatch (ADMIN_SECRET-gated) triggers the same reconciliation
 *        on demand for a single ticket or a time window.
 *   AC6: sweep is registered at server bootstrap (index.ts) — proven by
 *        integration test in delegation-reconciliation-wiring.test.ts.
 *   AC7: liveness is observable at ac-validate via /health crons field
 *        (enforced by the cron registry + /health contract, asserted in
 *        delegation-reconciliation-wiring.test.ts).
 *
 * These tests MUST be RED until the implementation lands.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";

// The implementation module does not exist yet — these tests will fail at
// import time with a resolution error (RED). When the implementation ships,
// the imports will resolve and the assertions will exercise the production code.
import {
  runDelegationReconciliationSweep,
  registerDelegationReconciliationCron,
  type DelegationReconciliationOptions,
  type DelegationReconciliationResult,
} from "./delegation-reconciliation-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { resetCronRegistryForTest, getRegisteredCrons } from "./cron/registry.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const TEAM_ID = "team-uuid-test";
const DELEGATE_LINEAR_ID = "igor-linear-uuid";
const DELEGATE_AGENT_NAME = "igor";
const OLD_TIMESTAMP = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
const FRESH_TIMESTAMP = new Date(Date.now() - 30 * 1000).toISOString();   // 30 sec ago

/** Terminals that the sweep must skip. */
const TERMINAL_STATES = ["done", "escape"];

/** Ticket shapes returned by the Linear API mock. */
interface MockTicket {
  id: string;
  identifier: string;
  updatedAt: string;
  labels: Array<{ id: string; name: string }>;
  delegateId: string | null;
  delegateName: string | null;
  teamId: string;
  title?: string;
}

const WF_LABEL = { id: "label-wf-dev-impl", name: "wf:dev-impl" };
const STATE_IMPLEMENTATION_LABEL = { id: "label-state-implementation", name: "state:implementation" };
const STATE_DONE_LABEL = { id: "label-state-done", name: "state:done" };

/** Default page size for paginated mock fetches. */
const PAGE_SIZE = 5;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestAlertBus(): {
  bus: AlertBus;
  alerts: Array<import("./alerts/alert-store.js").AlertInput>;
} {
  const collected: Array<import("./alerts/alert-store.js").AlertInput> = [];
  const store = new AlertStore(":memory:");
  const bus = new AlertBus({
    store,
    pushEnabled: false,
    now: () => new Date(),
  });
  const originalNotify = bus.notify.bind(bus);
  jest.spyOn(bus, "notify").mockImplementation((alert) => {
    collected.push(alert);
    originalNotify(alert);
  });
  return { bus, alerts: collected };
}

function makeEventStore(): OperationalEventStore {
  return new OperationalEventStore(":memory:");
}

interface FetchScenario {
  /** Tickets returned by the governed-tickets query. */
  governedTickets?: MockTicket[];
  /** Tickets returned by the ad-hoc (non-wf:*) delegated tickets query. */
  adhocDelegatedTickets?: MockTicket[];
  /** Captures labelIds sent by enrollment/update mutations. */
  labelUpdates?: string[][];
  /** Whether mutations succeed. */
  mutationSuccess?: boolean;
  /** If true, the query fetch throws a network error. */
  networkError?: boolean;
}

function makeReconciliationFetch(scenario: FetchScenario): typeof fetch {
  const { governedTickets = [], adhocDelegatedTickets = [], labelUpdates, mutationSuccess = true, networkError = false } = scenario;
  const allTickets = [...governedTickets, ...adhocDelegatedTickets];
  const labelsByIssueId = new Map<string, Array<{ id: string; name: string }>>();
  for (const ticket of allTickets) {
    labelsByIssueId.set(ticket.id, [...ticket.labels]);
  }

  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (networkError) throw new Error("simulated network error");
    const body = typeof init?.body === "string" ? init.body : "";
    const parsed = body ? JSON.parse(body) as { variables?: Record<string, unknown> } : {};
    const variables = parsed.variables ?? {};

    // Ad-hoc delegated-tickets query (non-wf:* tickets with delegate set)
    if (body.includes("AdhocDelegationReconciliation")) {
      // INF-334: Simulate GraphQL validation error for schema-illegal filters.
      // Re-enable this check to verify the production code no longer sends these fields.
      if (body.includes("none:") || body.includes("isSet:")) {
        return new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "Field 'none' is not defined by type 'IssueLabelCollectionFilter'" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      const nodes = adhocDelegatedTickets.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: t.updatedAt,
        title: t.title ?? `Ticket ${t.identifier}`,
        labels: { nodes: t.labels },
        delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
        team: { id: t.teamId },
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Governed-tickets query (wf:* labeled)
    if (body.includes("DelegationReconciliation") && !body.includes("AdhocDelegationReconciliation") || body.includes("wf:") || body.includes("GovernedTickets")) {
      const nodes = governedTickets.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: t.updatedAt,
        title: t.title ?? `Ticket ${t.identifier}`,
        labels: { nodes: t.labels },
        delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
        team: { id: t.teamId },
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Issue re-fetch
    if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
      const requestedId = variables.id as string | undefined;
      const ticket =
        allTickets.find((t) => t.id === requestedId || t.identifier === requestedId) ??
        allTickets[0];
      if (ticket) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: ticket.id,
                identifier: ticket.identifier,
                title: ticket.title ?? `Ticket ${ticket.identifier}`,
                labels: { nodes: labelsByIssueId.get(ticket.id) ?? ticket.labels },
                delegate: ticket.delegateId ? { id: ticket.delegateId, name: ticket.delegateName } : null,
                team: { id: ticket.teamId },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (body.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-wf-task", name: "wf:task", isGroup: false, team: { id: TEAM_ID }, parent: null },
                  { id: "label-state-doing", name: "state:doing", isGroup: false, team: { id: TEAM_ID }, parent: null },
                  { id: WF_LABEL.id, name: WF_LABEL.name, isGroup: false, team: { id: TEAM_ID }, parent: null },
                  { id: STATE_IMPLEMENTATION_LABEL.id, name: STATE_IMPLEMENTATION_LABEL.name, isGroup: false, team: { id: TEAM_ID }, parent: null },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // issueUpdate mutation
    if (body.includes("ApplyAtomicTransition") || body.includes("issueUpdate")) {
      const issueId = variables.issueId as string | undefined;
      const labelIds = variables.labelIds as string[] | undefined;
      if (issueId && Array.isArray(labelIds)) {
        labelUpdates?.push(labelIds);
        const namesById = new Map<string, string>([
          ["label-wf-task", "wf:task"],
          ["label-state-doing", "state:doing"],
          [WF_LABEL.id, WF_LABEL.name],
          [STATE_IMPLEMENTATION_LABEL.id, STATE_IMPLEMENTATION_LABEL.name],
          [STATE_DONE_LABEL.id, STATE_DONE_LABEL.name],
        ]);
        labelsByIssueId.set(
          issueId,
          labelIds.map((id) => ({ id, name: namesById.get(id) ?? id })),
        );
      }
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-reconciliation-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  savedFetch = globalThis.fetch;
  resetCronRegistryForTest();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  jest.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// AC1: Periodic sweep detects governed, non-terminal tickets whose current
//      delegate has no dispatch record since delegation, and re-dispatches.
// ══════════════════════════════════════════════════════════════════════════

describe("AC1: sweep detects stranded delegations and re-dispatches", () => {
  it("re-dispatches a wake for a governed, non-terminal ticket with no dispatch record", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].agentName).toBe(DELEGATE_AGENT_NAME);
    expect(wakeDispatches[0].ticketIdentifier).toBe("AI-1807");
    eventStore.close();
  });

  it("does not re-dispatch a ticket that already has a dispatch record (idempotent)", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    // Seed a dispatch record for this ticket+delegate combination
    eventStore.append({
      outcome: "dispatch-accepted",
      agent: DELEGATE_AGENT_NAME,
      key: `linear-AI-1807`,
      occurredAt: OLD_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // AC4: no re-wake when dispatch record exists
    expect(result.healed).toBe(0);
    expect(result.skippedIdempotent).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });

  it("re-dispatches through the normal delivery path (same as webhook delegation wake)", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // The wakeFn is the normal delivery path — it was called with the right args
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].ticketIdentifier).toBe("AI-1807");
    eventStore.close();
  });

  it("skips terminal tickets (state:done, state:escape)", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-done",
          identifier: "AI-DONE",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_DONE_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-334 AC2: Reconciliation discovers a plain delegated ticket whose
//              dispatch was missed/failed and redispatches it.
// ══════════════════════════════════════════════════════════════════════════

describe("INF-334 AC2: reconciliation redispatches missed plain delegations", () => {
  it("redispatches a plain delegated ticket with no wf:* labels and no dispatch record", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      adhocDelegatedTickets: [
        {
          id: "issue-plain-missed",
          identifier: "DSN-334",
          updatedAt: OLD_TIMESTAMP,
          labels: [],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toEqual([
      { agentName: DELEGATE_AGENT_NAME, ticketIdentifier: "DSN-334" },
    ]);
    const events = eventStore.query({ key: "linear-DSN-334", limit: 20 });
    expect(events.some((e) =>
      e.outcome === "auto-enrolled" &&
      (e.detail as { workflowId?: string; entryState?: string } | null)?.workflowId === "task" &&
      (e.detail as { workflowId?: string; entryState?: string } | null)?.entryState === "doing",
    )).toBe(true);
    eventStore.close();
  });

  it("redispatches a plain delegated ticket when the only prior dispatch after delegation failed", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    eventStore.append({
      outcome: "delivery-failed",
      agent: DELEGATE_AGENT_NAME,
      key: "linear-DSN-335",
      occurredAt: FRESH_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      adhocDelegatedTickets: [
        {
          id: "issue-plain-failed",
          identifier: "DSN-335",
          updatedAt: OLD_TIMESTAMP,
          labels: [],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toEqual([
      { agentName: DELEGATE_AGENT_NAME, ticketIdentifier: "DSN-335" },
    ]);
    eventStore.close();
  });

  it("enrolls a plain delegated ticket even when a prior successful dispatch suppresses re-wake", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    eventStore.append({
      outcome: "dispatch-accepted",
      agent: DELEGATE_AGENT_NAME,
      key: "linear-DSN-336",
      occurredAt: FRESH_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      adhocDelegatedTickets: [
        {
          id: "issue-plain-already-dispatched",
          identifier: "DSN-336",
          updatedAt: OLD_TIMESTAMP,
          labels: [],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(0);
    expect(result.skippedIdempotent).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches).toEqual([]);
    const events = eventStore.query({ key: "linear-DSN-336", limit: 20 });
    expect(events.some((e) =>
      e.outcome === "auto-enrolled" &&
      (e.detail as { workflowId?: string; entryState?: string } | null)?.workflowId === "task" &&
      (e.detail as { workflowId?: string; entryState?: string } | null)?.entryState === "doing",
    )).toBe(true);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC2: Detects wf-labeled tickets with no state:* label AND no delegate
//      (dropped enrollment webhooks) and routes through bootstrap path.
// ══════════════════════════════════════════════════════════════════════════

describe("AC2: detects dropped enrollment webhooks (wf:* but no state:* and no delegate)", () => {
  it("heals a wf-labeled ticket with no state:* and no delegate via bootstrap path", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-unenrolled",
          identifier: "AI-1808",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL],
          delegateId: null,
          delegateName: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.bootstrapHealed).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches.length).toBeGreaterThanOrEqual(1);
    // Should have been routed through the bootstrap path (same as AI-1775)
    const healAlerts = alerts.filter((a) => a.source === "delegation-reconciled" || a.source === "bootstrap-reconciled");
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });

  it("does NOT double-heal a ticket that AI-1775's bootstrap sweep already handles", async () => {
    // A ticket with no state:* and no delegate is AI-1775's domain when the
    // bootstrap sweep runs first. This sweep should complement, not duplicate.
    // If the ticket already gained a state:* label (bootstrap already ran),
    // the delegation sweep should see it as enrolled and skip.
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    // After AI-1775 bootstrap, ticket now has state:intake + delegate set
    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-already-bootstrapped",
          identifier: "AI-1808",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    // Seed a dispatch record showing the delegate was already woken
    eventStore.append({
      outcome: "dispatch-accepted",
      agent: DELEGATE_AGENT_NAME,
      key: `linear-AI-1808`,
      occurredAt: OLD_TIMESTAMP,
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // No heal — already has delegate AND dispatch record
    expect(result.healed).toBe(0);
    expect(result.bootstrapHealed).toBe(0);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3: Each heal emits an operational event AND an alert-bus notify;
//      failures alert rather than dying silently.
// ══════════════════════════════════════════════════════════════════════════

describe("AC3: each heal emits operational event + alert-bus notify; failures alert", () => {
  it("emits an operational event when healing a stranded delegation", async () => {
    const eventStore = makeEventStore();
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    const events = eventStore.query({ key: "linear-AI-1807", limit: 20 });
    const healEvents = events.filter((e) =>
      e.outcome === "delegation-reconciled" ||
      e.outcome === "dispatch-accepted",
    );
    expect(healEvents.length).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });

  it("emits an alert-bus notify when healing a stranded delegation", async () => {
    const eventStore = makeEventStore();
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    const healAlerts = alerts.filter((a) => a.source === "delegation-reconciled");
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
    expect(healAlerts[0].severity).toBe("warning");
    // Alert must name the ticket
    const alertText = healAlerts[0].title + JSON.stringify(healAlerts[0].detail ?? "");
    expect(alertText).toContain("AI-1807");
    eventStore.close();
  });

  it("alerts (not crashes) when Linear API query fails", async () => {
    const eventStore = makeEventStore();
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({ networkError: true });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.some((a) => a.severity === "warning" || a.severity === "critical")).toBe(true);
    eventStore.close();
  });

  it("alerts when a wake dispatch fails during heal", async () => {
    const eventStore = makeEventStore();
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {
        throw new Error("simulated delivery failure");
      },
    });

    // Must alert, not throw
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const failureAlerts = alerts.filter((a) =>
      a.source === "delegation-reconciled" && (a.title.toLowerCase().includes("fail") || a.title.toLowerCase().includes("error")),
    );
    expect(failureAlerts.length).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC4: Idempotent — ticket with dispatch record is never re-woken.
// ══════════════════════════════════════════════════════════════════════════

describe("AC4: idempotent — dispatch record prevents re-wake", () => {
  it("does not re-wake when dispatch-accepted event exists after delegation timestamp", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    // Dispatch happened 5 min after the delegate was set (delegation timestamp)
    const delegationTs = OLD_TIMESTAMP;
    const dispatchTs = new Date(new Date(delegationTs).getTime() + 5 * 60 * 1000).toISOString();

    eventStore.append({
      outcome: "dispatch-accepted",
      agent: DELEGATE_AGENT_NAME,
      key: `linear-AI-1807`,
      occurredAt: dispatchTs,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: delegationTs,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(result.skippedIdempotent).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });

  it("does not re-wake when delivered event exists after delegation timestamp", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    eventStore.append({
      outcome: "delivered",
      agent: DELEGATE_AGENT_NAME,
      key: `linear-AI-1807`,
      occurredAt: OLD_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });

  it("AI-2464: does not re-wake when delivery-pending-ack event exists after delegation timestamp", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    // A connect-established abort (AI-2437): the wake is queued in the agent's
    // hands and deliver-with-ack registered an ack expectation, so the watchdog
    // owns the retry. The sweep must not race it with a duplicate dispatch.
    eventStore.append({
      outcome: "delivery-pending-ack",
      agent: DELEGATE_AGENT_NAME,
      key: `linear-AI-1807`,
      occurredAt: OLD_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });

  it("DOES re-wake when the only dispatch record is from a PREVIOUS delegation (before current delegate was set)", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    // Old dispatch from a prior delegate (sage), 2 hours ago
    const oldDispatchTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    eventStore.append({
      outcome: "dispatch-accepted",
      agent: "sage",
      key: `linear-AI-1807`,
      occurredAt: oldDispatchTs,
    });

    // Current delegate was set 30 min ago (no dispatch since)
    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP, // 30 min ago
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // Should heal — the dispatch record is from a different agent (sage), not
    // the current delegate (igor) since delegation
    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].agentName).toBe(DELEGATE_AGENT_NAME);
    eventStore.close();
  });

  it("does not re-wake on a second sweep of the same stranded ticket", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const opts: DelegationReconciliationOptions = {
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    };

    // First sweep: heals
    const r1 = await runDelegationReconciliationSweep(opts);
    expect(r1.healed).toBe(1);

    // Second sweep: the heal produced a dispatch-accepted event, so the sweep
    // should see it and skip (idempotent)
    const r2 = await runDelegationReconciliationSweep(opts);
    expect(r2.healed).toBe(0);
    expect(r2.skippedIdempotent).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC5: POST /redispatch (ADMIN_SECRET-gated) — on-demand reconciliation
// ══════════════════════════════════════════════════════════════════════════

describe("AC5: POST /redispatch admin endpoint", () => {
  // The endpoint is registered on the express app. We test via the exported
  // createApp or a test router that mounts the same handler.
  // For now, test the reconciliation function directly; the endpoint wiring
  // is covered by the wiring test (AC6).

  it("supports reconciliation for a single ticket by identifier", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      ticketIdentifiers: ["AI-1807"], // single-ticket mode
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    eventStore.close();
  });

  it("supports time-window mode (since/until) for batch reconciliation", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded-a",
          identifier: "AI-A",
          updatedAt: oneHourAgo, // within window
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
        {
          id: "issue-stranded-b",
          identifier: "AI-B",
          updatedAt: oneHourAgo, // within window
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      since: twoHoursAgo,
      until: new Date().toISOString(),
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });

  it("rejects unauthenticated requests (tested via the function's options guard)", async () => {
    // The admin endpoint itself enforces ADMIN_SECRET; the sweep function
    // should have no auth concern (it's called internally). The endpoint
    // wiring is covered in the integration test. Here we just verify the
    // function works correctly when called with proper options.
    const eventStore = makeEventStore();
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({ governedTickets: [] });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result).toBeDefined();
    expect(result.scanned).toBeGreaterThanOrEqual(0);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC6 + AC7: Bootstrap registration + cron registry liveness
// (unit-level registration test — the integration wiring test is separate)
// ══════════════════════════════════════════════════════════════════════════

describe("registerDelegationReconciliationCron: registration + liveness", () => {
  it("registers the sweep in the cron registry when called", () => {
    const timer = registerDelegationReconciliationCron({
      authToken: "test-token",
      intervalMs: 10_000,
    });

    expect(timer).toBeDefined();
    const crons = getRegisteredCrons();
    const entry = crons.find((c) => c.name === "delegation-reconciliation-sweep");
    expect(entry).toBeDefined();
    expect(entry!.schedule).toContain("m"); // contains interval text
    clearInterval(timer);
  });

  it("returns a NodeJS.Timeout and does not throw", () => {
    expect(() => {
      const timer = registerDelegationReconciliationCron({
        authToken: "test-token",
        intervalMs: 10_000,
      });
      clearInterval(timer);
    }).not.toThrow();
  });

  it("cron entry appears in getRegisteredCrons after registration (AC7 liveness)", () => {
    resetCronRegistryForTest();

    const timer = registerDelegationReconciliationCron({
      authToken: "test-token",
      intervalMs: 5 * 60 * 1000,
    });

    const crons = getRegisteredCrons();
    const entry = crons.find((c) => c.name === "delegation-reconciliation-sweep");

    // AC7: the registry entry proves liveness — /health enumerates this
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("delegation-reconciliation-sweep");
    expect(entry!.registeredAt).toBeDefined();
    expect(new Date(entry!.registeredAt).getTime()).toBeGreaterThan(0);

    clearInterval(timer);
  });

  it("respects intervalMs override", () => {
    resetCronRegistryForTest();

    const timer = registerDelegationReconciliationCron({
      authToken: "test-token",
      intervalMs: 42_000,
    });

    const crons = getRegisteredCrons();
    const entry = crons.find((c) => c.name === "delegation-reconciliation-sweep");
    expect(entry).toBeDefined();
    expect(entry!.schedule).toContain("42");
    clearInterval(timer);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Behavioral test: cron entry point wires collaborators correctly
// ══════════════════════════════════════════════════════════════════════════

describe("registerDelegationReconciliationCron: behavioral — heal produces alert + wake via cron", () => {
  it("a heal through the cron entry produces at least one alert and one wake dispatch", async () => {
    const { bus, alerts } = makeTestAlertBus();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "AI-9999",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const timer = registerDelegationReconciliationCron({
      authToken: "Bearer test-token",
      intervalMs: 50,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // Wait for the cron to tick
    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(timer);

    expect(wakeDispatches.length).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches[0].ticketIdentifier).toBe("AI-9999");

    const healAlerts = alerts.filter((a) => a.source === "delegation-reconciled");
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not dispatch when no stranded tickets exist", async () => {
    const { bus } = makeTestAlertBus();
    const wakeDispatches: string[] = [];

    globalThis.fetch = makeReconciliationFetch({ governedTickets: [] });

    const timer = registerDelegationReconciliationCron({
      authToken: "Bearer test-token",
      intervalMs: 50,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(timer);

    expect(wakeDispatches).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-287 AC1: Reconciliation sweep catches ad-hoc delegated tickets
//      (no wf:* label, has delegate, no dispatch record since delegation)
// ══════════════════════════════════════════════════════════════════════════

describe("INF-287 AC1: sweep catches ad-hoc delegated tickets (no wf:* label)", () => {
  const ADHOC_LABELS: Array<{ id: string; name: string }> = [];
  const ADHOC_DELEGATE_ID = "sage-linear-uuid-adhoc";
  const ADHOC_DELEGATE_NAME = "sage";

  it("re-dispatches a wake for an ad-hoc ticket with delegate but no dispatch record", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-stranded",
          identifier: "ADHOC-1",
          updatedAt: OLD_TIMESTAMP,
          labels: ADHOC_LABELS,
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].agentName).toBe(ADHOC_DELEGATE_NAME);
    expect(wakeDispatches[0].ticketIdentifier).toBe("ADHOC-1");
    eventStore.close();
  });

  it("skips ad-hoc ticket that already has a dispatch record (idempotent)", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    eventStore.append({
      outcome: "dispatch-accepted",
      agent: ADHOC_DELEGATE_NAME,
      key: "linear-ADHOC-1",
      occurredAt: OLD_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-stranded",
          identifier: "ADHOC-1",
          updatedAt: OLD_TIMESTAMP,
          labels: ADHOC_LABELS,
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(result.skippedIdempotent).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });

  it("skips terminal ad-hoc tickets (state:done)", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-done",
          identifier: "ADHOC-DONE",
          updatedAt: OLD_TIMESTAMP,
          labels: [STATE_DONE_LABEL],
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });

  it("handles mixed governed + ad-hoc tickets in a single sweep", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-stranded",
          identifier: "WF-1",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-stranded",
          identifier: "ADHOC-1",
          updatedAt: OLD_TIMESTAMP,
          labels: ADHOC_LABELS,
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // Both should be healed: WF-1 (governed) and ADHOC-1 (ad-hoc)
    expect(result.healed).toBe(2);
    expect(wakeDispatches).toHaveLength(2);

    const wokenIds = wakeDispatches.map((d) => d.ticketIdentifier).sort();
    expect(wokenIds).toEqual(["ADHOC-1", "WF-1"]);
    eventStore.close();
  });

  it("does not process ad-hoc tickets with no delegate set", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-no-delegate",
          identifier: "ADHOC-ND",
          updatedAt: OLD_TIMESTAMP,
          labels: ADHOC_LABELS,
          delegateId: null,
          delegateName: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // No delegate means no wake — the sweep should not process this ticket
    expect(result.healed).toBe(0);
    expect(wakeDispatches).toHaveLength(0);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-287 AC2: POST /redispatch and POST /admin/api/redispatch cover
//      ad-hoc tickets
// ══════════════════════════════════════════════════════════════════════════

describe("INF-287 AC2: redispatch covers ad-hoc delegated tickets", () => {
  const ADHOC_LABELS: Array<{ id: string; name: string }> = [];
  const ADHOC_DELEGATE_ID = "sage-linear-uuid-adhoc";
  const ADHOC_DELEGATE_NAME = "sage";

  it("supports single-ticket redispatch for an ad-hoc ticket by identifier", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-stranded",
          identifier: "ADHOC-REDISPATCH",
          updatedAt: OLD_TIMESTAMP,
          labels: ADHOC_LABELS,
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    // Single-ticket mode via ticketIdentifiers
    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      ticketIdentifiers: ["ADHOC-REDISPATCH"],
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].ticketIdentifier).toBe("ADHOC-REDISPATCH");
    eventStore.close();
  });

  it("supports time-window redispatch that includes ad-hoc tickets", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-window",
          identifier: "ADHOC-WIN",
          updatedAt: oneHourAgo,
          labels: ADHOC_LABELS,
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      since: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      until: new Date().toISOString(),
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0]).toBe("ADHOC-WIN");
    eventStore.close();
  });

  it("redispatch scanned count includes ad-hoc tickets alongside governed tickets", async () => {
    const eventStore = makeEventStore();
    const { bus } = makeTestAlertBus();

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Only one ticket should be healable — the ad-hoc one has dispatch record
    eventStore.append({
      outcome: "dispatch-accepted",
      agent: DELEGATE_AGENT_NAME,
      key: "linear-WF-SCANNED",
      occurredAt: OLD_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-gov-scanned",
          identifier: "WF-SCANNED",
          updatedAt: oneHourAgo,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-scanned",
          identifier: "ADHOC-SCANNED",
          updatedAt: oneHourAgo,
          labels: ADHOC_LABELS,
          delegateId: ADHOC_DELEGATE_ID,
          delegateName: ADHOC_DELEGATE_NAME,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    // Both wf:* and ad-hoc tickets should be scanned
    expect(result.scanned).toBe(2);
    // The governed WF-SCANNED has a dispatch record → skipped by idempotency
    // The ad-hoc ADHOC-SCANNED has no dispatch record → healed
    expect(result.healed).toBe(1);
    expect(result.skippedIdempotent).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-287 AC3: Existing wf:* reconciliation behavior unchanged
//      (regression guard — existing AC1-AC7 tests still pass with ad-hoc
//       query added)
// ══════════════════════════════════════════════════════════════════════════

describe("INF-287 AC3: existing wf:* reconciliation unchanged with ad-hoc extension", () => {
  it("still heals governed (wf:*) stranded tickets alongside ad-hoc tickets", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-gov-stranded",
          identifier: "AI-1807",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
      // Also provide ad-hoc tickets to verify they don't interfere
      adhocDelegatedTickets: [],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // AC1 behavior preserved: single governed ticket healed
    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].ticketIdentifier).toBe("AI-1807");
    eventStore.close();
  });

  it("still heals dropped enrollment (wf:*, no state:*, no delegate) via bootstrap path", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-unenrolled",
          identifier: "AI-1808",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL],
          delegateId: null,
          delegateName: null,
          teamId: TEAM_ID,
        },
      ],
      adhocDelegatedTickets: [],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // AC2 behavior preserved: bootstrap heal still works
    expect(result.bootstrapHealed).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches.length).toBeGreaterThanOrEqual(1);
    const healAlerts = alerts.filter(
      (a) => a.source === "delegation-reconciled" || a.source === "bootstrap-reconciled",
    );
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
    eventStore.close();
  });

  it("ad-hoc extension does not interfere with idempotency checks on governed tickets", async () => {
    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    // Seed a dispatch record for the governed ticket
    eventStore.append({
      outcome: "dispatch-accepted",
      agent: DELEGATE_AGENT_NAME,
      key: "linear-WF-IDEMP",
      occurredAt: OLD_TIMESTAMP,
    });

    globalThis.fetch = makeReconciliationFetch({
      governedTickets: [
        {
          id: "issue-gov-idemp",
          identifier: "WF-IDEMP",
          updatedAt: OLD_TIMESTAMP,
          labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
          delegateId: DELEGATE_LINEAR_ID,
          delegateName: DELEGATE_AGENT_NAME,
          teamId: TEAM_ID,
        },
      ],
      adhocDelegatedTickets: [
        {
          id: "issue-adhoc-stranded",
          identifier: "ADHOC-FRESH",
          updatedAt: OLD_TIMESTAMP,
          labels: [],
          delegateId: "sage-uuid",
          delegateName: "sage",
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // The governed ticket is idempotent (skipped), the ad-hoc ticket is fresh (healed)
    expect(result.skippedIdempotent).toBeGreaterThanOrEqual(1);
    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0]).toBe("ADHOC-FRESH");
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-332 AC1: Pagination — queryGovernedTickets must iterate all pages via
//      first: + after: cursor + pageInfo.hasNextPage loop.
//      Without pagination, any ticket beyond the default page-1 slice is invisible.
// ══════════════════════════════════════════════════════════════════════════

describe("INF-332 AC1: queryGovernedTickets returns all tickets across paginated pages", () => {

  /** Mock fetch that simulates paginated GraphQL for the governed-tickets query.
   *
   * Recognizes `first:` / `after:` params in the query body. Returns
   * PAGE_SIZE (5) tickets per page with pageInfo.hasNextPage and pageInfo.endCursor.
   * If the implementation does NOT include first:/after:, all tickets are returned
   * at once — the paginated mock only hands out one page per call, proving
   * the implementation must loop.
   */
  function makePaginatedGovernedFetch(totalTickets: MockTicket[]): typeof fetch {
    return async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";

      // Only intercept the governed-tickets query — exclude AdhocDelegationReconciliation
      if (body.includes("AdhocDelegationReconciliation") || (!body.includes("DelegationReconciliation") && !body.includes("wf:"))) {
        // Pass through for other queries (issue re-fetch, issueUpdate, history)
        if (body.includes("IssueContext") || body.includes("IssueWithLabels")) {
          const ticket = totalTickets[0];
          if (ticket) {
            return new Response(
              JSON.stringify({
                data: {
                  issue: {
                    id: ticket.id,
                    identifier: ticket.identifier,
                    title: ticket.title ?? `Ticket ${ticket.identifier}`,
                    labels: { nodes: ticket.labels },
                    delegate: ticket.delegateId
                      ? { id: ticket.delegateId, name: ticket.delegateName }
                      : null,
                    team: { id: ticket.teamId },
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        if (body.includes("issueUpdate")) {
          return new Response(
            JSON.stringify({ data: { issueUpdate: { success: true } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (body.includes("TicketDelegateHistory")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  history: { nodes: [] },
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
      }

      // Parse pagination params from the query body
      const afterMatch = body.match(/after:\s*"([^"]*)"/);
      const after = afterMatch?.[1] ?? null;
      const firstMatch = body.match(/first:\s*(\d+)/);
      const first = firstMatch ? parseInt(firstMatch[1], 10) : PAGE_SIZE;

      // Determine slice position from cursor
      let startIdx = 0;
      if (after !== null) {
        startIdx = parseInt(after, 10) + 1;
      }
      const page = totalTickets.slice(startIdx, startIdx + first);
      const nextStart = startIdx + first;
      const hasNextPage = nextStart < totalTickets.length;
      const endCursor = hasNextPage ? String(nextStart - 1) : null;

      const nodes = page.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: t.updatedAt,
        title: t.title ?? `Ticket ${t.identifier}`,
        labels: { nodes: t.labels },
        delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
        team: { id: t.teamId },
      }));

      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes,
              pageInfo: { hasNextPage, endCursor },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  }

  it("processes all governed tickets when results span multiple pages (first: + after: cursor loop)", async () => {
    // 13 governed tickets across 3 pages (5 + 5 + 3) — all stranded
    // (no dispatch record, non-terminal). Expected: all 13 scanned, all 13 healed.
    const tickets: MockTicket[] = Array.from({ length: 13 }, (_, i) => ({
      id: `gov-page-${i}`,
      identifier: `GOV-${100 + i}`,
      updatedAt: OLD_TIMESTAMP,
      labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
      delegateId: DELEGATE_LINEAR_ID,
      delegateName: DELEGATE_AGENT_NAME,
      teamId: TEAM_ID,
    }));

    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makePaginatedGovernedFetch(tickets);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // If pagination is missing (no first:/after: loop), only the first
    // page (5 tickets) would be scanned, not all 13.
    expect(result.scanned).toBe(13);
    expect(result.healed).toBe(13);
    expect(wakeDispatches).toHaveLength(13);
    eventStore.close();
  });

  it("handles empty governed-ticket results gracefully (zero pages)", async () => {
    const eventStore = makeEventStore();
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makePaginatedGovernedFetch([]);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.scanned).toBe(0);
    expect(result.healed).toBe(0);
    expect(result.errors).toHaveLength(0);
    eventStore.close();
  });

  it("handles single-page governed results correctly", async () => {
    const tickets: MockTicket[] = Array.from({ length: 3 }, (_, i) => ({
      id: `gov-single-${i}`,
      identifier: `GOV-SINGLE-${i}`,
      updatedAt: OLD_TIMESTAMP,
      labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
      delegateId: DELEGATE_LINEAR_ID,
      delegateName: DELEGATE_AGENT_NAME,
      teamId: TEAM_ID,
    }));

    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makePaginatedGovernedFetch(tickets);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.scanned).toBe(3);
    expect(result.healed).toBe(3);
    expect(wakeDispatches).toHaveLength(3);
    eventStore.close();
  });

  it("single-ticket mode (ticketIdentifiers) works with paginated governed results", async () => {
    const tickets: MockTicket[] = Array.from({ length: 10 }, (_, i) => ({
      id: `gov-ti-${i}`,
      identifier: `GOV-TI-${i}`,
      updatedAt: OLD_TIMESTAMP,
      labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
      delegateId: DELEGATE_LINEAR_ID,
      delegateName: DELEGATE_AGENT_NAME,
      teamId: TEAM_ID,
    }));

    // Add the target ticket
    tickets.push({
      id: "gov-target",
      identifier: "GOV-TARGET",
      updatedAt: OLD_TIMESTAMP,
      labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
      delegateId: DELEGATE_LINEAR_ID,
      delegateName: DELEGATE_AGENT_NAME,
      teamId: TEAM_ID,
    });

    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makePaginatedGovernedFetch(tickets);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      ticketIdentifiers: ["GOV-TARGET"],
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // All pages still fetched for client-side filter; exactly 1 target healed
    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0]).toBe("GOV-TARGET");
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-332 AC2: Pagination — queryAdhocDelegatedTickets must iterate all pages
// ══════════════════════════════════════════════════════════════════════════

describe("INF-332 AC2: queryAdhocDelegatedTickets returns all tickets across paginated pages", () => {

  function makePaginatedAdhocFetch(totalTickets: MockTicket[]): typeof fetch {
    return async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";

      // Only intercept the ad-hoc query
      if (!body.includes("AdhocDelegationReconciliation")) {
        // Pass through for other queries
        if (body.includes("IssueContext") || body.includes("IssueWithLabels")) {
          const ticket = totalTickets[0];
          if (ticket) {
            return new Response(
              JSON.stringify({
                data: {
                  issue: {
                    id: ticket.id,
                    identifier: ticket.identifier,
                    title: ticket.title ?? `Ticket ${ticket.identifier}`,
                    labels: { nodes: ticket.labels },
                    delegate: ticket.delegateId
                      ? { id: ticket.delegateId, name: ticket.delegateName }
                      : null,
                    team: { id: ticket.teamId },
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        if (body.includes("issueUpdate")) {
          return new Response(
            JSON.stringify({ data: { issueUpdate: { success: true } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (body.includes("TicketDelegateHistory")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  history: { nodes: [] },
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
      }

      // Parse pagination params
      const afterMatch = body.match(/after:\s*"([^"]*)"/);
      const after = afterMatch?.[1] ?? null;
      const firstMatch = body.match(/first:\s*(\d+)/);
      const first = firstMatch ? parseInt(firstMatch[1], 10) : PAGE_SIZE;

      let startIdx = 0;
      if (after !== null) {
        startIdx = parseInt(after, 10) + 1;
      }
      const page = totalTickets.slice(startIdx, startIdx + first);
      const nextStart = startIdx + first;
      const hasNextPage = nextStart < totalTickets.length;
      const endCursor = hasNextPage ? String(nextStart - 1) : null;

      const nodes = page.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: t.updatedAt,
        title: t.title ?? `Ticket ${t.identifier}`,
        labels: { nodes: t.labels },
        delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
        team: { id: t.teamId },
      }));

      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes,
              pageInfo: { hasNextPage, endCursor },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  }

  it("processes all ad-hoc delegated tickets across multiple pages", async () => {
    const tickets: MockTicket[] = Array.from({ length: 12 }, (_, i) => ({
      id: `adhoc-page-${i}`,
      identifier: `ADHOC-${100 + i}`,
      updatedAt: OLD_TIMESTAMP,
      labels: [],
      delegateId: `delegate-uuid-${i}`,
      delegateName: `agent-${i}`,
      teamId: TEAM_ID,
    }));

    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makePaginatedAdhocFetch(tickets);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.scanned).toBe(12);
    expect(result.healed).toBe(12);
    expect(wakeDispatches).toHaveLength(12);
    eventStore.close();
  });

  it("handles empty ad-hoc results gracefully", async () => {
    const eventStore = makeEventStore();
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makePaginatedAdhocFetch([]);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.scanned).toBe(0);
    expect(result.errors).toHaveLength(0);
    eventStore.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// INF-332 AC3: Combined governed + ad-hoc pagination works together
// ══════════════════════════════════════════════════════════════════════════

function makeCombinedPaginatedFetch(
  governedTickets: MockTicket[],
  adhocTickets: MockTicket[],
): typeof fetch {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";

    // Ad-hoc query — paginated
    if (body.includes("AdhocDelegationReconciliation")) {
      const afterMatch = body.match(/after:\s*"([^"]*)"/);
      const after = afterMatch?.[1] ?? null;
      const firstMatch = body.match(/first:\s*(\d+)/);
      const first = firstMatch ? parseInt(firstMatch[1], 10) : PAGE_SIZE;

      let startIdx = 0;
      if (after !== null) startIdx = parseInt(after, 10) + 1;
      const page = adhocTickets.slice(startIdx, startIdx + first);
      const nextStart = startIdx + first;
      const hasNextPage = nextStart < adhocTickets.length;
      const endCursor = hasNextPage ? String(nextStart - 1) : null;

      return new Response(JSON.stringify({
        data: { issues: {
          nodes: page.map((t) => ({
            id: t.id, identifier: t.identifier, updatedAt: t.updatedAt,
            title: t.title ?? `Ticket ${t.identifier}`,
            labels: { nodes: t.labels },
            delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
            team: { id: t.teamId },
          })),
          pageInfo: { hasNextPage, endCursor },
        }},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Governed query — paginated
    if (body.includes("DelegationReconciliation") || body.includes("wf:")) {
      const afterMatch = body.match(/after:\s*"([^"]*)"/);
      const after = afterMatch?.[1] ?? null;
      const firstMatch = body.match(/first:\s*(\d+)/);
      const first = firstMatch ? parseInt(firstMatch[1], 10) : PAGE_SIZE;

      let startIdx = 0;
      if (after !== null) startIdx = parseInt(after, 10) + 1;
      const page = governedTickets.slice(startIdx, startIdx + first);
      const nextStart = startIdx + first;
      const hasNextPage = nextStart < governedTickets.length;
      const endCursor = hasNextPage ? String(nextStart - 1) : null;

      return new Response(JSON.stringify({
        data: { issues: {
          nodes: page.map((t) => ({
            id: t.id, identifier: t.identifier, updatedAt: t.updatedAt,
            title: t.title ?? `Ticket ${t.identifier}`,
            labels: { nodes: t.labels },
            delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
            team: { id: t.teamId },
          })),
          pageInfo: { hasNextPage, endCursor },
        }},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Pass through for other calls
    if (body.includes("IssueContext") || body.includes("IssueWithLabels")) {
      const all = [...governedTickets, ...adhocTickets];
      const t = all[0];
      if (t) return new Response(JSON.stringify({
        data: { issue: {
          id: t.id, identifier: t.identifier,
          title: t.title ?? `Ticket ${t.identifier}`,
          labels: { nodes: t.labels },
          delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
          team: { id: t.teamId },
        }},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (body.includes("issueUpdate")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (body.includes("TicketDelegateHistory")) {
      return new Response(JSON.stringify({ data: { issue: { history: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ data: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("INF-332 AC3: Combined governed + ad-hoc pagination works together", () => {
  it("scanned count includes all governed and ad-hoc tickets when both span multiple pages", async () => {
    const governedTickets: MockTicket[] = Array.from({ length: 7 }, (_, i) => ({
      id: `combogov-${i}`,
      identifier: `CG-${100 + i}`,
      updatedAt: OLD_TIMESTAMP,
      labels: [WF_LABEL, STATE_IMPLEMENTATION_LABEL],
      delegateId: DELEGATE_LINEAR_ID,
      delegateName: DELEGATE_AGENT_NAME,
      teamId: TEAM_ID,
    }));

    const adhocTickets: MockTicket[] = Array.from({ length: 8 }, (_, i) => ({
      id: `comboadhoc-${i}`,
      identifier: `CA-${200 + i}`,
      updatedAt: OLD_TIMESTAMP,
      labels: [],
      delegateId: `adhoc-uuid-${i}`,
      delegateName: `adhoc-agent-${i}`,
      teamId: TEAM_ID,
    }));

    const eventStore = makeEventStore();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeCombinedPaginatedFetch(governedTickets, adhocTickets);

    const result = await runDelegationReconciliationSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // 7 governed + 8 ad-hoc = 15 total across multiple pages
    expect(result.scanned).toBe(15);
    expect(result.healed).toBe(15);
    expect(wakeDispatches).toHaveLength(15);
    eventStore.close();
  });
});
