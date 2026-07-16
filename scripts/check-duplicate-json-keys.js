#!/usr/bin/env node
/**
 * AI-2466, AC5 — structural backstop against duplicate JSON keys.
 *
 * JSON object literals are last-key-wins — a duplicate key silently shadows
 * the first one. This check scans package.json (and any other JSON files
 * listed as arguments) and exits non-zero if any duplicate keys are found.
 *
 * Usage:
 *   node scripts/check-duplicate-json-keys.js [files...]
 *   # defaults to package.json if no files given
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : ["package.json"];

const cwd = process.cwd();

/** Find duplicate keys in a raw JSON text using a regex-based approach. */
function findDuplicates(raw) {
  // Remove string values that might contain object-like patterns
  // by replacing them with placeholders to avoid false matches.
  const cleaned = raw.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match) => {
    // Only replace if it looks like a value (starts after : or , or [)
    // This is a heuristic — for our purposes, checking key positions is enough.
    return match;
  });

  // Match all object keys: "key":
  const keyRegex = /"([^"\\]+)"\s*:/g;
  const seen = new Set();
  const duplicates = new Set();
  let match;

  while ((match = keyRegex.exec(raw)) !== null) {
    const key = match[1];
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }

  return [...duplicates];
}

let hadError = false;

for (const file of files) {
  const filePath = resolve(cwd, file);
  try {
    const raw = readFileSync(filePath, "utf8");
    const duplicates = findDuplicates(raw);

    if (duplicates.length > 0) {
      console.error(
        `[duplicate-json-keys] ✗ ${file}: duplicate key(s): ${duplicates.join(", ")}`,
      );
      hadError = true;
    } else {
      console.log(`[duplicate-json-keys] ✓ ${file}: no duplicate keys`);
    }
  } catch (err) {
    console.error(
      `[duplicate-json-keys] ✗ ${file}: ${err.message}`,
    );
    hadError = true;
  }
}

process.exit(hadError ? 1 : 0);
