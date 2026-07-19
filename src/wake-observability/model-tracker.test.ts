/**
 * INF-84 AC3 — model-degradation detection.
 *
 * AC3: `model-degraded` is detectable: an agent on a slow local fallback is
 * distinguishable from an agent on its primary model.
 *
 * These tests verify that the model tracker (and the reason-code resolver via
 * it) can distinguish a degraded agent from a healthy one, using measurable
 * signals: model name, fallback chain position, and throughput.
 *
 * These tests import from modules that DO NOT exist yet. They will fail on first
 * run — expected TDD red state.
 */

import { describe, it, expect } from "@jest/globals";

import {
  type ResolvedModelInfo,
  isModelDegraded,
  getAgentResolvedModel,
  type ModelTrackerDeps,
} from "./index.js";

describe("INF-84 AC3: model-degradation detection", () => {
  // ── AC3: slow local fallback is distinguishable from primary model ──
  it("AC3.1 — returns true when agent is on a slow local fallback (< 10 tok/s)", async () => {
    const deps: ModelTrackerDeps = {
      getResolvedModel: async (_agentId: string) => ({
        modelName: "ollama/gemma4:31b",
        isFallback: true,
        tokensPerSecond: 2,
        configuredDefault: "claude-sonnet-4-6",
        gateway: "local",
      }),
    };

    const info: ResolvedModelInfo = await getAgentResolvedModel("ai", deps);
    expect(isModelDegraded(info)).toBe(true);
    expect(info.isFallback).toBe(true);
    expect(info.tokensPerSecond).toBeLessThan(10);
    expect(info.gateway).toBe("local");
  });

  // ── AC3: fast primary model is not degraded ──
  it("AC3.2 — returns false for a fast non-fallback model", async () => {
    const deps: ModelTrackerDeps = {
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-sonnet-4-6",
        isFallback: false,
        tokensPerSecond: 80,
        configuredDefault: "claude-sonnet-4-6",
        gateway: "openclaw",
      }),
    };

    const info: ResolvedModelInfo = await getAgentResolvedModel("ai", deps);
    expect(isModelDegraded(info)).toBe(false);
  });

  // ── AC3: fast fallback is NOT degraded (a fallback that matches speed is fine) ──
  it("AC3.3 — returns false when fallback model is still fast (e.g. claude-sonnet → claude-opus)", async () => {
    const deps: ModelTrackerDeps = {
      getResolvedModel: async (_agentId: string) => ({
        modelName: "claude-opus-4-8",
        isFallback: true,
        tokensPerSecond: 60,
        configuredDefault: "claude-sonnet-4-6",
        gateway: "openclaw",
      }),
    };

    const info: ResolvedModelInfo = await getAgentResolvedModel("ai", deps);
    // Is a fallback, but fast — not degraded in practice
    expect(isModelDegraded(info)).toBe(false);
  });

  // ── AC3: primary model running on local is not degraded if fast ──
  it("AC3.4 — returns false for a fast primary model even on local gateway", async () => {
    const deps: ModelTrackerDeps = {
      getResolvedModel: async (_agentId: string) => ({
        modelName: "zai/glm-5.2",
        isFallback: false,
        tokensPerSecond: 60,
        configuredDefault: "zai/glm-5.2",
        gateway: "local",
      }),
    };

    const info: ResolvedModelInfo = await getAgentResolvedModel("ai", deps);
    expect(isModelDegraded(info)).toBe(false);
  });

  // ── AC3: throughput-based degradation boundary ──
  it("AC3.5 — isModelDegraded uses a throughput threshold (e.g. < 5 tok/s) as the primary signal", async () => {
    const borderline: ResolvedModelInfo = {
      modelName: "ollama/some-small-model",
      isFallback: true,
      tokensPerSecond: 4, // below threshold
      configuredDefault: "claude-sonnet-4-6",
      gateway: "local",
    };
    expect(isModelDegraded(borderline)).toBe(true);

    const fastEnough: ResolvedModelInfo = {
      modelName: "ollama/some-small-model",
      isFallback: true,
      tokensPerSecond: 8, // above threshold
      configuredDefault: "claude-sonnet-4-6",
      gateway: "local",
    };
    expect(isModelDegraded(fastEnough)).toBe(false);
  });

  // ── AC3: family-based degradation for known slow models ──
  it("AC3.6 — detects known slow model families even without throughput data", async () => {
    const info: ResolvedModelInfo = {
      modelName: "ollama/gemma4:31b",
      isFallback: true,
      tokensPerSecond: 0, // unknown/untracked throughput
      configuredDefault: "claude-sonnet-4-6",
      gateway: "local",
    };
    // Even without throughput, the "ollama/" prefix + isFallback should flag it
    expect(isModelDegraded(info)).toBe(true);
  });

  // ── AC3: the resolved model surface includes all the info needed for
  //     the reason-code resolver (AC1.5 depends on this) ──
  it("AC3.7 — ResolvedModelInfo exposes the fields the reason resolver needs", async () => {
    const info: ResolvedModelInfo = await getAgentResolvedModel("ai", {
      getResolvedModel: async (_agentId: string) => ({
        modelName: "ollama/gemma4:31b",
        isFallback: true,
        tokensPerSecond: 2,
        configuredDefault: "claude-sonnet-4-6",
        gateway: "local",
      }),
    });

    // These fields feed directly into StallReasonCode.MODEL_DEGRADED:
    expect(info).toHaveProperty("modelName");
    expect(info).toHaveProperty("isFallback");
    expect(info).toHaveProperty("tokensPerSecond");
    expect(info).toHaveProperty("configuredDefault");
    expect(info).toHaveProperty("gateway");
  });
});
