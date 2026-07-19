import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createTestDb, type TestDbDriver } from "./db-driver.js";
import { detectAutoincrementDivergence, type SchemaIssue } from "./parity-checker.js";

/**
 * AC 2 (INF-99): A regression test encoding the LIF-53 scenario
 * (id-autoincrement divergence) fails on the old SQLite-only harness and
 * passes on the parity harness.
 *
 * LIF-53 root cause: `_health_probes.id INTEGER PRIMARY KEY` auto-increments
 * on SQLite (even without AUTOINCREMENT keyword) but requires SERIAL or an
 * explicit sequence on Postgres. The INSERT omitted `id`, so it worked on
 * SQLite in tests but failed in production on Postgres.
 */
describe("LIF-53 autoincrement divergence regression (AC 2)", () => {
  /**
   * SQLite-only mode replicates the old harness — the divergence is hidden
   * because SQLite auto-increments INTEGER PRIMARY KEY silently.
   */
  describe("Old SQLite-only harness (divergence hidden)", () => {
    let db: TestDbDriver;

    beforeEach(() => {
      db = createTestDb("sqlite");
      // Exact schema from LIF-53 _health_probes — no AUTOINCREMENT keyword
      db.exec(`
        CREATE TABLE IF NOT EXISTS _health_probes (
          id INTEGER PRIMARY KEY,
          probe_type TEXT NOT NULL,
          result TEXT NOT NULL,
          created_at TEXT DEFAULT current_timestamp
        )
      `);
    });

    afterEach(() => {
      db.close();
    });

    it("SQLite accepts INSERT without id (the LIF-53 divergence)", () => {
      // On SQLite, INTEGER PRIMARY KEY auto-increments even without the
      // AUTOINCREMENT keyword. This is the exact divergence: the same
      // schema and INSERT on Postgres would fail with a NOT NULL error
      // because Postgres does not auto-generate values for INTEGER PRIMARY KEY.
      const insert = db.prepare(
        "INSERT INTO _health_probes (probe_type, result) VALUES (?, ?)"
      );
      expect(() => insert.run("liveness", "healthy")).not.toThrow();
      // The inserted row should have an auto-assigned id
      const row = db
        .prepare("SELECT id FROM _health_probes WHERE probe_type = ?")
        .get("liveness") as { id: number };
      expect(row.id).toBeGreaterThan(0);
    });
  });

  /**
   * Parity-aware detection layer — must catch this pattern before it reaches
   * test assertions.
   */
  describe("Parity-aware divergence detection", () => {
    it("detects INTEGER PRIMARY KEY without SERIAL/AUTOINCREMENT", () => {
      // The _health_probes schema from LIF-53
      const schema = `
        CREATE TABLE IF NOT EXISTS _health_probes (
          id INTEGER PRIMARY KEY,
          probe_type TEXT NOT NULL,
          result TEXT NOT NULL
        )
      `;
      const issues = detectAutoincrementDivergence(schema);
      expect(issues).toHaveLength(1);
      expect(issues[0].table).toBe("_health_probes");
      expect(issues[0].column).toBe("id");
      expect(issues[0].issue).toMatch(/autoincrement|integer primary key/i);
    });

    it("passes schema with explicit SERIAL PRIMARY KEY", () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS safe_table (
          id SERIAL PRIMARY KEY,
          label TEXT NOT NULL
        )
      `;
      const issues = detectAutoincrementDivergence(schema);
      expect(issues).toHaveLength(0);
    });

    it("passes schema with explicit AUTOINCREMENT on SQLite", () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS safe_sqlite (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL
        )
      `;
      const issues = detectAutoincrementDivergence(schema);
      // SQLite AUTOINCREMENT is explicit intent — no parity issue
      expect(issues).toHaveLength(0);
    });

    it("rejects INSERT without id under Postgres parity mode", () => {
      // When running against Postgres, the driver must enforce that
      // INTEGER PRIMARY KEY columns without SERIAL/AUTOINCREMENT reject
      // INSERTs that omit the id column.
      const db = createTestDb("postgres");
      db.exec(`
        CREATE TABLE test_probes (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL
        )
      `);
      // Insert without id — must fail on Postgres parity mode
      const stmt = db.prepare("INSERT INTO test_probes (label) VALUES (?)");
      expect(() => stmt.run("hello")).toThrow(/not null|primary key|id/i);
      db.close();
    });

    it("accepts INSERT without id when schema uses SERIAL", () => {
      const db = createTestDb("postgres");
      db.exec(`
        CREATE TABLE serial_safe (
          id SERIAL PRIMARY KEY,
          label TEXT NOT NULL
        )
      `);
      const stmt = db.prepare("INSERT INTO serial_safe (label) VALUES (?)");
      expect(() => stmt.run("hello")).not.toThrow();
      db.close();
    });
  });
});
