# Test Database Parity — When to Use Postgres

## Problem

The connector's test harness defaults to SQLite (`better-sqlite3`). SQLite is
fast, zero-config, and fine for logic tests — but it diverges from Postgres in
ways that can mask real defects until deploy.

**LIF-53 case:** A `_health_probes` table with `id INTEGER PRIMARY KEY` accepts
`INSERT … (probe_type, result)` without `id` on SQLite (SQLite silently
auto-increments `INTEGER PRIMARY KEY`). On Postgres the same insert fails with a
NOT NULL error because `INTEGER PRIMARY KEY` is not auto-incrementing without
`SERIAL` or a sequence. The test suite passed green; the deploy broke.

## When parity DB is required

Use the parity harness (Postgres driver) for **any ticket that touches
persistence** — specifically when your test or code:

| Scenario | Parity needed? |
|---|---|
| Creates/modifies a table schema | **Yes** — schema may use SQLite-only features |
| Reads/writes rows via SQL | **Yes** — type coercion, sequences, and autoincrement differ |
| Uses `INTEGER PRIMARY KEY` without `AUTOINCREMENT` | **Yes** — SQLite auto-increments; Postgres does not |
| Uses `SERIAL`, sequences, or explicit `AUTOINCREMENT` | **Yes** — parity ensures the intent works on both engines |
| Pure logic, no SQL, no DB interaction | **No** — use the default SQLite harness |

## How to use the parity harness

```typescript
import { createTestDb } from "../tdd-parity/db-driver.js";

// SQLite (default, fast for logic tests)
const sqliteDb = createTestDb("sqlite");

// Postgres (deploy parity — catches engine divergences)
const pgDb = createTestDb("postgres");

// Or set TEST_DB_DRIVER=postgres in env to switch all tests
const db = createTestDb(); // reads process.env.TEST_DB_DRIVER
```

## What the parity harness catches

1. **`INTEGER PRIMARY KEY` without auto-increment.** SQLite auto-increments
   these; Postgres does not. Use `SERIAL PRIMARY KEY` or
   `INTEGER PRIMARY KEY AUTOINCREMENT` for portability.
2. **`PRAGMA` statements.** Postgres has no equivalent. Remove or guard them.
3. **SQLite-only type affinity.** `BOOLEAN`, `DATETIME` — SQLite accepts any
   type name; Postgres validates.
4. **Blind `INSERT … (columns) VALUES (…)` omitting PK columns.** Works on
   SQLite with `INTEGER PRIMARY KEY`; fails on Postgres without `SERIAL`.

## Writing tests for persistence tickets

1. **Include parity tests** — at least one `describe` block using
   `createTestDb("postgres")` for every AC that touches the DB.
2. **Do not skip the SQLite test** — SQLite catches logic errors faster.
   Both engines should pass.
3. **If the real deploy target is not Postgres**, select the appropriate engine
   driver. Parity is about deploy match, not Postgres specifically.
