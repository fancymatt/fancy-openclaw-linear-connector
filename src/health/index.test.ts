/**
 * Integration tests for ContractEngine (INF-317).
 *
 * Covers composing definitions, classifier, and store into a single engine.
 */

import { jest } from "@jest/globals";
import { ContractEngine, type ContractEngineConfig } from "./index.js";
import { type LifecycleContract } from "./contract-definitions.js";
import { type SignalInput } from "./health-classifier.js";
import type { GateId } from "./health-types.js";

const NOW = 1_000_000_000_000;

describe("ContractEngine", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("constructs with default contracts", () => {
    const engine = new ContractEngine();
    expect(engine.getContract("dispatched")).toBeDefined();
    expect(engine.getContract("picked-up")).toBeDefined();
  });

  it("getContract returns undefined for unknown gate", () => {
    const engine = new ContractEngine();
    expect(engine.getContract("done")).toBeUndefined();
  });

  it("evaluate returns a ClassifyResult for a known gate", () => {
    const engine = new ContractEngine();
    const input: SignalInput = {
      gateEnteredAt: NOW - 5_000,
      signals: [],
    };
    const result = engine.evaluate("dispatched", input);
    expect(result.gateId).toBe("dispatched");
    expect(result.verdict.status).toBe("healthy");
  });

  it("evaluate throws for unknown gate", () => {
    const engine = new ContractEngine();
    const input: SignalInput = {
      gateEnteredAt: NOW,
      signals: [],
    };
    expect(() => engine.evaluate("done" as GateId, input)).toThrow(
      /no contract defined for gate/i,
    );
  });

  it("evaluateAll returns verdicts for all registered gates", () => {
    const engine = new ContractEngine();
    const results = engine.evaluateAll((_gateId) => ({
      gateEnteredAt: NOW - 5_000,
      signals: [],
    }));
    expect(results.length).toBeGreaterThanOrEqual(2);
    const gateIds = results.map((r) => r.gateId);
    expect(gateIds).toContain("dispatched");
    expect(gateIds).toContain("picked-up");
  });

  it("accepts contract overrides in config, merging with defaults", () => {
    const overrides: LifecycleContract[] = [
      {
        label: "Custom Gate 1",
        gateId: "dispatched",
        expectedSignal: "Thinking",
        deadlineMs: 120_000,
        suppression: [],
      },
    ];
    const engine = new ContractEngine({ contractOverrides: overrides });
    const contract = engine.getContract("dispatched");
    expect(contract).toBeDefined();
    expect(contract!.deadlineMs).toBe(120_000);
    // Default contracts not overridden remain available
    expect(engine.getContract("picked-up")).toBeDefined();
    expect(engine.getContract("picked-up")!.deadlineMs).toBe(300_000);
  });

  it("persistContracts and loadContracts round-trip through store", async () => {
    const engine = new ContractEngine();
    const custom: LifecycleContract[] = [
      {
        label: "Persisted Gate 1",
        gateId: "dispatched",
        expectedSignal: "Thinking",
        deadlineMs: 99_999,
        suppression: [{ condition: "blocked" }],
      },
    ];
    await engine.persistContracts("test-workflow", custom);
    const loaded = await engine.loadContracts("test-workflow");
    expect(loaded).toEqual(custom);
  });
});
