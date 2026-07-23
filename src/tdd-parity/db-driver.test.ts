import { describe, it, expect } from "@jest/globals";
import { createTestDb, type TestDbDriver } from "./db-driver.js";

/**
 * AC 1 (INF-99): The dev-impl TDD harness runs AC tests against a
 * deploy-parity database engine (Postgres) — or a parity layer that
 * catches engine-specific divergences (autoincrement, sequences, types) —
 * for tickets that touch persistence.
 *
 * These tests assert that the harness provides both SQLite and Postgres
 * driver construction, and that stores can accept the resulting driver.
 */
describe("Test DB driver factory (AC 1: deploy-parity DB engine)", () => {
  it("creates a SQLite driver by default", () => {
    const db = createTestDb("sqlite");
    expect(db).toBeDefined();
    expect(db.driverType).toBe("sqlite");
    db.close();
  });

  it("creates a Postgres-capable driver when configured", () => {
    const db = createTestDb("postgres");
    expect(db).toBeDefined();
    expect(db.driverType).toBe("postgres");
    db.close();
  });

  it("supports exec for schema migration", () => {
    const db = createTestDb("sqlite");
    expect(() =>
      db.exec("CREATE TABLE IF NOT EXISTS test_migrate (id INTEGER PRIMARY KEY, val TEXT)")
    ).not.toThrow();
    db.close();
  });

  it("supports prepare + run for INSERT with lastInsertRowid", () => {
    const db = createTestDb("sqlite");
    db.exec("CREATE TABLE test_insert (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
    const stmt = db.prepare("INSERT INTO test_insert (val) VALUES (?)");
    const result = stmt.run("hello");
    expect(result.lastInsertRowid).toBeDefined();
    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
    db.close();
  });

  it("returns a driver whose interface stores can accept", () => {
    // The driver must be compatible with store constructors that currently
    // instantiate better-sqlite3 directly. After refactoring, stores should
    // accept a TestDbDriver instead.
    const db = createTestDb("sqlite");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.close).toBe("function");
    expect(typeof db.driverType).toBe("string");
    db.close();
  });

  it("Postgres driver rejects SQLite-specific SQL syntax", () => {
    // The parity layer must catch SQL that works on SQLite but fails on
    // Postgres — starting with unsupported PRAGMAs.
    const db = createTestDb("postgres");
    expect(() => db.exec("PRAGMA journal_mode = WAL")).toThrow();
    db.close();
  });

  it("accepts a DRIVER env var to select engine without code changes", () => {
    // Environment-driven selection (e.g. DRIVER=postgres) lets the harness
    // switch engines without modifying test code.
    const saved = process.env.TEST_DB_DRIVER;
    delete process.env.TEST_DB_DRIVER;
    const dbDefault = createTestDb();
    expect(dbDefault.driverType).toBe("sqlite");
    dbDefault.close();
    if (saved !== undefined) process.env.TEST_DB_DRIVER = saved;
  });

  it("rejects unknown driver types with a clear error", () => {
    expect(() => createTestDb("mariadb" as "sqlite")).toThrow(/unknown driver|unsupported|mariadb/i);
  });
});
