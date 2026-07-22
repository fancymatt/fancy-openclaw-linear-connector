/**
 * Contract store — durable persistence for contract definitions.
 *
 * Child of INF-317 (Contract Engine).
 */

import { type LifecycleContract, DEFAULT_CONTRACTS } from "./contract-definitions.js";
import type { GateId } from "./health-types.js";

export interface ContractStore {
  get(key: string): Promise<LifecycleContract[]>;
  set(key: string, contracts: LifecycleContract[]): Promise<void>;
  keys(): Promise<string[]>;
}

/** Deep-clone an array of LifecycleContracts (structuredClone or manual). */
function cloneContracts(contracts: LifecycleContract[]): LifecycleContract[] {
  return contracts.map((c) => ({
    ...c,
    suppression: c.suppression.map((s) => ({ ...s })),
  }));
}

/** Default contracts copy (defensive). */
function defaultContractsCopy(): LifecycleContract[] {
  return cloneContracts(DEFAULT_CONTRACTS);
}

/**
 * In-memory contract store. Returns DEFAULT_CONTRACTS for unknown keys.
 * All mutations and reads return defensive copies.
 */
export class InMemoryContractStore implements ContractStore {
  private readonly store = new Map<string, LifecycleContract[]>();

  async get(key: string): Promise<LifecycleContract[]> {
    const stored = this.store.get(key);
    if (!stored) {
      return defaultContractsCopy();
    }
    return cloneContracts(stored);
  }

  async set(key: string, contracts: LifecycleContract[]): Promise<void> {
    this.store.set(key, cloneContracts(contracts));
  }

  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  reset(): void {
    this.store.clear();
  }
}

/**
 * SQLite-backed contract store.
 *
 * Falls back to in-memory behavior when no dbPath is provided
 * or when better-sqlite3 is unavailable.
 */
export class SqliteContractStore implements ContractStore {
  private readonly dbPath: string | undefined;
  private readonly memoryFallback: InMemoryContractStore;
  private db: ReturnType<typeof import("better-sqlite3")> | null = null;

  constructor(opts?: { dbPath?: string }) {
    this.dbPath = opts?.dbPath;
    this.memoryFallback = new InMemoryContractStore();
  }

  private ensureDb(): ReturnType<typeof import("better-sqlite3")> | null {
    if (this.db) return this.db;
    if (!this.dbPath) return null;

    try {
      // Dynamic import to avoid hard dependency at module level
      const Database: typeof import("better-sqlite3") = require("better-sqlite3");
      this.db = new Database(this.dbPath, {});
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contract_definitions (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL
        )
      `);
      return this.db;
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<LifecycleContract[]> {
    const db = this.ensureDb();
    if (!db) {
      return this.memoryFallback.get(key);
    }

    try {
      const row = db.prepare("SELECT data FROM contract_definitions WHERE key = ?").get(key) as
        | { data: string }
        | undefined;
      if (!row) {
        return defaultContractsCopy();
      }
      const parsed = JSON.parse(row.data) as LifecycleContract[];
      return cloneContracts(parsed);
    } catch {
      return defaultContractsCopy();
    }
  }

  async set(key: string, contracts: LifecycleContract[]): Promise<void> {
    const db = this.ensureDb();
    if (!db) {
      await this.memoryFallback.set(key, contracts);
      return;
    }

    const data = JSON.stringify(cloneContracts(contracts));
    db.prepare(
      "INSERT OR REPLACE INTO contract_definitions (key, data) VALUES (?, ?)",
    ).run(key, data);
  }

  async keys(): Promise<string[]> {
    const db = this.ensureDb();
    if (!db) {
      return this.memoryFallback.keys();
    }

    try {
      const rows = db.prepare("SELECT key FROM contract_definitions").all() as { key: string }[];
      return rows.map((r) => r.key);
    } catch {
      return [];
    }
  }
}
