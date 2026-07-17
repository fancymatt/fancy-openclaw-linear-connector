/**
 * INF-42 — Workflow def conformance validator.
 *
 * Validates registered workflow definitions against structural invariants:
 *   - barrier states must declare barrier: true
 *   - every path into a barrier state must be preceded by a fanout
 *   - invariant_skip waiver keys must be recognized
 *   - fanout.child_workflow must resolve to a registered def
 *
 * ── Topology (Astrid-approved 2026-07-17) ─────────────────────────────────
 *   (c) + partial (a): validator ships in-repo, reads from src/registered-defs/
 *   in CI and WORKFLOW_DEFS_DIR on the host. Deploy gate = diff check.
 *
 * ── Invariants enforced ───────────────────────────────────────────────────
 *   barrier-before-managing:  every state in a def that has a transition to a
 *     barrier state must itself declare barrier: true on that destination.
 *   fanout-before-barrier:    every direct predecessor of a barrier:true state
 *     must declare a fanout: section.
 *   invariant_skip:           unrecognized waiver keys cause hard failure.
 *   child-workflow-resolution: every fanout.child_workflow must resolve to a
 *     registered workflow def (wf: prefix + existence in the registry).
 */

import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import type { WorkflowDef, WorkflowState } from "./workflow-gate.js";
import { getCachedRegistrySync } from "./workflow-gate.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConformanceError {
  invariant: string;
  message: string;
  state?: string;
}

export interface ConformanceResult {
  defId: string;
  file: string;
  valid: boolean;
  errors: ConformanceError[];
}

// ── Accepted waiver keys ───────────────────────────────────────────────────

export const ACCEPTED_WAIVER_KEYS: readonly string[] = [
  "barrier-before-managing",
  "fanout-before-barrier",
];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build index of state by id for quick lookup. */
function indexStates(states: WorkflowState[]): Map<string, WorkflowState> {
  const map = new Map<string, WorkflowState>();
  for (const s of states) {
    map.set(s.id, s);
  }
  return map;
}

/** Check whether a waiver is declared for a given invariant on a def. */
function hasWaiver(def: WorkflowDef, invariantKey: string): boolean {
  const skips = (def as unknown as Record<string, unknown>).invariant_skip as string[] | undefined;
  return Array.isArray(skips) && skips.includes(invariantKey);
}

/** Get the set of waiver keys from a def. */
function getWaiverKeys(def: WorkflowDef): string[] {
  return Array.isArray((def as unknown as Record<string, unknown>).invariant_skip)
    ? ((def as unknown as Record<string, unknown>).invariant_skip as string[])
    : [];
}

/** Determine if a state effectively declares barrier: true (truthy only, not just present). */
function isBarrier(state: WorkflowState): boolean {
  return (state as unknown as Record<string, unknown>).barrier === true;
}

/** Check if a state has a fanout section. */
function hasFanout(state: WorkflowState): boolean {
  return state.fanout !== undefined && state.fanout !== null;
}

/**
 * Get the set of registered def IDs from the gateway's cached registry.
 * Returns undefined if the registry hasn't been loaded yet this process lifetime.
 */
function getRegisteredDefIdsSync(): Set<string> | undefined {
  const cache = getCachedRegistrySync();
  if (cache === null || cache === undefined) return undefined;
  return new Set(cache.keys());
}

// ── Invariant checks ──────────────────────────────────────────────────────

/**
 * AC3: Check that every barrier state declares barrier: true explicitly.
 * The engine reads barrier: true directly, never deriving from native_state.
 */
function checkBarrierInvariant(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  if (hasWaiver(def, "barrier-before-managing")) return;

  // Build a set of target states that are reached from a fanout state
  const targetsFromFanout = new Set<string>();

  for (const state of def.states) {
    if (!state.transitions || !hasFanout(state)) continue;
    for (const t of state.transitions) {
      if (t.to) {
        targetsFromFanout.add(t.to);
      }
    }
  }

  // Any state that is a target from a fanout state must declare barrier: true
  const stateIndex = indexStates(def.states);
  for (const targetId of targetsFromFanout) {
    const targetState = stateIndex.get(targetId);
    if (!targetState) continue; // skip unresolvable targets
    if (!isBarrier(targetState)) {
      errors.push({
        invariant: "barrier-before-managing",
        message: `State '${targetId}' is reached from a fanout state but does not declare barrier: true. ` +
          `Add 'barrier: true' to state '${targetId}'.`,
        state: targetId,
      });
    }
  }
}

/**
 * AC4: Check that every path into a barrier:true state is preceded by a fanout
 * on the immediate predecessor.
 */
