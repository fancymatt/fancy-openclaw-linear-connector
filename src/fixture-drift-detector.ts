/**
 * AI-1894 AC3: Fixture-drift detector.
 *
 * Compares every deployed workflow definition (from WORKFLOW_DEFS_DIR) against
 * its canonical fixture in src/__fixtures__/. Reports warnings on divergence
 * so a live-config edit without a fixture sync is loud, not silent.
 *
 * A "match" is structural equality: the same YAML-parsed object tree after
 * stripping non-semantic header comments. Version bumps and history comments
 * in the header are NOT structural drift — only state/transition/edge changes.
 *
 * Liveness is observable at /health.fixtureDrift and via the alert bus:
 *   - healthy: all deployed defs have matching canonical fixtures
 *   - unhealthy: drift detected (one or more defs diverge)
 *
 * Design: AI-1894, Pillar 1 — deployed-fixture integrity.
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";
import { loadWorkflowRegistry } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "fixture-drift");

// ── Types ──────────────────────────────────────────────────────────────────

export interface FixtureDriftEntry {
  /** Workflow def id (e.g. "dev-impl", "task"). */
  workflowId: string;
  /** Whether the canonical fixture exists for this def. */
  fixtureExists: boolean;
  /** Whether the canonical fixture is structurally in sync. */
  inSync: boolean;
  /** Description of any drift, or null if in sync. */
  driftDescription: string | null;
}

export interface FixtureDriftStatus {
  /** ISO timestamp of the last check, or null if never run. */
  lastCheck: string | null;
  /** True only when ALL deployed defs have matching canonical fixtures. */
  healthy: boolean;
  /** Per-def drift details. */
  entries: FixtureDriftEntry[];
  /** Number of defs with drift. */
  drifted: number;
  /** Total deployed defs checked. */
  total: number;
}

// ── Singleton state ────────────────────────────────────────────────────────

let _status: FixtureDriftStatus = {
  lastCheck: null,
  healthy: true,
  entries: [],
  drifted: 0,
  total: 0,
};

// ── Fixture path resolution ────────────────────────────────────────────────

/**
 * Resolve the canonical fixture path for a given workflow id.
 * Fixtures live in src/__fixtures__/canonical-{workflowId}.yaml.
 * The fixture dir is resolved relative to the repo root, which is two
 * directories up from the src/ directory where this file lives.
 */
export function fixturePathFor(workflowId: string): string {
  // In production, fixtures live at repoRoot/src/__fixtures__/canonical-{id}.yaml.
  // We resolve relative to the module path at module load time.
  const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  return path.join(repoRoot, "src", "__fixtures__", `canonical-${workflowId}.yaml`);
}

/**
 * Parse a YAML string into a JS value, stripping comments (YAML parser
 * already does this) and normalizing for structural comparison.
 */
function parseYamlNormalized(content: string): unknown {
  return yaml.load(content);
}

/**
 * Check whether a deployed def and its canonical fixture match structurally.
 * Returns null if in sync, or a description of the drift.
 */
export async function checkDefAgainstFixture(
  deployedId: string,
  deployedContent: string,
): Promise<{
  fixtureExists: boolean;
  inSync: boolean;
  driftDescription: string | null;
}> {
  const fixturePath = fixturePathFor(deployedId);

  let fixtureContent: string;
  try {
    fixtureContent = await fs.readFile(fixturePath, "utf8");
  } catch (err) {
    return {
      fixtureExists: false,
      inSync: false,
      driftDescription: `Canonical fixture not found at ${fixturePath}`,
    };
  }

  // Compare parsed YAML objects (structural equality, ignoring comment/whitespace)
  const deployedParsed = parseYamlNormalized(deployedContent);
  const fixtureParsed = parseYamlNormalized(fixtureContent);

  const deployedStr = JSON.stringify(deployedParsed);
  const fixtureStr = JSON.stringify(fixtureParsed);

  if (deployedStr === fixtureStr) {
    return { fixtureExists: true, inSync: true, driftDescription: null };
  }

  // Identify specific differences for the drift description
  const differences: string[] = [];
  if (deployedParsed && fixtureParsed && typeof deployedParsed === "object" && typeof fixtureParsed === "object") {
    const d = deployedParsed as Record<string, unknown>;
    const f = fixtureParsed as Record<string, unknown>;
    for (const key of new Set([...Object.keys(d), ...Object.keys(f)])) {
      if (JSON.stringify(d[key]) !== JSON.stringify(f[key])) {
        differences.push(`${key}: deployed=${JSON.stringify(d[key])} fixture=${JSON.stringify(f[key])}`);
      }
    }
  }

  return {
    fixtureExists: true,
    inSync: false,
    driftDescription: `Structural drift detected: ${differences.join("; ")}`,
  };
}

// ── Main check ─────────────────────────────────────────────────────────────

/**
 * Run the full drift check across all loaded workflow defs against their
 * canonical fixtures. Writes to singleton state, alerts on any drift.
 * Never throws — errors are captured as entries.
 */
export async function runFixtureDriftCheck(): Promise<FixtureDriftStatus> {
  try {
    const registry = await loadWorkflowRegistry();
    const entries: FixtureDriftEntry[] = [];

    for (const [id, def] of registry) {
      // Serialize the def back to YAML for comparison
      const deployedContent = yaml.dump(def);
      const result = await checkDefAgainstFixture(id, deployedContent);
      entries.push({
        workflowId: id,
        fixtureExists: result.fixtureExists,
        inSync: result.inSync,
        driftDescription: result.driftDescription,
      });
    }

    const drifted = entries.filter((e) => !e.inSync).length;
    const healthy = drifted === 0;
    const lastCheck = new Date().toISOString();

    _status = { lastCheck, healthy, entries, drifted, total: entries.length };

    if (drifted > 0) {
      const driftDetails = entries
        .filter((e) => !e.inSync)
        .map((e) => `${e.workflowId}: ${e.driftDescription}`)
        .join(" | ");
      log.error(`fixture-drift: ${drifted}/${entries.length} def(s) drifted: ${driftDetails}`);
      notify({
        severity: "warning",
        source: "fixture-drift",
        title: `Fixture drift detected — ${drifted}/${entries.length} workflow def(s) out of sync`,
        detail: driftDetails,
        dedupKey: "fixture-drift|drift",
      });
    } else if (entries.length > 0) {
      log.info(`fixture-drift: all ${entries.length} deployed def(s) match canonical fixtures`);
    }

    return _status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`fixture-drift check failed to run: ${msg}`);
    _status = {
      lastCheck: new Date().toISOString(),
      healthy: false,
      entries: [],
      drifted: 0,
      total: 0,
    };
    return _status;
  }
}

/**
 * Get the latest drift check status (no re-run).
 */
export function getFixtureDriftLiveness(): FixtureDriftStatus {
  return _status;
}

/**
 * Reset status (for tests).
 */
export function resetFixtureDriftStatus(): void {
  _status = { lastCheck: null, healthy: true, entries: [], drifted: 0, total: 0 };
}
