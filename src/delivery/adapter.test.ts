import { createAssignmentPayload, HttpOpenClawDeliveryAdapter } from "./adapter";
import type { RouteResult } from "../types";
import type { LinearIssueCreatedEvent } from "../webhook/schema";

function makeRouteResult(): RouteResult {
  const event: LinearIssueCreatedEvent = {
    type: "Issue",
    action: "create",
    actor: { id: "actor-1", name: "Alice" },
    createdAt: "2026-04-10T18:00:00.000Z",
    data: {
      id: "issue-1",
      identifier: "AI-211",
      title: "Implement the OpenClaw delivery adapter",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 2,
      priorityLabel: "High",
      teamId: "team-1",
      teamKey: "AI",
      assigneeId: "user-1",
      assigneeName: "Ai",
      labelIds: [],
      url: "https://linear.app/fancymatt/issue/AI-211",
      createdAt: "2026-04-10T18:00:00.000Z",
      updatedAt: "2026-04-10T18:00:00.000Z",
    },
    raw: {},
  };

  return {
    agentId: "ai",
    sessionKey: "agent:ai:main",
    priority: 10,
    event,
  };
}

describe("createAssignmentPayload", () => {
  it("builds the documented delivery payload from a route result", () => {
    const payload = createAssignmentPayload(makeRouteResult());

    expect(payload.version).toBe(1);
    expect(payload.source).toBe("linear");
    expect(payload.agentId).toBe("ai");
    expect(payload.sessionKey).toBe("agent:ai:main");
    expect(payload.issue?.identifier).toBe("AI-211");
    expect(payload.summary).toContain("AI-211");
  });
});

describe("HttpOpenClawDeliveryAdapter", () => {
  it("posts the assignment payload to the configured OpenClaw endpoint", async () => {
    const route = makeRouteResult();
    const payload = createAssignmentPayload(route);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ ok: true }),
    });

    const adapter = new HttpOpenClawDeliveryAdapter({
      gatewayUrl: "http://localhost:8080",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.deliver({
      destination: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
      },
      payload,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8080/deliveries/openclaw",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-openclaw-session-key": "agent:ai:main",
          "x-openclaw-agent-id": "ai",
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(202);
  });

  it("surfaces non-2xx delivery failures clearly", async () => {
    const route = makeRouteResult();
    const payload = createAssignmentPayload(route);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "gateway down",
    });

    const adapter = new HttpOpenClawDeliveryAdapter({
      gatewayUrl: "http://localhost:8080",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.deliver({
      destination: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
      },
      payload,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
    expect(result.responseBody).toBe("gateway down");
  });

  it("surfaces network failures clearly", async () => {
    const route = makeRouteResult();
    const payload = createAssignmentPayload(route);
    const fetchImpl = jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

    const adapter = new HttpOpenClawDeliveryAdapter({
      gatewayUrl: "http://localhost:8080",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.deliver({
      destination: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
      },
      payload,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
