/**
 * ContractEngine — composes contract definitions, classifier, and store.
 *
 * Child of INF-317 (Contract Engine).
 */

import type { GateId } from "./health-types.js";
import {
  type LifecycleContract,
  loadContractDefinitions,
  DEFAULT_CONTRACTS,
} from "./contract-definitions.js";
import { type SignalInput, type ClassifyResult, classifyGateHealth } from "./health-classifier.js";
import { type ContractStore, InMemoryContractStore } from "./contract-store.js";

export type { ContractEngineConfig as _ContractEngineConfig };

export interface ContractEngineConfig {
  contractOverrides?: LifecycleContract[];
  store?: ContractStore;
  defaultWorkflowKey?: string;
}

export class ContractEngine {
  private readonly contracts: LifecycleContract[];
  private readonly contractMap: Map<GateId, LifecycleContract>;
  private readonly store: ContractStore;
  private readonly defaultWorkflowKey: string;

  constructor(config?: ContractEngineConfig) {
    this.contracts = loadContractDefinitions(config?.contractOverrides);
    this.contractMap = new Map<GateId, LifecycleContract>();
    for (const contract of this.contracts) {
      this.contractMap.set(contract.gateId, contract);
    }
    this.store = config?.store ?? new InMemoryContractStore();
    this.defaultWorkflowKey = config?.defaultWorkflowKey ?? "default";
  }

  /**
   * Get the contract definition for a specific gate, or undefined if unknown.
   */
  getContract(gateId: GateId): LifecycleContract | undefined {
    return this.contractMap.get(gateId);
  }

  /**
   * Evaluate gate health for a single gate.
   */
  evaluate(gateId: GateId, input: SignalInput): ClassifyResult {
    const contract = this.contractMap.get(gateId);
    if (!contract) {
      throw new Error(`No contract defined for gate: ${gateId}`);
    }
    return classifyGateHealth(contract, input);
  }

  /**
   * Evaluate gate health for all registered gates.
   */
  evaluateAll(inputGetter: (gateId: GateId) => SignalInput): ClassifyResult[] {
    const results: ClassifyResult[] = [];
    for (const [gateId, contract] of this.contractMap.entries()) {
      const input = inputGetter(gateId);
      results.push(classifyGateHealth(contract, input));
    }
    return results;
  }

  /**
   * Persist contracts for a workflow key.
   */
  async persistContracts(key: string, contracts: LifecycleContract[]): Promise<void> {
    await this.store.set(key, contracts);
  }

  /**
   * Load contracts for a workflow key.
   */
  async loadContracts(key: string): Promise<LifecycleContract[]> {
    return this.store.get(key);
  }
}
