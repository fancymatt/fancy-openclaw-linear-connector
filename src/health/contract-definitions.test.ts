/**
 * Tests for contract definitions (INF-317, AC 1, 6).
 *
 * AC 1: Contract definitions are typed (TypeScript) and loaded from config or DB.
 * AC 6: Contract store persists definitions; default contracts exist for standard workflows.
 */

import { jest } from "@jest/globals";
import {
  DEFAULT_CONTRACTS,
  loadContractDefinitions,
  type LifecycleContract,
} from "./contract-definitions.js";
import type { GateId } from "./health-types.js";

describe("Contract definitions (AC 1: typed + loadable)", () => {
  it("DEFAULT_CONTRACTS is an array of typed LifecycleContract objects", () => {
    expect(Array.isArray(DEFAULT_CONTRACTS)).toBe(true);
    expect(DEFAULT_CONTRACTS.length).toBeGreaterThan(0);

    for (const c of DEFAULT_CONTRACTS) {
      // Each entry has all required LifecycleContract fields
      expect(c).toHaveProperty("label");
      expect(typeof c.label).toBe("string");
      expect(c).toHaveProperty("gateId");
      expect(["dispatched", "picked-up", "in-progress", "done"]).toContain(c.gateId);
      expect(c).toHaveProperty("expectedSignal");
      expect(c).toHaveProperty("deadlineMs");
      expect(typeof c.deadlineMs).toBe("number");
      expect(c.deadlineMs).toBeGreaterThan(0);
      expect(c).toHaveProperty("suppression");
      expect(Array.isArray(c.suppression)).toBe(true);
    }
  });

  it("loadContractDefinitions returns defaults when no overrides given", () => {
    const defs = loadContractDefinitions();
    expect(defs).toEqual(DEFAULT_CONTRACTS);
  });

  it("loadContractDefinitions merges overrides by gateId", () => {
    const override: LifecycleContract = {
      label: "Custom Gate 1",
      gateId: "dispatched",
      expectedSignal: "Thinking",
      deadlineMs: 120_000,
      suppression: [{ condition: "queued", maxDepth: 3, maxAgeMs: 60_000 }],
    };

    const defs = loadContractDefinitions([override]);
    const gate1 = defs.find((c) => c.gateId === "dispatched");
    expect(gate1).toBeDefined();
    expect(gate1!.deadlineMs).toBe(120_000);
    // Gate 2 should remain at defaults
    const gate2 = defs.find((c) => c.gateId === "picked-up");
    expect(gate2).toBeDefined();
    expect(gate2!.deadlineMs).toBe(300_000);
  });

  it("loadContractDefinitions with empty overrides array returns defaults", () => {
    const defs = loadContractDefinitions([]);
    expect(defs).toEqual(DEFAULT_CONTRACTS);
  });

  it("default contracts cover dispatched and picked-up gates", () => {
    const gateIds = DEFAULT_CONTRACTS.map((c) => c.gateId);
    expect(gateIds).toContain("dispatched");
    expect(gateIds).toContain("picked-up");
  });

  it("Gate 1 default has 60s deadline expecting Thinking signal", () => {
    const gate1 = DEFAULT_CONTRACTS.find((c) => c.gateId === "dispatched");
    expect(gate1).toBeDefined();
    expect(gate1!.expectedSignal).toBe("Thinking");
    expect(gate1!.deadlineMs).toBe(60_000);
  });

  it("Gate 2 default has 5min deadline expecting verb signal", () => {
    const gate2 = DEFAULT_CONTRACTS.find((c) => c.gateId === "picked-up");
    expect(gate2).toBeDefined();
    expect(gate2!.expectedSignal).toBe("verb");
    expect(gate2!.deadlineMs).toBe(300_000);
  });

  it("default suppression rules exist for each gate", () => {
    for (const c of DEFAULT_CONTRACTS) {
      expect(c.suppression.length).toBeGreaterThan(0);
    }
  });

  it("suppression rules have valid condition values", () => {
    const validConditions = ["queued", "working", "blocked"];
    for (const c of DEFAULT_CONTRACTS) {
      for (const rule of c.suppression) {
        expect(validConditions).toContain(rule.condition);
      }
    }
  });

  it("override accepts custom gateIds not in defaults", () => {
    const override: LifecycleContract = {
      label: "Custom Gate — in-progress",
      gateId: "in-progress",
      expectedSignal: "turn-active",
      deadlineMs: 600_000,
      suppression: [{ condition: "working" }],
    };
    const defs = loadContractDefinitions([override]);
    const gate = defs.find((c) => c.gateId === "in-progress");
    expect(gate).toBeDefined();
    expect(gate!.expectedSignal).toBe("turn-active");
  });

  it("loadContractDefinitions does not mutate the original DEFAULT_CONTRACTS", () => {
    const override: LifecycleContract = {
      label: "Mutated Gate 1",
      gateId: "dispatched",
      expectedSignal: "Thinking",
      deadlineMs: 999,
      suppression: [],
    };
    loadContractDefinitions([override]);
    // Original should be unchanged
    const originalGate1 = DEFAULT_CONTRACTS.find((c) => c.gateId === "dispatched");
    expect(originalGate1!.deadlineMs).toBe(60_000);
    expect(originalGate1!.suppression.length).toBeGreaterThan(0);
  });
});

describe("Contract config loading from file/DB shape (AC 1: loaded from config or DB)", () => {
  it("a ContractConfig object can be constructed and passed to loadContractDefinitions", () => {
    // This simulates loading from a config file
    const config = {
      contracts: [
        {
          label: "Config Gate 1",
          gateId: "dispatched" as GateId,
          expectedSignal: "Thinking" as const,
          deadlineMs: 90_000,
          suppression: [{ condition: "queued" as const, maxDepth: 10, maxAgeMs: 60_000 }],
        },
      ],
    };
    const defs = loadContractDefinitions(config.contracts);
    expect(defs.length).toBeGreaterThanOrEqual(1);
    const gate = defs.find((c) => c.gateId === "dispatched");
    expect(gate).toBeDefined();
    expect(gate!.deadlineMs).toBe(90_000);
  });
});