function checkFanoutBeforeBarrier(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  if (hasWaiver(def, "fanout-before-barrier")) return;

  // Find all barrier states
  const barrierStateIds = new Set(
    def.states.filter((s) => isBarrier(s)).map((s) => s.id),
  );

  if (barrierStateIds.size === 0) return;

  // For each state that has a transition to a barrier, check it has a fanout
  for (const state of def.states) {
    if (!state.transitions) continue;
    for (const t of state.transitions) {
      if (!t.to) continue;
      if (barrierStateIds.has(t.to)) {
        if (!hasFanout(state)) {
          errors.push({
            invariant: "fanout-before-barrier",
            message: `State '${state.id}' transitions to barrier state '${t.to}' but has no 'fanout:' section. ` +
              `Every direct predecessor of a barrier:true state must declare a fanout.`,
            state: state.id,
          });
        }
      }
    }
  }
}

/**
 * AC5: Check that all invariant_skip waiver keys are recognized.
 * Unrecognized keys cause hard failure — no silent misspellings.
 */
function checkWaiverKeys(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  const waiverKeys = getWaiverKeys(def);
  if (waiverKeys.length === 0) return;

  const acceptedSet = new Set(ACCEPTED_WAIVER_KEYS);
  const unrecognized = waiverKeys.filter((k) => !acceptedSet.has(k));

  if (unrecognized.length > 0) {
    errors.push({
      invariant: "invariant_skip",
      message: `Unrecognized invariant_skip key(s): ${unrecognized.join(", ")}. ` +
        `Accepted keys: ${ACCEPTED_WAIVER_KEYS.join(", ")}.`,
    });
  }
}

/**
 * AC7: Check child_workflow wf: prefix + resolve against cached registry.
 * Works both synchronously (if registry is cached) and as prefix-only fallback.
 */
function checkChildWorkflowSync(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  const wfLabelPattern = /^wf:.+/;
  const registeredIds = getRegisteredDefIdsSync();

  for (const state of def.states) {
    if (!state.fanout) continue;
    const childWf = state.fanout.child_workflow;
    if (!childWf) continue;

    // Must have wf: prefix
    if (typeof childWf !== "string" || !wfLabelPattern.test(childWf)) {
      errors.push({
        invariant: "child-workflow-resolution",
        message: `State '${state.id}' fanout.child_workflow '${String(childWf)}' is not a valid wf:* label.`,
        state: state.id,
      });
      continue;
    }

    // If we have a cached registry, check resolution
    if (registeredIds) {
      const defId = childWf.slice(3); // "wf:dev-impl" → "dev-impl"
      if (!registeredIds.has(defId)) {
        errors.push({
          invariant: "child-workflow-resolution",
          message: `State '${state.id}' fanout.child_workflow '${childWf}' resolves to '${defId}' which is not a registered workflow def.`,
          state: state.id,
        });
      }
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate a single workflow def against structural invariants (sync).
 *
 * Checks:
 *   - Waiver keys (AC5)
 *   - barrier:true declaration (AC3)
 *   - fanout before barrier (AC4)
 *   - child_workflow wf: prefix + cached registry resolution (AC7)
 */
export function validateWorkflowDef(def: WorkflowDef, _file?: string): ConformanceResult {
  const errors: ConformanceError[] = [];
  const file = _file ?? def.id;

  // Waiver key validation first
  checkWaiverKeys(def, errors);

  // Structural invariants
  checkBarrierInvariant(def, errors);
  checkFanoutBeforeBarrier(def, errors);

  // Child_workflow sync check (wf: prefix + cached registry)
  checkChildWorkflowSync(def, errors);

  return {
    defId: def.id,
    file,
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate all registered defs in a directory against all structural invariants.
 *
 * Iterates every .yaml in the directory, loads it through the engine's YAML
 * parser, and runs validateWorkflowDef on each. Returns a ConformanceResult for
 * each def found.
 *
 * Handles nonexistent directories gracefully — returns an empty result array
 * (never crashes).
 */
export function validateAllRegisteredDefs(dir?: string): ConformanceResult[] {
  const defsDir = dir ?? process.env.WORKFLOW_DEFS_DIR ?? "";

  if (!defsDir) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(defsDir);
  } catch {
    // Directory doesn't exist or is unreadable — graceful
    return [];
  }

  const yamlFiles = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const results: ConformanceResult[] = [];

  for (const file of yamlFiles) {
    const fullPath = path.join(defsDir, file);
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = yamlLoad(raw) as WorkflowDef;
      if (!parsed || typeof parsed !== "object" || !parsed.id) {
        results.push({
          defId: path.basename(file, path.extname(file)),
          file,
          valid: false,
          errors: [{
            invariant: "parse",
            message: `File '${file}' does not contain a valid workflow def (missing 'id' field).`,
          }],
        });
        continue;
      }

      const vResult = validateWorkflowDef(parsed, file);
      results.push(vResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        defId: path.basename(file, path.extname(file)),
        file,
        valid: false,
        errors: [{
          invariant: "load",
          message: `Failed to load '${file}': ${msg}`,
        }],
      });
    }
  }

  return results;
}
