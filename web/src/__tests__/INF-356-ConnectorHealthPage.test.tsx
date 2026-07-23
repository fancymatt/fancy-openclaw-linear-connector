/**
 * INF-356 — /connector-health renders the live health snapshot.
 *
 * The repo has frontend route tests, so this test exercises the App route at
 * /admin/connector-health and verifies the exact stalled plain-delegation
 * class appears in the UI. It is intentionally red until the route/page is
 * wired to GET /health/snapshot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "../App";

const unhealthySnapshot = {
  generatedAt: "2026-07-22T18:30:00.000Z",
  status: "degraded",
  trackedTaskCount: 1,
  pipeline: { producing: true, source: "linear-live", error: null },
  tasks: [
    {
      ticket_id: "DSN-6",
      title: "Plain delegated ticket never dispatched",
      workflow: null,
      delegate: "igor",
      gate: "pickup",
      expectedSignal: {
        type: "dispatch-ack",
        deadline: "2026-07-22T18:11:00.000Z",
      },
      actual: {
        dispatch: { hasRecord: false, acknowledged: false },
        session: { healthy: false, reason: "no active runtime session" },
        turn: { active: false },
      },
      health: "UNHEALTHY",
      failure_class: "connector-didnt-fire",
      remediation: {
        action: "re-fire-dispatch",
        class: "AUTO",
        status: "executed",
      },
    },
  ],
};

const emptySnapshot = {
  generatedAt: "2026-07-22T18:30:00.000Z",
  status: "empty",
  trackedTaskCount: 0,
  pipeline: { producing: true, source: "linear-live", error: null },
  tasks: [],
};

const pipelineErrorSnapshot = {
  generatedAt: "2026-07-22T18:30:00.000Z",
  status: "pipeline-error",
  trackedTaskCount: null,
  pipeline: {
    producing: false,
    source: "linear-live",
    error: "Linear GraphQL unavailable",
  },
  tasks: [],
};

let healthSnapshot: unknown = unhealthySnapshot;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("INF-356: /connector-health route", () => {
  beforeEach(() => {
    healthSnapshot = unhealthySnapshot;
    window.history.pushState({}, "", "/admin/connector-health");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/admin/api/me")) {
          return okJson({ authenticated: true, secretConfigured: true });
        }
        if (url.endsWith("/admin/api/proposals")) {
          return okJson({ proposals: [] });
        }
        if (url.endsWith("/admin/api/dashboard")) {
          return okJson({
            generatedAt: "2026-07-22T18:30:00.000Z",
            deployment: "test",
            attention: [],
            status: {
              service: "connector",
              severity: "green",
              agentsConfigured: 0,
              activeSessions: 0,
              pendingBagSize: 0,
              eventsReceived: 0,
              signalsSent: 0,
            },
            agents: [],
            tasks: [],
            events: [],
            settings: {
              effectiveConfig: {},
              workspaceTeamMappings: [],
              agentMappings: [],
              oauthSetup: [],
              restartRequiredFlags: [],
            },
          });
        }
        if (url.endsWith("/admin/api/structure")) {
          return okJson({
            configHealth: { healthy: true },
            workflows: [],
            workflowError: null,
            registryPolicy: { lastCheck: null, violations: [], notes: [] },
          });
        }
        if (url.endsWith("/admin/api/alerts?limit=8")) {
          return okJson({ alerts: [] });
        }
        if (url.endsWith("/health/snapshot")) {
          return okJson(healthSnapshot);
        }
        return okJson({});
      }),
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC4: renders a delegated-but-undispatched plain ticket as UNHEALTHY with failure class and remediation", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /connector health/i })).toBeInTheDocument();
    });
    expect(screen.getByText("DSN-6")).toBeInTheDocument();
    expect(screen.getByText("UNHEALTHY")).toBeInTheDocument();
    expect(screen.getByText("connector-didnt-fire")).toBeInTheDocument();
    expect(screen.getByText(/re-fire-dispatch/i)).toBeInTheDocument();
    expect(screen.getByText(/executed/i)).toBeInTheDocument();
  });

  it("AC5: renders no tracked tasks separately from a non-producing pipeline", async () => {
    healthSnapshot = emptySnapshot;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /connector health/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/no tracked tasks/i)).toBeInTheDocument();
    expect(screen.queryByText(/pipeline not producing/i)).not.toBeInTheDocument();
  });

  it("AC5: renders pipeline failures as producer errors, not as all-healthy empty state", async () => {
    healthSnapshot = pipelineErrorSnapshot;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /connector health/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/pipeline not producing/i)).toBeInTheDocument();
    expect(screen.getByText(/linear graphql unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tracked tasks/i)).not.toBeInTheDocument();
  });
});
