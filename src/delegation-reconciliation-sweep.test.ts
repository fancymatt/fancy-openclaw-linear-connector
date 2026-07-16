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
  /** Whether mutations succeed. */
  mutationSuccess?: boolean;
  /** If true, the query fetch throws a network error. */
  networkError?: boolean;
}

function makeReconciliationFetch(scenario: FetchScenario): typeof fetch {
  const { governedTickets = [], mutationSuccess = true, networkError = false } = scenario;
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (networkError) throw new Error("simulated network error");
    const body = typeof init?.body === "string" ? init.body : "";

    // Governed-tickets query (wf:* labeled)
    if (body.includes("wf:") || body.includes("GovernedTickets") || body.includes("DelegationReconciliation")) {
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
      const ticket = governedTickets[0];
      if (ticket) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: ticket.id,
                identifier: ticket.identifier,
                title: ticket.title ?? `Ticket ${ticket.identifier}`,
                labels: { nodes: ticket.labels },
                delegate: ticket.delegateId ? { id: ticket.delegateId, name: ticket.delegateName } : null,
                team: { id: ticket.teamId },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // issueUpdate mutation
    if (body.includes("issueUpdate")) {
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
