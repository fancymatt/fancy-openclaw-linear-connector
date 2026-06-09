/**
 * AI-1479 — Department-roster-driven routing functionary (Phase 6.5, §16.5).
 *
 * Extracts the mechanical routing/classification core into a narrow,
 * deterministic functionary driven by a `department-roster.yaml` config.
 *
 * Design goals (§7, §16.5):
 *   1. Pure function: same inputs always produce the same routing decision.
 *   2. Data-driven: routing rules come from the roster YAML, not hardcoded maps.
 *   3. Explicit escalation: unroutable requests always escalate to the steward
 *      (Astrid) instead of silently returning null.
 *   4. Layered resolution: team-prefix → delegate → assignee → mention → body-mention,
 *      with each layer having a clear fallback.
 *   5. Testable in isolation: no file I/O in the core routing function.
 *
 * The roster defines department entries keyed by Linear team prefix (e.g. "AI",
 * "ILL", "FCY"). Each department has a default routing target (agent name) and
 * optional override targets for specific event types or states.
 *
 * Fallback chain:
 *   department-roster team-prefix match → existing delegate/assignee/mention
 *   resolution → steward escalation (never null).
 *
 * Load errors are fail-open for backward compatibility — if the roster can't
 * be loaded, the system falls back to the existing agent-map routing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(), "department-roster");

// ── YAML schema types ──────────────────────────────────────────────────────

/** A single department entry in the roster. */
export interface DepartmentEntry {
  /** Human-readable department name. */
  name: string;
  /** Default routing target — the agent name that handles this department's tickets. */
  defaultTarget: string;
  /** Optional: fallback target when the default is unreachable. */
  fallbackTarget?: string;
  /** Optional: override targets for specific event types or states. */
  overrides?: Record<string, string>;
  /** Optional: team description for documentation. */
  description?: string;
}

/** The top-level department roster structure. */
export interface DepartmentRoster {
  /** Roster format version. */
  version: number;
  /**
   * Agent to escalate to when no department match is found.
   * Must be a valid agent name (e.g. "astrid").
   */
  steward: string;
  /**
   * Department entries keyed by Linear team prefix (case-insensitive).
   * E.g. { "AI": { name: "AI Team", defaultTarget: "igor" } }
   */
  departments: Record<string, DepartmentEntry>;
}

// ── Roster loading ─────────────────────────────────────────────────────────

// NOTE: DEFAULT_ROSTER_PATH points to the vault copy (canonical source of truth).
// The repo copy at config/department-roster.yaml is a convenience for local dev.
// In production, DEPARTMENT_ROSTER_PATH should be set explicitly.
const DEFAULT_ROSTER_PATH = path.resolve(
  process.env.HOME ?? "/home/fancymatt",
  "obsidian-vault/ai-systems/projects/fleet-orchestration-redesign/config/department-roster.yaml",
);

function rosterPath(): string {
  return process.env.DEPARTMENT_ROSTER_PATH ?? DEFAULT_ROSTER_PATH;
}

let _rosterCache: DepartmentRoster | null = null;

/**
 * Load the department roster from disk.
 * Results are cached in-process; call `resetRosterCache()` to force reload.
 */
export async function loadRoster(): Promise<DepartmentRoster | null> {
  if (_rosterCache) return _rosterCache;
  try {
    const raw = await fs.readFile(rosterPath(), "utf8");
    const parsed = yaml.load(raw) as DepartmentRoster;
    if (!parsed.version || !parsed.departments || !parsed.steward) {
      log.warn(`department-roster: invalid roster structure at ${rosterPath()} — missing required fields`);
      return null;
    }
    _rosterCache = parsed;
    log.info(`department-roster: loaded ${Object.keys(parsed.departments).length} department(s), steward=${parsed.steward}`);
    return _rosterCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`department-roster: no roster loaded (${msg}) — falling back to agent-map routing`);
    return null;
  }
}

/** Invalidate the in-process roster cache (used in tests). */
export function resetRosterCache(): void {
  _rosterCache = null;
}

// ── Routing functionary (pure) ─────────────────────────────────────────────

/** The result of a routing decision by the functionary. */
export interface FunctionaryResult {
  /** The resolved agent name (always set — steward on escalation). */
  target: string;
  /** Why this target was chosen. */
  reason:
    | "department-prefix"
    | "department-override"
    | "delegate"
    | "assignee"
    | "mention"
    | "body-mention"
    | "steward-escalation";
  /** True when the routing fell through to the steward. */
  escalated: boolean;
  /** The team prefix that matched, if any. */
  matchedPrefix?: string;
}

/**
 * Resolve a team identifier prefix from a Linear issue identifier.
 * E.g. "AI-1479" → "AI", "ILL-42" → "ILL".
 */
function extractTeamPrefix(identifier: string | null): string | null {
  if (!identifier) return null;
  const match = /^[A-Z]{1,10}(?=-)/i.exec(identifier);
  return match ? match[0].toUpperCase() : null;
}

/**
 * The core routing functionary — a pure, deterministic routing decision engine.
 *
 * Resolution order (§7):
 *   1. Department-roster team-prefix match (identifier → prefix → defaultTarget).
 *   2. Department-roster override for the event type/state.
 *   3. Existing mechanical resolution: delegate → assignee → mention → body-mention.
 *   4. Steward escalation (§16.5: unroutable → Astrid, never null).
 *
 * All inputs are explicit; no file I/O, no network calls, no side effects.
 *
 * @param identifier - Linear issue identifier (e.g. "AI-1479") or null.
 * @param eventType - Linear event type (e.g. "Issue", "Comment") or null.
 * @param roster - The loaded department roster, or null if unavailable.
 * @param mechanicalTarget - The result of existing delegate/assignee/mention resolution, or null.
 * @returns A FunctionaryResult with the resolved target (always non-null).
 */
export function resolveRoute(
  identifier: string | null,
  eventType: string | null,
  roster: DepartmentRoster | null,
  mechanicalTarget: { name: string; reason: "delegate" | "assignee" | "mention" | "body-mention" } | null,
): FunctionaryResult {
  // ── Layer 1: Department-roster prefix match ───────────────────────────
  if (roster) {
    const prefix = extractTeamPrefix(identifier);
    if (prefix) {
      const dept = roster.departments[prefix] ?? roster.departments[prefix.toLowerCase()];
      if (dept) {
        // Check for event-type override first.
        if (eventType && dept.overrides && dept.overrides[eventType]) {
          return {
            target: dept.overrides[eventType],
            reason: "department-override",
            escalated: false,
            matchedPrefix: prefix,
          };
        }
        return {
          target: dept.defaultTarget,
          reason: "department-prefix",
          escalated: false,
          matchedPrefix: prefix,
        };
      }
    }
  }

  // ── Layer 2: Mechanical resolution (existing logic) ───────────────────
  if (mechanicalTarget) {
    return {
      target: mechanicalTarget.name,
      reason: mechanicalTarget.reason,
      escalated: false,
    };
  }

  // ── Layer 3: Steward escalation (§16.5) ───────────────────────────────
  const steward = roster?.steward ?? "astrid";
  log.info(`routing-functionary: no department match or mechanical target for ${identifier} — escalating to steward (${steward})`);
  return {
    target: steward,
    reason: "steward-escalation",
    escalated: true,
  };
}

/**
 * Resolve the steward agent name from the roster.
 * Returns "astrid" as default if roster is not loaded.
 */
export function getSteward(roster: DepartmentRoster | null): string {
  return roster?.steward ?? "astrid";
}
