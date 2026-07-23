/**
 * INF-356 — Wire the health pipeline end-to-end.
 *
 * These tests intentionally exercise the live app route. They require
 * /health/snapshot to enumerate tracked Linear tickets, pull INF-316 liveness
 * observations, evaluate INF-317 contracts, classify INF-319 breaches, and
 * attach INF-320 remediation state. Returning [] is only valid when the live
 * producer proves there are no tracked tasks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { jest } from "@jest/globals";
import { createApp } from "../index.js";
import { reloadAgents } from "../agents.js";
import { DispatchRecordStore } from "../liveness-channel/dispatch-record-store.js";
import { resetRemediationStateForTest } from "../remediation/remediation-state.js";

const NOW = new Date("2026-07-22T18:30:00.000Z").getTime();

type AppState = ReturnType<typeof createApp>;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf356-health-pipeline-"));
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "user-igor-test",
          openclawAgent: "igor",
          clientId: "client-id",
          clientSecret: "client-secret",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function makeApp(dir: string): AppState {
  return createApp({
    bagDbPath: path.join(dir, "pending-bag.db"),
    agentQueueDbPath: path.join(dir, "agent-queue.db"),
    operationalEventsDbPath: path.join(dir, "operational-events.db"),
    deadLetterQueueDbPath: path.join(dir, "dead-letter-queue.db"),
    enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
    livenessDispatchDbPath: path.join(dir, "liveness-dispatches.db"),
  });
}

function closeApp(appState: AppState): void {
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
}

function installTrackedTicketFetch(): jest.MockedFunction<typeof fetch> {
  const trackedIssues = [
    {
      id: "issue-dsn-6",
      identifier: "DSN-6",
      title: "Plain delegated ticket never dispatched",
      updatedAt: "2026-07-22T18:10:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      delegate: { id: "user-igor-test", name: "Igor" },
      assignee: null,
      labels: { nodes: [] },
    },
    {
      id: "issue-inf-356",
      identifier: "INF-356",
      title: "Live health ticket has dispatch and runtime liveness",
      updatedAt: "2026-07-22T18:20:00.000Z",
      state: { name: "Doing", type: "started" },
      delegate: { id: "user-igor-test", name: "Igor" },
      assignee: null,
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
    },
    {
      id: "issue-inf-357",
      identifier: "INF-357",
      title: "Acked ticket with broken runtime session",
      updatedAt: "2026-07-22T18:00:00.000Z",
      state: { name: "Doing", type: "started" },
      delegate: { id: "user-igor-test", name: "Igor" },
      assignee: null,
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
    },
  ];

  const mock = jest.fn<typeof fetch>(async () =>
    new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: trackedIssues,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  globalThis.fetch = mock;
  return mock;
}

describe("INF-356: GET /health/snapshot live pipeline", () => {
  let dir: string;
  let appState: AppState;
  let dispatchStore: DispatchRecordStore;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    originalFetch = globalThis.fetch;
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.LINEAR_OAUTH_TOKEN = "test-linear-token";
    reloadAgents();
    resetRemediationStateForTest();
    installTrackedTicketFetch();

    appState = makeApp(dir);
    dispatchStore = new DispatchRecordStore(path.join(dir, "liveness-dispatches.db"));

    const healthyDispatch = dispatchStore.recordDispatch({
      agentId: "igor",
      ticketId: "INF-356",
      sessionKey: "linear-INF-356",
    });
    dispatchStore.recordAck(healthyDispatch.dispatchId, {
      delivered: true,
      target_identity: "igor",
      status: "accepted",
    });
    appState.sessionTracker.startSession("igor", "linear-INF-356");

    const brokenDispatch = dispatchStore.recordDispatch({
      agentId: "igor",
      ticketId: "INF-357",
      sessionKey: "linear-INF-357",
    });
    dispatchStore.recordAck(brokenDispatch.dispatchId, {
      delivered: true,
      target_identity: "igor",
      status: "accepted",
    });
  });

  afterEach(() => {
    dispatchStore.close();
    closeApp(appState);
    globalThis.fetch = originalFetch;
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_OAUTH_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.useRealTimers();
  });

  it("AC1/AC2: returns one contract-shaped entry per tracked ticket using live dispatch/session/turn data", async () => {
    const res = await request(appState.app).get("/health/snapshot");

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(res.body).toMatchObject({
      generatedAt: expect.any(String),
      pipeline: { producing: true },
      trackedTaskCount: 3,
    });
    expect(res.body.tasks).toHaveLength(3);

    expect(res.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticket_id: "INF-356",
          gate: "pickup",
          expectedSignal: {
            type: expect.stringMatching(/thinking|consider-work|dispatch-ack/i),
            deadline: expect.any(String),
          },
          actual: expect.objectContaining({
            dispatch_ack: expect.objectContaining({ status: "accepted", target_identity: "igor" }),
            session: expect.objectContaining({ healthy: true }),
            turn: expect.objectContaining({ active: true }),
          }),
          health: "HEALTHY",
          failure_class: null,
          remediation: expect.objectContaining({ status: "not-needed" }),
        }),
      ]),
    );
  });

  it("AC3/AC4: delegated-but-undispatched plain ticket is UNHEALTHY connector-didnt-fire and auto-remediated", async () => {
    const res = await request(appState.app).get("/health/snapshot");

    expect(res.status).toBe(200);
    const dsn = res.body.tasks.find((task: { ticket_id?: string }) => task.ticket_id === "DSN-6");
    expect(dsn).toMatchObject({
      ticket_id: "DSN-6",
      workflow: null,
      gate: "pickup",
      health: "UNHEALTHY",
      failure_class: "connector-didnt-fire",
      actual: expect.objectContaining({
        dispatch: expect.objectContaining({ hasRecord: false, acknowledged: false }),
        session: expect.objectContaining({ healthy: false }),
        turn: expect.objectContaining({ active: false }),
      }),
      remediation: expect.objectContaining({
        action: "re-fire-dispatch",
        class: "AUTO",
        status: "executed",
      }),
    });
  });

  it("AC3: live contract breaches also surface confirm-class remediation instead of auto-executing it", async () => {
    const res = await request(appState.app).get("/health/snapshot");

    expect(res.status).toBe(200);
    const broken = res.body.tasks.find((task: { ticket_id?: string }) => task.ticket_id === "INF-357");
    expect(broken).toMatchObject({
      health: "UNHEALTHY",
      failure_class: "agent-broken",
      actual: expect.objectContaining({
        dispatch_ack: expect.objectContaining({ status: "accepted" }),
        session: expect.objectContaining({ healthy: false, reason: expect.any(String) }),
      }),
      remediation: expect.objectContaining({
        action: "restart-session",
        class: "CONFIRM",
        status: "confirm-required",
      }),
    });
  });

  it("AC5: distinguishes genuinely empty live input from a pipeline that is not producing", async () => {
    (globalThis.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await request(appState.app).get("/health/snapshot");

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body).toMatchObject({
      status: "empty",
      trackedTaskCount: 0,
      pipeline: {
        producing: true,
        source: "linear-live",
        error: null,
      },
    });
  });

  it("AC5: reports a non-producing pipeline distinctly from an empty healthy snapshot", async () => {
    (globalThis.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
      new Error("Linear GraphQL unavailable"),
    );

    const res = await request(appState.app).get("/health/snapshot");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "pipeline-error",
      trackedTaskCount: null,
      tasks: [],
      pipeline: {
        producing: false,
        source: "linear-live",
        error: expect.stringContaining("Linear GraphQL unavailable"),
      },
    });
  });
});
