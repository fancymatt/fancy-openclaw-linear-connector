/**
 * Session key normalization for Linear connector.
 *
 * All session keys must be exactly `linear-<TEAM>-<NUMBER>` in uppercase.
 * This module strips any legacy prefixes (wake-, linear-wake-, wake-linear-)
 * and enforces uppercase identifiers.
 *
 * Usage: call `normalizeSessionKey()` at every point where a session key
 * is created or passed to the gateway, session tracker, or delivery layer.
 */

/** Linear issue identifier pattern: 1-10 uppercase letters, hyphen, 1-6 digits */
const LINEAR_ID_RE = /^([A-Z]{1,10})-(\d{1,6})$/;

/**
 * Normalize a session key to the canonical `linear-TEAM-NUMBER` format.
 *
 * Handles:
 * - `linear-ILL-152` → `linear-ILL-152` (already correct)
 * - `linear-ill-152` → `linear-ILL-152` (lowercase fix)
 * - `wake-linear-ILL-152` → `linear-ILL-152` (strip legacy prefix)
 * - `linear-wake-ILL-152` → `linear-ILL-152` (strip legacy prefix)
 * - `ILL-152` → `linear-ILL-152` (add prefix)
 * - `ill-152` → `linear-ILL-152` (fix + add prefix)
 *
 * Returns the normalized key, or throws if no valid Linear identifier found.
 */
export function normalizeSessionKey(key: string): string {
  if (!key || typeof key !== "string") {
    throw new Error(`Invalid session key: ${key}`);
  }

  // Strip known legacy prefixes
  let cleaned = key
    .replace(/^wake-linear-/i, "")   // wake-linear-ILL-152
    .replace(/^linear-wake-/i, "")   // linear-wake-ILL-152
    .replace(/^wake-/i, "")          // wake-ILL-152
    .replace(/^linear-/i, "");       // linear-ILL-152 → ILL-152

  // Force uppercase (handles lowercase like ill-152 → ILL-152)
  cleaned = cleaned.toUpperCase();

  // Validate the identifier matches TEAM-NUMBER pattern
  if (!LINEAR_ID_RE.test(cleaned)) {
    throw new Error(
      `Cannot normalize session key "${key}": "${cleaned}" is not a valid Linear identifier`
    );
  }

  return `linear-${cleaned}`;
}

/**
 * Check if a string looks like it might contain a Linear identifier
 * and return the normalized key, or null if not parseable.
 * Safe variant that doesn't throw.
 */
export function tryNormalizeSessionKey(key: string): string | null {
  try {
    return normalizeSessionKey(key);
  } catch {
    return null;
  }
}
