/**
 * AI-1900 — Known-human Linear user IDs.
 *
 * Humans (Matt) are deliberately absent from agents.json, so every event on a
 * ticket assigned to a human used to trip the no-route routing pager
 * ("unknown to agents.json"). A ticket assigned to a human is a *correct*
 * no-route, not the silent "assigned it and nothing happened" failure the
 * pager exists to catch. This module resolves the configured human IDs so the
 * webhook can drop them from the pager while genuinely unknown IDs (typo'd
 * delegate, unregistered agent) keep paging.
 *
 * Config file (instance config, NOT committed to this repo):
 *   {configRoot}/config/known-humans.yaml   (override: KNOWN_HUMANS_PATH)
 *
 *   known_humans:
 *     - id: 544710ca-0438-478e-b97f-3aaee89cbb69
 *       name: Matt Henry
 *     - 00000000-0000-0000-0000-000000000000   # bare id also accepted
 *
 * Fail posture: a missing file means no known humans (pager behaves exactly
 * as before — the exclusion is opt-in). A malformed file is treated the same
 * but raises a deduped warning alert: silently losing the exclusion would put
 * the false-positive noise right back on the channel.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { instanceConfigRoot } from "./instance-config.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "known-humans");

export function knownHumansPath(): string {
  return (
    process.env.KNOWN_HUMANS_PATH ??
    path.join(instanceConfigRoot(), "config", "known-humans.yaml")
  );
}

const EMPTY: ReadonlyMap<string, string> = new Map();

let cache: { humans: ReadonlyMap<string, string>; path: string; mtimeMs: number } | null = null;

/** Test hook: drop the mtime-keyed cache. */
export function resetKnownHumansCache(): void {
  cache = null;
}

/**
 * Load the known-human map (Linear user ID → display name), cached by
 * (path, mtime) so config edits are picked up without a restart. Never throws.
 */
export function loadKnownHumans(): ReadonlyMap<string, string> {
  const file = knownHumansPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Missing file: no known humans. Expected on instances that never opt in.
    cache = { humans: EMPTY, path: file, mtimeMs: -1 };
    return EMPTY;
  }

  if (cache && cache.path === file && cache.mtimeMs === mtimeMs) return cache.humans;

  try {
    const raw = yaml.load(fs.readFileSync(file, "utf8"));
    const list = (raw as { known_humans?: unknown } | null)?.known_humans;
    if (raw !== null && (typeof raw !== "object" || (list !== undefined && !Array.isArray(list)))) {
      throw new Error("known-humans.yaml must be a mapping with a 'known_humans' list");
    }
    const humans = new Map<string, string>();
    for (const entry of (list ?? []) as unknown[]) {
      if (typeof entry === "string" && entry.trim()) {
        humans.set(entry.trim(), entry.trim());
      } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const { id, name } = entry as { id?: unknown; name?: unknown };
        if (typeof id !== "string" || !id.trim()) {
          throw new Error("known_humans entry must be a bare id string or a mapping with a string 'id'");
        }
        humans.set(id.trim(), typeof name === "string" && name.trim() ? name.trim() : id.trim());
      } else {
        throw new Error("known_humans entry must be a bare id string or a mapping with a string 'id'");
      }
    }
    cache = { humans, path: file, mtimeMs };
    return humans;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`known-humans: failed to load ${file}: ${msg} — treating as empty (no-route pager will include humans)`);
    notify({
      severity: "warning",
      source: "known-humans",
      title: "known-humans.yaml failed to load — no-route pager will page on known humans",
      detail: `${file}: ${msg}`,
    });
    cache = { humans: EMPTY, path: file, mtimeMs };
    return EMPTY;
  }
}

/** Display name for a configured known-human Linear user ID, or null. */
export function knownHumanName(linearUserId: string): string | null {
  return loadKnownHumans().get(linearUserId) ?? null;
}
