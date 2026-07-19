/**
 * INF-99 — TDD harness test-env fidelity: schema divergence detection.
 *
 * Scans CREATE TABLE statements for patterns that diverge between SQLite and
 * Postgres, focusing on the LIF-53 class of defect: `INTEGER PRIMARY KEY`
 * auto-increments silently on SQLite but not on Postgres.
 */

export interface SchemaIssue {
  table: string;
  column: string;
  issue: string;
}

/**
 * Detect columns where INTEGER PRIMARY KEY is used without AUTOINCREMENT or
 * SERIAL — a known SQLite-vs-Postgres divergence.
 *
 * On SQLite, `INTEGER PRIMARY KEY` auto-increments even without the
 * AUTOINCREMENT keyword. On Postgres, `INTEGER PRIMARY KEY` is a plain integer
 * constraint — it does not auto-generate values. This means INSERTs that omit
 * the column work on SQLite but fail on Postgres (LIF-53).
 */
export function detectAutoincrementDivergence(sql: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const tablePattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\.)?`?(\w+)`?\s*\(/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tablePattern.exec(sql)) !== null) {
    const tableName = tableMatch[1];
    // The regex consumes the opening `(` as the last character of the match.
    const openParenIdx = tableMatch.index + tableMatch[0].length - 1;
    if (sql[openParenIdx] !== "(") continue;

    // Find the matching closing paren (simple depth-count; not handling
    // nested parens inside DEFAULT or CHECK constraints for now)
    const closeParenIdx = findMatchingParen(sql, openParenIdx);
    if (closeParenIdx === -1) continue;

    const body = sql.slice(openParenIdx + 1, closeParenIdx);

    // Split on top-level commas (not inside parens of e.g. DEFAULT expressions)
    const columns = splitTopLevelCommas(body);
    for (const colDef of columns) {
      const trimmed = colDef.trim();
      // Skip constraint/table-level clauses (FOREIGN KEY, PRIMARY KEY at table level, etc.)
      if (!/^\w+/.test(trimmed)) continue;

      const colNameMatch = trimmed.match(/^`?(\w+)`?\s+/);
      if (!colNameMatch) continue;
      const colName = colNameMatch[1];

      // Check for INTEGER PRIMARY KEY without AUTOINCREMENT and without SERIAL
      const upper = trimmed.toUpperCase();
      const isIntegerPK = /INTEGER\s+PRIMARY\s+KEY/i.test(trimmed);
      const hasAutoincrement = /\bAUTOINCREMENT\b/i.test(trimmed);
      const isSerial = /SERIAL\s+(PRIMARY\s+)?KEY/i.test(trimmed);

      if (isIntegerPK && !hasAutoincrement && !isSerial) {
        issues.push({
          table: tableName,
          column: colName,
          issue: `INTEGER PRIMARY KEY without AUTOINCREMENT or SERIAL — auto-increments on SQLite but not Postgres`,
        });
      }
    }
  }

  return issues;
}

function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}
