/**
 * INF-99 — TDD harness test-env fidelity: DB driver factory.
 *
 * Provides a TestDbDriver interface that supports both SQLite (via
 * better-sqlite3) and a Postgres parity layer that catches engine-specific
 * divergences. The Postgres driver uses an in-memory engine with validation
 * that emulates Postgres behaviors — no real Postgres connection needed.
 */

import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunResult {
  lastInsertRowid: number | bigint;
  changes: number;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface TestDbDriver {
  /** Type discriminator: "sqlite" | "postgres" */
  readonly driverType: string;

  /** Execute one or more SQL statements (schema migration, DDL, etc.). */
  exec(sql: string): void;

  /** Prepare a statement for parameterised execution. */
  prepare(sql: string): Statement;

  /** Close the underlying database connection. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Column schema tracking
// ---------------------------------------------------------------------------

interface ColumnDef {
  name: string;
  type: string;
  isIntegerPK: boolean;
  isSerial: boolean;
  hasAutoincrement: boolean;
}

/** Regex to extract column-level definitions from CREATE TABLE. */
const COLUMN_DEF_RE = /`?(\w+)`?\s+(INTEGER|SERIAL|BIGINT|INT|TEXT|VARCHAR|BOOLEAN|DATETIME|REAL|FLOAT|NUMERIC)([^,()]*(?:\([^()]*\)[^,()]*)*)/gi;

/**
 * Parse a CREATE TABLE statement and return column definitions.
 * This is intentionally narrow — it only needs to cover the schemas
 * the harness produces. Full SQL parsing is not a goal.
 */
function parseCreateTable(sql: string): ColumnDef[] {
  const columns: ColumnDef[] = [];

  // Strip leading CREATE TABLE … ( to get to column body
  const bodyMatch = sql.match(/\(([\s\S]*)\)\s*$/);
  if (!bodyMatch) return columns;

  const body = bodyMatch[1];

  // Split on top-level commas (avoid splitting inside parens like DEFAULT('('))
  const parts = splitTopLevelCommas(body);
  for (const part of parts) {
    const trimmed = part.trim();
    // Skip table-level constraints
    if (!/^\w+/.test(trimmed)) continue;

    const match = trimmed.match(
      /^`?(\w+)`?\s+(INTEGER|SERIAL|BIGINT|INT|TEXT|VARCHAR|BOOLEAN|DATETIME|REAL|FLOAT|NUMERIC)\s*(.*)$/i
    );
    if (!match) continue;

    const name = match[1];
    const rawType = match[2].toUpperCase();
    const rest = (match[3] || "").toUpperCase();

    const isIntegerPK = rawType === "INTEGER" && /\bPRIMARY\s+KEY\b/.test(rest);
    const isSerial = rawType === "SERIAL" && /\bPRIMARY\s+KEY\b/.test(rest);
    const hasAutoincrement = /\bAUTOINCREMENT\b/i.test(rest);

    // Also catch SERIAL without PRIMARY KEY (unlikely but valid)
    const isSerialAny = rawType === "SERIAL";

    columns.push({
      name,
      type: rawType,
      isIntegerPK,
      isSerial: isSerial || isSerialAny,
      hasAutoincrement,
    });
  }

  return columns;
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

// ---------------------------------------------------------------------------
// SQLite driver
// ---------------------------------------------------------------------------

class SqliteDriver implements TestDbDriver {
  readonly driverType = "sqlite";
  private db: Database.Database;

  constructor() {
    this.db = new Database(":memory:");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.db.prepare(sql);
    return {
      run(...params: unknown[]): RunResult {
        const result = stmt.run(...params);
        return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        const row = stmt.get(...params) as Record<string, unknown> | undefined;
        return row;
      },
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Postgres parity driver (in-memory simulation)
// ---------------------------------------------------------------------------

class PostgresParityDriver implements TestDbDriver {
  readonly driverType = "postgres";
  private db: Database.Database;
  /** Tracks schema info for tables created during the test. */
  private schemas = new Map<string, ColumnDef[]>();

  /** Maps table names to the next synthetic id for SERIAL columns. */
  private serialCounters = new Map<string, number>();

  constructor() {
    this.db = new Database(":memory:");
  }

  exec(sql: string): void {
    const trimmed = sql.trim().toUpperCase();
    // Reject SQLite-specific syntax
    if (/^PRAGMA\b/.test(trimmed)) {
      throw new Error("Postgres does not support PRAGMA statements");
    }

    // Parse CREATE TABLE to track schemas
    if (/^CREATE\s+TABLE\b/i.test(sql.trim())) {
      const columns = parseCreateTable(sql);
      const nameMatch = sql.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\.)?`?(\w+)`?\s*\(/i
      );
      if (nameMatch) {
        const tableName = nameMatch[1];
        this.schemas.set(tableName.toLowerCase(), columns);
      }
    }

    // Execute in the backing SQLite DB (for actual row storage)
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.db.prepare(sql);
    const self = this;

    return {
      run(...params: unknown[]): RunResult {
        // Validate INSERTs for PK divergence
        self._validateInsert(sql, params);
        // Apply SERIAL auto-increment if needed
        self._applySerial(sql, params);
        const result = stmt.run(...params);
        return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        return stmt.get(...params) as Record<string, unknown> | undefined;
      },
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Validate that an INSERT doesn't omit a required PK column.
   * Postgres enforces NOT NULL on INTEGER PRIMARY KEY; SQLite auto-increments.
   */
  private _validateInsert(sql: string, params: unknown[]): void {
    const insertMatch = sql.match(
      /^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]*)\)\s*/i
    );
    if (!insertMatch) return; // Not an INSERT with explicit columns

    const tableName = insertMatch[1].toLowerCase();
    const columns = insertMatch[2]
      .split(",")
      .map((c) => c.trim().replace(/`/g, "").toLowerCase());

    const schema = this.schemas.get(tableName);
    if (!schema) return; // Unknown table — can't validate

    for (const col of schema) {
      if (col.isIntegerPK && !col.hasAutoincrement && !col.isSerial) {
        // INTEGER PRIMARY KEY without auto-increment — Postgres requires
        // the column to be provided in the INSERT
        if (!columns.includes(col.name.toLowerCase())) {
          throw new Error(
            `Postgres: column "${col.name}" is INTEGER PRIMARY KEY without SERIAL/AUTOINCREMENT — ` +
              `value must be provided. SQLite auto-increments this; Postgres does not.`
          );
        }
      }
    }
  }

  /**
   * For SERIAL PRIMARY KEY columns, auto-generate next value if the INSERT
   * omits the column or provides NULL.
   */
  private _applySerial(sql: string, params: unknown[]): void {
    const insertMatch = sql.match(
      /^\s*INSERT\s+INTO\s+`?(\w+)`?\s*(?:\(([^)]*)\))?\s*(?:VALUES|DEFAULT|SELECT)/i
    );
    if (!insertMatch) return;

    const tableName = insertMatch[1].toLowerCase();
    const schema = this.schemas.get(tableName);
    if (!schema) return;

    // Check if there's a SERIAL column that needs auto-generation
    const serialCol = schema.find((c) => c.isSerial);
    if (!serialCol) return;

    // If columns are explicit, check if the SERIAL column is included
    if (insertMatch[2]) {
      const columns = insertMatch[2]
        .split(",")
        .map((c) => c.trim().replace(/`/g, "").toLowerCase());
      // SERIAL column mentioned in the column list — the value in params
      // might be null/undefined, which means we should generate
      if (columns.includes(serialCol.name.toLowerCase())) {
        // Find the index of this column in the column list
        const colIdx = columns.indexOf(serialCol.name.toLowerCase());
        if (colIdx < params.length && (params[colIdx] === null || params[colIdx] === undefined)) {
          const nextId = (this.serialCounters.get(tableName) ?? 1);
          params[colIdx] = nextId;
          this.serialCounters.set(tableName, nextId + 1);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a test DB driver, optionally specifying the engine.
 *
 * @param driverType - "sqlite" (default) or "postgres".
 *                     Falls back to process.env.TEST_DB_DRIVER if omitted.
 */
export function createTestDb(driverType?: string): TestDbDriver {
  const engine = (driverType || process.env.TEST_DB_DRIVER || "sqlite").toLowerCase();
  switch (engine) {
    case "sqlite":
      return new SqliteDriver();
    case "postgres":
      return new PostgresParityDriver();
    default:
      throw new Error(`Unknown or unsupported driver type: "${engine}". Use "sqlite" or "postgres".`);
  }
}
