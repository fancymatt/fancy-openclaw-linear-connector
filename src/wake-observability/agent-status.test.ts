/**
 * INF-84 AC2 — per-agent status surface.
 *
 * AC2: The per-agent status surface shows: live session y/n, **resolved model**
 * (post-fallback), queue depth, last action + ticket.
 *
 * These tests import from modules that DO NOT exist yet. They will fail on first
 * run — expected TDD red state. The implementer creates the source modules.
 */

import { describe, it, expect } from "@jest/globals";

import {
  type AgentStatus,
  type AgentStatusSnapshot,
  getAgentStatus,
  getAgentStatusForAll,
} from "./index.js";

import { SessionTracker } from "../bag/session-tracker.js";
import { PendingWorkBag } from "../bag/pending-work-bag.js";

describe("INF-84 AC2: per-agent status surface", () => {
  // ── AC2: live session indicator ──
  it("AC2.1 — shows liveSession: true when agent has an active session", async () => {
    const sessionTracker = new SessionTracker(50_000);
    sessionTracker.startSession("ai", "linear-inf-84");

    const deps = {
      sessionTracker,
      getAgentQueueDepth: async (_agentId: string) => 0,
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-sonnet-4-6",
        isFallback: false,
        tokensPerSecond: 80,
      }),
      getLastAction: async (_agentId: string) => ({
        ticketId: "INF-84",
        actionAt: Date.now() - 10_000,
        actionType: "state-transition" as const,
      }),
    };

    const status: AgentStatus = await getAgentStatus("ai", deps);
    expect(status.liveSession).toBe(true);
    expect(status.activeSessionCount).toBeGreaterThanOrEqual(1);
  });

  it("AC2.2 — shows liveSession: false when agent has no active session", async () => {
    const sessionTracker = new SessionTracker(50_000);
    // Don't start any session

    const deps = {
      sessionTracker,
      getAgentQueueDepth: async (_agentId: string) => 0,
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-sonnet-4-6",
        isFallback: false,
        tokensPerSecond: 80,
      }),
      getLastAction: async (_agentId: string) => null,
    };

    const status: AgentStatus = await getAgentStatus("ai", deps);
    expect(status.liveSession).toBe(false);
    expect(status.activeSessionCount).toBe(0);
  });

  // ── AC2: resolved model (post-fallback) ──
  it("AC2.3 — shows resolvedModel with the actual model in use, not just the configured default", async () => {
    const deps = {
      sessionTracker: new SessionTracker(50_000),
      getAgentQueueDepth: async (_agentId: string) => 0,
      getResolvedModel: async (_agentId: string) => ({
        modelName: "ollama/gemma4:31b",
        isFallback: true,
        tokensPerSecond: 2,
        configuredDefault: "claude-sonnet-4-6",
      }),
      getLastAction: async (_agentId: string) => null,
    };

    const status: AgentStatus = await getAgentStatus("ai", deps);
    expect(status.resolvedModel).toBe("ollama/gemma4:31b");
    expect(status.resolvedModelConfiguredDefault).toBe("claude-sonnet-4-6");
    expect(status.modelIsFallback).toBe(true);
  });

  // ── AC2: queue depth ──
  it("AC2.4 — shows queueDepth as the count of pending tickets in the bag", async () => {
    const bag = new PendingWorkBag(":memory:");
    bag.add("ai", "linear-fcy-388", "Issue");
    bag.add("ai", "linear-ill-148", "Issue");
    bag.add("ai", "linear-INF-84", "Issue");

    const deps = {
      sessionTracker: new SessionTracker(50_000),
      getAgentQueueDepth: async (agentId: string) => {
        const stats = bag.getAgentStats();
        const entry = stats.find((s) => s.agentId === agentId);
        return entry?.pendingCount ?? 0;
      },
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-sonnet-4-6",
        isFallback: false,
        tokensPerSecond: 80,
      }),
      getLastAction: async (_agentId: string) => null,
    };

    const status: AgentStatus = await getAgentStatus("ai", deps);
    expect(status.queueDepth).toBe(3);
  });

  // ── AC2: last action + ticket ──
  it("AC2.5 — shows lastAction with ticket ID and timestamp", async () => {
    const sessionTracker = new SessionTracker(50_000);
    sessionTracker.startSession("ai", "linear-inf-84");

    const deps = {
      sessionTracker,
      getAgentQueueDepth: async (_agentId: string) => 0,
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-sonnet-4-6",
        isFallback: false,
        tokensPerSecond: 80,
      }),
      getLastAction: async (_agentId: string) => ({
        ticketId: "AI-2009",
        actionAt: Date.now() - 120_000,
        actionType: "state-transition" as const,
      }),
    };

    const status: AgentStatus = await getAgentStatus("ai", deps);
    expect(status.lastAction).not.toBeNull();
    expect(status.lastAction!.ticketId).toBe("AI-2009");
    expect(typeof status.lastAction!.actionAt).toBe("number");
  });

  // ── AC2: snapshot for all agents ──
  it("AC2.6 — getAgentStatusForAll returns an array of status objects, one per agent", async () => {
    const deps = {
      sessionTracker: new SessionTracker(50_000),
      listAgentIds: async () => ["ai", "cra", "igor"],
      getAgentQueueDepth: async (_agentId: string) => 0,
      getResolvedModel: async (agentId: string) => ({
        modelName: agentId === "ai" ? "claude-sonnet-4-6" : "zai/glm-5.2",
        isFallback: false,
        tokensPerSecond: agentId === "ai" ? 80 : 60,
      }),
      getLastAction: async (_agentId: string) => null,
    };

    const snapshot: AgentStatusSnapshot = await getAgentStatusForAll(deps);
    expect(snapshot.agents).toHaveLength(3);
    expect(snapshot.fetchedAt).toBeDefined();

    const aiStatus = snapshot.agents.find((s) => s.agentId === "ai");
    expect(aiStatus).toBeDefined();
    expect(aiStatus!.resolvedModel).toBe("claude-sonnet-4-6");
  });

  // ── AC2: shape includes all five required fields ──
  it("AC2.7 — every AgentStatus has all five required surface fields", async () => {
    const deps = {
      sessionTracker: new SessionTracker(50_000),
      listAgentIds: async () => ["ai"],
      getAgentQueueDepth: async (_agentId: string) => 0,
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-sonnet-4-6",
        isFallback: false,
        tokensPerSecond: 80,
      }),
      getLastAction: async (_agentId: string) => null,
    };

    const snapshot = await getAgentStatusForAll(deps);
    const status = snapshot.agents[0]!;

    // The five required fields:
    expect(status).toHaveProperty("liveSession");       // y/n
    expect(status).toHaveProperty("resolvedModel");     // post-fallback model name
    expect(status).toHaveProperty("queueDepth");        // pending ticket count
    expect(status).toHaveProperty("lastAction");         // ticket + timestamp or null
    expect(status).toHaveProperty("activeSessionCount"); // how many sessions live

    // Additional helpful fields that prove model awareness:
    expect(status).toHaveProperty("modelIsFallback");
    expect(status).toHaveProperty("tokensPerSecond");
  });
});
