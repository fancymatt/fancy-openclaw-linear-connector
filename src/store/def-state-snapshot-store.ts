/**
 * AI-1914 AC3 — Durable workflow-def state snapshot.
 *
 * `validateDefStateRemovals` (src/def-state-migration.ts) needs the set of
 * state ids that were active in the *previous* version of a def in order to
 * refuse a new version that silently removes a state. The registry loader is
 * file-driven and holds no memory of the previous version across a process
 * restart — the in-process `_registryCache` is null on a fresh boot. So the
 * previous-version state set must be persisted to disk.
 *
 * On every successful registry load we snapshot each ACTIVATED def's state ids
 * to a JSON map (def.id → string[]). On the next load — including the first
 * load after a restart, where no in-memory cache exists — that snapshot is the
 * `previousStateIds` source AC3 validates against.
 *
 * Path resolution mirrors every other connector store (see ac-record-store.ts):
 * the explicit WORKFLOW_DEF_STATE_SNAPSHOT_PATH override, else
 * `<DATA_DIR>/workflow-def-state-snapshot.json` (`DATA_DIR` env, else
 * `<cwd>/data`). Resolved at call time so tests can point it at a temp dir.
 *
 * Read is fail-open on a MISSING or CORRUPT file → `{}` (treated as "no prior
 * version known", i.e. a first load — every state is new, nothing is removed).
 * This is deliberate: a corrupt snapshot must not brick every def load. AC3's
 * fail-closed posture applies to the *comparison result* (a known previous
 * state that the new version drops), not to the availability of the snapshot
 * itself. Write is fail-open (logs, never throws) so a persistence hiccup does
 * not abort an otherwise-valid registry load.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "def-state-snapshot");

/** Map of workflow def id → the state ids active in the last-activated version. */
export type DefStateSnapshot = Record<string, string[]>;

/**
 * Resolve the on-disk path for the persisted def-state snapshot.
 *
 * Precedence: the explicit WORKFLOW_DEF_STATE_SNAPSHOT_PATH override, else the
 * shared data directory (`DATA_DIR` env, else `<cwd>/data`) joined with
 * "workflow-def-state-snapshot.json". Resolved at call time (not module load)
 * so DATA_DIR / the override can be set before the first load — including by
 * tests pointing it at a temp file.
 */
export function defStateSnapshotPath(): string {
  if (process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH) return process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH;
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "workflow-def-state-snapshot.json");
}

/**
 * Read the persisted def-state snapshot. Fail-open: a missing file (fresh boot)
 * or a corrupt/unparseable file returns `{}` — the caller then treats every def
 * as having no known previous version (a first load), so nothing is flagged as
 * removed. Only genuine, decodable previous state sets drive the AC3 refusal.
 */
export async function readDefStateSnapshot(): Promise<DefStateSnapshot> {
  const target = defStateSnapshotPath();
  try {
    const raw = await fs.readFile(target, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return {};
    const out: DefStateSnapshot = {};
    for (const [id, states] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(states)) {
        out[id] = states.filter((s): s is string => typeof s === "string");
      }
    }
    return out;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log.warn(
        `def-state-snapshot: failed to read snapshot at ${target} — treating as no prior version: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {};
  }
}

/**
 * Persist the def-state snapshot. Fail-open: logs and returns on any error so a
 * persistence failure never aborts an otherwise-valid registry load (the cost is
 * that the *next* load may miss a removal until the snapshot writes successfully).
 */
export async function writeDefStateSnapshot(snapshot: DefStateSnapshot): Promise<void> {
  const target = defStateSnapshotPath();
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (err: unknown) {
    log.warn(
      `def-state-snapshot: failed to persist snapshot to ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
