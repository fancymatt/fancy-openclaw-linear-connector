/**
 * Typed contract definitions for per-lifecycle-edge contracts.
 *
 * STUB — implementation pending.
 *
 * Child of INF-317 (Contract Engine).
 */

import type { GateId, SignalType } from "./health-types.js";

export interface SuppressionRule {
  condition: "queued" | "working" | "blocked";
  maxDepth?: number;
  maxAgeMs?: number;
}

export interface LifecycleContract {
  label: string;
  gateId: GateId;
  expectedSignal: SignalType;
  deadlineMs: number;
  suppression: SuppressionRule[];
}

export interface ContractConfig {
  contracts: LifecycleContract[];
}

/** Default contract definitions — placeholder values for type checking. */
export const DEFAULT_CONTRACTS: LifecycleContract[] = [
  {
    label: "Gate 1 — dispatched → Thinking",
    gateId: "dispatched",
    expectedSignal: "Thinking",
    deadlineMs: 60_000,
    suppression: [
      { condition: "queued", maxDepth: 5, maxAgeMs: 30_000 },
      { condition: "blocked" },
    ],
  },
  {
    label: "Gate 2 — picked-up → activity",
    gateId: "picked-up",
    expectedSignal: "verb",
    deadlineMs: 300_000,
    suppression: [
      { condition: "working" },
      { condition: "blocked" },
    ],
  },
];

/**
 * Load contract definitions, merging optional overrides with defaults.
 *
 * Overrides are merged by gateId — non-overridden gates remain from defaults.
 * The original DEFAULT_CONTRACTS array is never mutated.
 */
export function loadContractDefinitions(
  overrides?: LifecycleContract[],
): LifecycleContract[] {
  if (!overrides || overrides.length === 0) {
    return DEFAULT_CONTRACTS.map((c) => ({ ...c, suppression: [...c.suppression] }));
  }

  const overrideMap = new Map<GateId, LifecycleContract>();
  for (const override of overrides) {
    overrideMap.set(override.gateId, {
      ...override,
      suppression: [...override.suppression],
    });
  }

  const results = DEFAULT_CONTRACTS.map(
    (defaultContract) =>
      overrideMap.get(defaultContract.gateId) ?? {
        ...defaultContract,
        suppression: [...defaultContract.suppression],
      },
  );

  // Include any override gates that aren't in DEFAULT_CONTRACTS
  const seenGateIds = new Set(DEFAULT_CONTRACTS.map((c) => c.gateId));
  for (const [gateId, override] of overrideMap) {
    if (!seenGateIds.has(gateId)) {
      results.push(override);
    }
  }

  return results;
}
