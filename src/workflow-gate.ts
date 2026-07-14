/**
 * Phase 3 / B1 — Workflow-def-driven inbound command validation (AI-1352).
 * Phase 3 / B2 — Atomic state-label transition application (AI-1353).
 * Layer 2 — Raw status/assignee mutation interception (AI-1387).
 *
 * B1: Generalizes the Phase 2 single-rule escalation-gate (escalation-gate.ts) into
 * a full legal-move validator driven by the workflow definition YAML. The rule
 * table in the escalation-gate is superseded by this data-driven approach for
 * workflow tickets; both checks run in proxy.ts (defense in depth).
 *
 * B2: After a legal command is forwarded upstream, the proxy applies the state
 * transition by atomically swapping the old state:* label for the new one via a
 * single issueUpdate mutation. The proxy owns the transition (not the CLI) so
 * the state change is coupled to the validated forward — an agent cannot skip it.
 * State is derived independently via a fresh label fetch; agent-supplied state is
 * never trusted (§11). Fails open on any API error — label update failures are
 * logged but do not fail the proxied request.
 *
 * For workflow tickets (wf:*):
 *   1. Resolves the ticket's current state from its state:* label via an independent
 *      Linear query — the proxy NEVER trusts agent-supplied state (§11).
 *   2. Rejects any command not in the legal set for that state, naming the legal moves.
 *   3. Break-glass (escape) is always legal from every state (§4.4).
 *   4. Deploy requires deploy:execute capability; only the deployment body (Hanzo) holds it.
 *   5. On a forwarded legal command, swaps state:old → state:new in one mutation.
 *
 * Ad-hoc tickets (no wf:* label) are full pass-through — §4.6 mode switch.
 *
 * Fail-open posture (slice-1 carry-forward, AI-1347): fails open on missing
 * issueId / intent / label-fetch error. Phase 3 hardening to derive intent/issue
 * from the request body itself is a separate follow-up — do not block on it here.
 * TODO(AI-1347): derive intent/issue from request body when headers are absent.
 *
 * Design: design.md §4.2, §4.4, §4.6, §11, §13, §16.1, §16.2.
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { defaultWorkflowDefPath } from "./instance-config.js";
import { bodyHasCapability, resolveBodiesForRole } from "./escalation-gate.js";
import type { ObservationStore } from "./store/observation-store.js";
import { recordObservation } from "./store/observation-write-path.js";
import { isBodyKnown } from "./escalation-gate.js";
import { getAgent, getAgents } from "./agents.js";
import { executeFanout, shouldTriggerFanout, validateFanoutSpec, type Finding } from "./fanout.js";
import { onChildTerminal, onManagingEntry, isTerminalState } from "./barrier.js";
import { resolveDisposition, dispositionToDone, dispositionToSpawning } from "./review.js";
import { bindArtifact, getBoundArtifact, removeArtifact } from "./artifact-store.js";
import { recordSuccess, recordFailure, isHealthy as isConfigHealthy } from "./config-health.js";
import { captureAc, extractAcFromDescription, removeAcRecord } from "./ac-record-store.js";
import { validateDefStateRemovals } from "./def-state-migration.js";
import { readDefStateSnapshot, writeDefStateSnapshot } from "./store/def-state-snapshot-store.js";
import { recordImplementer, getImplementer, removeImplementer } from "./implementer-store.js";
import { recordAppliedState, clearAppliedState, getAppliedState } from "./store/applied-state-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { reposWithoutCiAutoDeploy, githubRepoFromUrl } from "./deploy-policy.js";
import { notify } from "./alerts/alert-bus.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";

/**
 * Phase 6.5 / H-6: Label read-only projection + override path + drift reconciliation.
 *
 * **Store is the sole writer of truth.** Labels (`wf:*`, `state:*`) are a read-only projection
 * re-derived as the ticket advances; nothing in the engine reads state back out of labels.
 *
 * **Override = steward-issued proxy command.** A human who wants to move a ticket out-of-band
 * does so through a steward proxy command that updates the store and re-projects the labels
 * — a first-class transition, not a hand-edit.
 *
 * **Drift reconciliation.** A label that diverges from the store (e.g. hand-edited in the
 * Linear UI) is overwritten on the next reconcile pass and an alert is emitted. The label
 * never wins.
 *
 * **Atomic projection.** On advance, remove old `state:` and add new in one op; never two
 * `state:` labels at once.
 *
 * Design: design.md §4.2, §4.4, §4.6, §11, §13, §16.1, §16.2, and H-6.
 */

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-gate");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Resolve the workflow def path dynamically (reads env each call so test beforeAll works). */
function workflowDefPath(): string {
  return process.env.WORKFLOW_DEF_PATH ?? defaultWorkflowDefPath();
}

// ── YAML schema types ──────────────────────────────────────────────────────

export interface WorkflowTransition {
  command: string;
  to: string;
  requires_capability?: string;
  /** Matt directive 2026-07-12: opt-in designated-approver semantics. When true
   *  (and requires_capability is set), a caller holding that capability may fire
   *  THIS transition without being the ticket's delegate — how a def nominates a
   *  sign-off authority (e.g. Ai's sprint:signoff on sprint-spawner). Absent/false
   *  keeps the delegate-only gate intact even for capability holders (dev-impl's
   *  deploy stays delegate-bound — G-13 AC1 semantics). */
  designated_approver?: boolean;
  /** §5.7 item 1: if true, this transition requires a bound artifact ref (e.g. sprint-plan doc). */
  requires_artifact?: boolean;
  feedback?: { required?: boolean; category_enum?: string[] };
  assign?: {
    mode?: 'required' | 'auto' | 'none';
    constraint?: string;
    default?: string;
  };
  /** Phase 6.5 / H-7 (AI-1482): if true, capture verbatim AC from issue description at accept time. */
  capture_ac?: boolean;
  /** Phase 6.5 / H-7 (AI-1482): if true, requires human sign-off when stakes >= threshold. */
  requires_human_signoff_above_stakes?: boolean;
  /** If true, a comment must accompany this transition. Surfaced in delivery messages and enforced by the CLI. */
  requires_comment?: boolean;
  /** Generic transition role: 'continue' maps to `linear continue-workflow`, 'revision' maps to `linear request-revision`. */
  generic?: 'continue' | 'revision';
}

/**
 * AI-1992: Declarative fan-out configuration for a workflow state.
 *
 * A state that declares a `fanout` block spawns N child workflow tickets when
 * its (non-break-glass) transition command fires. The child workflow type,
 * spec source, initial delegate, and sibling-blocking behavior are all driven
 * by this config — replacing the hardcoded `ux-audit`/`sprint` allowlist and
 * the hardcoded `wf:dev-impl` child label in fanout.ts.
 */
export interface FanoutConfig {
  /** Structured section of the parent ticket description that supplies the
   *  fan-out cardinality (e.g. "findings" → the `## Findings` section). */
  spec_source: string;
  /** Child workflow label to mint each child under. MUST be a `wf:*` label —
   *  validated at config-load AND at spawn time (AC7). Non-wf child types are
   *  rejected: a wf ticket spawns only wf tickets (Matt, 2026-07-08, Option B). */
  child_workflow: string;
  /** Optional body id to delegate each spawned child to at creation time. */
  initial_delegate?: string;
  /** When true, create sibling blocking relations between the spawned children
   *  at spawn time (each sibling blocks the next). */
  block_siblings?: boolean;
}

export interface WorkflowState {
  id: string;
  owner_role?: string;
  kind?: string;
  /** AI-1992: declarative fan-out config. When present, the state's forward
   *  (non-break-glass) transition mints N children per {@link FanoutConfig}. */
  fanout?: FanoutConfig;
  /** AI-1992: when true, this managing state is an N→1 barrier — the engine
   *  auto-advances the parent along this state's forward transition once every
   *  linked child reaches a terminal state. Replaces the hardcoded
   *  BARRIER_WORKFLOWS set; barrier-ness is now per-state, any workflow id. */
  barrier?: boolean;
  /** AI-1490: semantic native Linear state this workflow state projects to.
   *  Must be a key in the CLI's SEMANTIC_STATE_MAP (doing, thinking, done, invalid, etc.)
   *  or a literal Linear state name. Validated at connector startup. */
  native_state?: string;
  /** §5.5: per-state SLA as a duration string (e.g. "24h", "90m", "3600000").
   *  Time-in-state beyond this trips stall escalation (parsed to ms by barrier). */
  sla?: string;
  /** AI-1666: per-state no-activity timeout in seconds. Overrides the global
   *  NO_ACTIVITY_FAIL_MS for dispatches in this state. Steps with no override
   *  inherit the global default. Use for states with known-slow sub-processes
   *  (e.g. image generation) to avoid spurious failure re-dispatches. */
  noActivityTimeout?: number;
  /** When true, the delivery message for this state will include the most recent ticket
   *  comment as inline context. Useful for states where the previous step's output
   *  (e.g. a brief) must be immediately visible to the incoming delegate. */
  deliverLastComment?: boolean;
  /** Reference documents for this state. Paths are injected into the delivery message
   *  so the agent knows exactly where to read before acting. */
  resources?: Array<{ path: string; label?: string; description?: string }>;
  transitions?: WorkflowTransition[];
}

export interface StakesLevel {
  /** Map of stakes:* label names to numeric levels (e.g. stakes:low → 0, stakes:high → 2). */
  levels: Record<string, number>;
  /** Tickets at or above this level require human sign-off. */
  threshold: number;
}

export interface WorkflowDef {
  id: string;
  version?: number;
  archetype?: string;
  entry_state?: string;
  /** §4.4: break_glass.command is the x-openclaw-linear-intent value for escape. */
  break_glass?: { command: string; to?: string; owner_role?: string };
  /**
   * AI-1579: recovery actor(s) — body id(s) (e.g. `ai`) permitted to re-establish
   * a delegate on a governed ticket whose delegate is currently EMPTY (orphaned),
   * at ANY state, even one whose owner_role they do not fill. This is the
   * authorization counterpart to the stale-session recovery machinery: when a
   * delegate's session dies without advancing the ticket, recovery clears the
   * delegate and must re-dispatch by writing a new delegateId — a raw write from
   * `ai`, which the role-based first-delegate check would otherwise block. Scoped
   * to the empty-delegate path only, so it can never steal a live delegate.
   */
  recovery_actor?: string | string[];
  /** Phase 6.5 / H-7 (AI-1482): stakes-threshold configuration for human sign-off gate. */
  stakes?: StakesLevel;
  /**
   * AI-1914 AC1: map of removed-state-id → target-state-id. When a def version
   * removes a state, a mapping here lets the def-load migration runner atomically
   * migrate any governed ticket stranded at the removed state to the target
   * state (label swap + re-dispatch to the target state's owner role).
   */
  migrations?: Record<string, string>;
  /**
   * AI-1914 AC3: removed state ids explicitly acknowledged as lossy strands. A
   * def that removes a state with neither a `migrations` mapping nor a
   * `strand_acknowledged` entry fails validation (refuses to activate) rather
   * than silently stranding in-flight tickets.
   */
  strand_acknowledged?: string[];
  states: WorkflowState[];
}

// ── Workflow def cache & registry ──────────────────────────────────────────
// AI-1530: a single registry cache is the sole source of truth. loadWorkflowDef
// (the legacy single-def accessor) derives its def from the same registry so the
// two cannot diverge — resetWorkflowCache() invalidates everything at once.

let _registryCache: Map<string, WorkflowDef> | null = null;

/**
 * Read, parse, and validate a single workflow def file. Throws on read/parse
 * failure or if native_state validation fails (AI-1490 / AI-1498 fail-closed
 * posture: the proxy must be able to write a native stateId for every state).
 * Performs no config-health accounting — callers own that.
 */
async function loadDefFromFile(file: string): Promise<WorkflowDef> {
  const raw = await fs.readFile(file, "utf8");
  const def = yaml.load(raw) as WorkflowDef;
  if (!def || typeof def !== "object" || !def.id) {
    throw new Error(`workflow def at ${file} has no 'id' field`);
  }
  if (def.break_glass && !def.break_glass.command) {
    log.warn(`workflow-gate: break_glass block in ${file} has no 'command' field — falling back to hardcoded "escape". Canonicalize the YAML to add command: escape.`);
  }
  const warnings = validateNativeStateMappings(def);
  for (const w of warnings) {
    log.error(`workflow-gate: native_state validation FAILURE (${def.id}): ${w}`);
  }
  if (warnings.length > 0) {
    throw new Error(
      `Workflow definition '${def.id}' has ${warnings.length} invalid native_state mapping(s): ${warnings.join("; ")}`,
    );
  }
  // AI-1992: fanout/barrier config validation (fail-closed). A def whose fanout
  // child_workflow is not a wf:* label, or whose barrier field is non-boolean,
  // is excluded from the registry — the engine never spawns a non-wf child.
  const fbWarnings = validateFanoutBarrierConfig(def);
  for (const w of fbWarnings) {
    log.error(`workflow-gate: fanout/barrier validation FAILURE (${def.id}): ${w}`);
  }
  if (fbWarnings.length > 0) {
    throw new Error(
      `Workflow definition '${def.id}' has ${fbWarnings.length} invalid fanout/barrier config(s): ${fbWarnings.join("; ")}`,
    );
  }
  return def;
}

/**
 * Legacy single-def accessor. Returns the primary workflow def, derived from the
 * registry so its cache stays coherent with loadWorkflowRegistry().
 *   - Single-file mode (no WORKFLOW_DEFS_DIR): the registry holds exactly the
 *     WORKFLOW_DEF_PATH def — return it (preserving prior behavior and its
 *     fail-closed-on-load posture, which loadWorkflowRegistry rethrows).
 *   - Dir mode: return the def named by WORKFLOW_DEF_PATH if present in the
 *     registry, else the first registered def.
 */
export async function loadWorkflowDef(): Promise<WorkflowDef> {
  const registry = await loadWorkflowRegistry();

  if (!process.env.WORKFLOW_DEFS_DIR) {
    const only = registry.values().next().value as WorkflowDef | undefined;
    if (!only) {
      const msg = `no workflow def loaded from ${workflowDefPath()}`;
      recordFailure("workflow-def", msg);
      throw new Error(msg);
    }
    return only;
  }

  let primaryId: string | null = null;
  try {
    primaryId = (await loadDefFromFile(workflowDefPath())).id;
  } catch {
    primaryId = null;
  }
  if (primaryId && registry.has(primaryId)) return registry.get(primaryId)!;
  const first = registry.values().next().value as WorkflowDef | undefined;
  if (!first) throw new Error(`no workflow def loaded`);
  return first;
}

/**
 * Registry-aware per-workflow def lookup. Returns the WorkflowDef whose id
 * matches the given workflowId (derived from a ticket's wf:<id> label),
 * or null if the registry has no matching def.
 *
 * This is the correct accessor for enforcement paths that know which workflow
 * a ticket belongs to — unlike loadWorkflowDef() which always returns the
 * single primary def regardless of workflowId. Use this anywhere that has
 * a workflowId available so non-dev-impl workflows (ux-audit, sprint, etc.)
 * get their own def enforcement instead of silently passing through.
 */
export async function loadWorkflowDefById(workflowId: string): Promise<WorkflowDef | null> {
  const registry = await loadWorkflowRegistry();
  return registry.get(workflowId) ?? null;
}

/**
 * AI-1530: Load ALL workflow defs into a registry keyed by def.id.
 *
 * This is the dispatch source for multi-workflow enforcement: the gate resolves
 * a ticket's def by its wf:<id> label via this registry, instead of comparing
 * against a single loaded def. After this lands, dev-impl, ux-audit and sprint
 * can all be enforced simultaneously by the same connector.
 *
 * Directory resolution:
 *   - If WORKFLOW_DEFS_DIR is set, load every *.yaml in that directory.
 *   - Otherwise (backwards-compat), load the single WORKFLOW_DEF_PATH file as a
 *     1-entry registry — preserving the current single-def deploy exactly (AC6).
 *
 * Per-def fail-closed (AC2): a def that fails native_state validation (or fails
 * to parse) is excluded from the registry and surfaced via logs + config-health,
 * while every other valid def still loads. In single-file mode a load failure
 * rethrows, preserving the existing fail-closed posture for the primary deploy.
 *
 * The result is cached; resetWorkflowCache() clears it (AC5) so a vault edit is
 * picked up on the next load without a code rebuild.
 */
export async function loadWorkflowRegistry(): Promise<Map<string, WorkflowDef>> {
  if (_registryCache) return _registryCache;
  const registry = new Map<string, WorkflowDef>();
  const dir = process.env.WORKFLOW_DEFS_DIR || process.env.WORKFLOW_DEF_DIR || undefined;

  // AC3 (AI-1914): the state ids active in the previous version of each def,
  // persisted to disk so this check survives a restart (where _registryCache is
  // null). A def version that removes a state present here — without a migrations
  // mapping or a strand_acknowledged entry — must not activate.
  const prevSnapshot = await readDefStateSnapshot();

  if (dir) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      // Catastrophic: the defs directory itself is unreadable. Surface and
      // rethrow so enforcement callers fail closed.
      const msg = err instanceof Error ? err.message : String(err);
      recordFailure("workflow-def", `WORKFLOW_DEFS_DIR unreadable (${dir}): ${msg}`);
      throw err;
    }
    const yamlFiles = entries.filter((f) => f.endsWith(".yaml")).sort();
    let failures = 0;
    for (const f of yamlFiles) {
      const full = path.join(dir, f);
      try {
        const def = await loadDefFromFile(full);
        if (registry.has(def.id)) {
          log.warn(`workflow-gate: duplicate workflow id '${def.id}' (${full}) — keeping first, ignoring this file`);
          continue;
        }
        // AC3: refuse to activate a def version that silently removes a state
        // relative to its last-activated version. Throwing here routes through
        // the same per-def fail-closed path as a native_state failure: the def
        // is excluded from the registry and config-health goes unhealthy, while
        // every other valid def still loads. The operator's remedy is to add a
        // migrations mapping or a strand_acknowledged entry — which is exactly
        // the sanctioned, non-lossy path AC1/AC2 provide.
        const removalErrors = validateDefStateRemovals(prevSnapshot[def.id] ?? [], def);
        if (removalErrors.length > 0) {
          throw new Error(removalErrors.join("; "));
        }
        registry.set(def.id, def);
      } catch (err) {
        // AC2: one bad def fails that def only — exclude it, keep the rest.
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`workflow-gate: workflow def excluded from registry (${full}): ${msg}`);
      }
    }
    if (failures > 0) {
      recordFailure("workflow-def", `${failures} workflow def(s) excluded from registry (see logs)`);
    } else {
      recordSuccess("workflow-def");
    }
  } else {
    // Backwards-compat (AC6): single WORKFLOW_DEF_PATH file → 1-entry registry.
    // A load failure rethrows here (fail-closed) exactly as the legacy single-def
    // loader did, so the current deploy's safety posture is unchanged.
    try {
      const def = await loadDefFromFile(workflowDefPath());
      // AC3: single-file mode rethrows on removal (fail-closed), matching this
      // path's existing posture — the primary deploy does not activate a def
      // that would silently strand its in-flight tickets.
      const removalErrors = validateDefStateRemovals(prevSnapshot[def.id] ?? [], def);
      if (removalErrors.length > 0) {
        throw new Error(removalErrors.join("; "));
      }
      registry.set(def.id, def);
      recordSuccess("workflow-def");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFailure("workflow-def", msg);
      throw err;
    }
  }

  // AC3: persist a durable snapshot of the ACTIVATED defs' state sets so the
  // next load — including the first load after a restart — can detect removals
  // relative to this version. Only defs that actually activated are updated;
  // an excluded/rejected def keeps its prior snapshot entry, so a persistently
  // unsafe def keeps being refused rather than being "accepted" by its own
  // rejected state set overwriting the baseline.
  if (registry.size > 0) {
    const nextSnapshot = { ...prevSnapshot };
    for (const [id, def] of registry) {
      nextSnapshot[id] = def.states.map((s) => s.id);
    }
    await writeDefStateSnapshot(nextSnapshot);
  }

  _registryCache = registry;
  return registry;
}

/** Invalidate the in-process workflow registry cache (used in tests & live-reload). */
export function resetWorkflowCache(): void {
  _registryCache = null;
}

/**
 * AI-1872: Workflow registry liveness for /health.
 *
 * Returns a compact map of `{ [workflowId]: { version, states[] } }` derived
 * from the live registry cache, so ac-validate can confirm the updated
 * workflow def is loaded without waiting for a dispatch trigger.
 *
 * Mirrors getCanonLiveness() / getDocsLiveness() pattern. Failures return an
 * empty object — /health still responds 200; the absence of the expected entry
 * is the ac-validate failure signal.
 */
export async function getWorkflowRegistryLiveness(): Promise<Record<string, {
  version: number | undefined;
  states: string[];
}>> {
  try {
    const registry = await loadWorkflowRegistry();
    const out: Record<string, { version: number | undefined; states: string[] }> = {};
    for (const [id, def] of registry) {
      out[id] = {
        version: def.version,
        states: (def.states ?? []).map((s) => s.id),
      };
    }
    return out;
  } catch {
    // Fail-open: missing/unreadable def → empty registry. The config-health
    // fail-closed path already handles the enforcement side.
    return {};
  }
}

// ── AI-1666: Per-ticket no-activity timeout cache ─────────────────────────
// Populated by applyStateTransition when a ticket enters a state that declares
// noActivityTimeout. Keyed by uppercase Linear identifier (e.g. "AI-1234").
// The no-activity detector reads this to use per-state timeouts instead of the
// global default. Cleared when the ticket leaves a state with a custom timeout.

const _noActivityTimeoutCache = new Map<string, number>();

function _noActivityTimeoutKey(issueId: string): string {
  return issueId.replace(/^linear-/i, "").trim().toUpperCase();
}

/** Return the per-state no-activity timeout in ms for this ticket, or undefined. */
export function getTicketNoActivityTimeoutMs(ticketId: string): number | undefined {
  return _noActivityTimeoutCache.get(_noActivityTimeoutKey(ticketId));
}

/** Test helper — reset the no-activity timeout cache between cases. */
export function _resetNoActivityTimeoutCache(): void {
  _noActivityTimeoutCache.clear();
}

/**
 * AI-1498: Semantic-to-native mapping — mirrors the CLI's SEMANTIC_STATE_MAP
 * so the proxy can resolve native Linear stateId UUIDs without depending on the CLI.
 * Each semantic state maps to an ordered list of candidate Linear workflow state names;
 * the first match found in the team's actual states wins.
 * Keep in sync with the CLI's SEMANTIC_STATE_MAP when new semantic names are added.
 */
const SEMANTIC_STATE_MAP: Record<string, string[]> = {
  backlog: ["Backlog"],
  todo: ["Todo", "To Do", "To Develop"],
  thinking: ["Thinking", "In Progress"],
  doing: ["Doing", "In Progress", "Developing"],
  managing: ["Managing"],
  done: ["Done"],
  invalid: ["Invalid", "Canceled", "Cancelled"],
};

/**
 * Valid semantic state names that the CLI's SEMANTIC_STATE_MAP recognizes.
 * AI-1490: used to validate that every workflow state's native_state field
 * maps to a real CLI semantic state (which in turn resolves to an actual
 * Linear workflow state per team).
 */
const VALID_SEMANTIC_STATES = new Set(Object.keys(SEMANTIC_STATE_MAP));

/**
 * AI-1490 / AI-1498: Validate that every workflow state has a valid native_state field.
 * AI-1498 hardens this from warn → hard-fail for non-terminal states: a missing or
 * invalid native_state means the proxy cannot compute the native Linear stateId,
 * making desync structurally impossible. Returns an array of diagnostic errors.
 * The caller should throw when errors is non-empty for governed workflows.
 */
export function validateNativeStateMappings(def: WorkflowDef): string[] {
  const warnings: string[] = [];
  for (const state of def.states) {
    if (!state.native_state) {
      // AI-1498: hard-fail for ALL states (terminal and non-terminal).
      // A terminal state without native_state means done/escape tickets land
      // in an undefined native column — exactly the projection bugs this ticket fixes.
      warnings.push(
        `Workflow state '${state.id}' has no native_state field — its native Linear state projection is undefined. ` +
        `Add a native_state field (e.g. 'doing', 'thinking', 'todo', 'done', 'invalid').`,
      );
      continue;
    }
    if (!VALID_SEMANTIC_STATES.has(state.native_state)) {
      warnings.push(
        `Workflow state '${state.id}' has native_state '${state.native_state}' which is not a recognized semantic state. ` +
        `Valid options: ${[...VALID_SEMANTIC_STATES].join(", ")}.`,
      );
    }
  }
  return warnings;
}

/**
 * AI-1992: Validate the fanout/barrier config of a workflow def (fail-closed).
 *
 * A fanout block's `child_workflow` MUST be a `wf:*` label — a wf ticket spawns
 * only wf tickets (Matt, 2026-07-08, Option B). A `barrier` field, when present,
 * MUST be a boolean. Returns diagnostic errors; a non-empty result excludes the
 * def from the registry (the loader throws), so the engine can never fan out to
 * a non-workflow child type or misread a malformed barrier flag.
 */
export function validateFanoutBarrierConfig(def: WorkflowDef): string[] {
  const errors: string[] = [];
  const wfLabelPattern = /^wf:.+/;
  for (const state of def.states) {
    if (state.fanout !== undefined) {
      const fo = state.fanout as unknown;
      if (fo === null || typeof fo !== "object") {
        errors.push(`Workflow state '${state.id}' has a non-object fanout block.`);
      } else {
        const cfg = fo as Partial<FanoutConfig>;
        if (typeof cfg.spec_source !== "string" || cfg.spec_source.trim() === "") {
          errors.push(`Workflow state '${state.id}' fanout is missing a non-empty 'spec_source'.`);
        }
        if (typeof cfg.child_workflow !== "string" || !wfLabelPattern.test(cfg.child_workflow)) {
          errors.push(
            `Workflow state '${state.id}' fanout child_workflow '${String(cfg.child_workflow)}' is not a wf:* label. ` +
            `A workflow ticket may spawn only workflow children (wf:*).`,
          );
        }
        if (cfg.initial_delegate !== undefined && typeof cfg.initial_delegate !== "string") {
          errors.push(`Workflow state '${state.id}' fanout initial_delegate must be a string when present.`);
        }
        if (cfg.block_siblings !== undefined && typeof cfg.block_siblings !== "boolean") {
          errors.push(`Workflow state '${state.id}' fanout block_siblings must be a boolean when present.`);
        }
      }
    }
    if (state.barrier !== undefined && typeof state.barrier !== "boolean") {
      errors.push(`Workflow state '${state.id}' barrier field must be a boolean when present.`);
    }
  }
  return errors;
}

// ── AI-1498: Native state resolution cache ────────────────────────────────
// Maps (teamId, semanticName) → Linear workflow state UUID.
// Resolved once per team, cached indefinitely. Invalidated on cache reset.

/** Cache: teamId → array of team workflow states from Linear API. */
let _teamStateCache: Map<string, Array<{ id: string; name: string; type: string }>> = new Map();

/** Reset the native-state cache (used in tests). */
export function resetNativeStateCache(): void {
  _teamStateCache.clear();
}

/**
 * Fetch a team's workflow states from Linear (with caching).
 * Returns the raw state nodes for the team.
 */
async function fetchTeamWorkflowStates(
  teamId: string,
  authToken: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const cached = _teamStateCache.get(teamId);
  if (cached) return cached;

  const query = `
    query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { teamId } }),
    });
    type Resp = { data?: { team?: { states?: { nodes: Array<{ id: string; name: string; type: string }> } } } };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.team?.states?.nodes ?? [];
    _teamStateCache.set(teamId, nodes);
    return nodes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: team state fetch failed for team=${teamId}: ${msg}`);
    return [];
  }
}

/**
 * AI-1498: Resolve a semantic native_state name (e.g. "doing", "done") to the actual
 * Linear workflow state UUID for the given team. Uses the same SEMANTIC_STATE_MAP
 * candidate-order resolution as the CLI so the proxy and CLI always agree.
 * Returns null if the state cannot be resolved.
 */
export async function resolveNativeStateId(
  teamId: string,
  semanticName: string,
  authToken: string,
): Promise<string | null> {
  const candidates = SEMANTIC_STATE_MAP[semanticName.toLowerCase()];
  if (!candidates) {
    log.warn(`workflow-gate: resolveNativeStateId: unknown semantic name '${semanticName}'`);
    return null;
  }
  const states = await fetchTeamWorkflowStates(teamId, authToken);
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  for (const candidate of candidates) {
    const match = states.find((s) => normalize(s.name) === normalize(candidate));
    if (match) return match.id;
  }
  log.warn(
    `workflow-gate: resolveNativeStateId: no match for '${semanticName}' (tried: ${candidates.join(", ")}) in team ${teamId}`,
  );
  return null;
}

// ── Label fetch ────────────────────────────────────────────────────────────

interface LabelNode {
  id: string;
  name: string;
  /** AI-2176: true when this label is a Linear label GROUP (container), not a
   *  regular label. Only populated by queries that select it (findOrCreateLabel);
   *  undefined elsewhere. */
  isGroup?: boolean;
  /** AI-2176: the parent group of this label, when it is a group child. */
  parent?: { id: string; name: string } | null;
}

interface TicketContext {
  labels: string[];
  /** Linear user ID of the current delegate, or null if unset. */
  delegateId: string | null;
  /** True when the context fetch itself failed (network error, API error, etc.). */
  fetchFailed: boolean;
}

/**
 * Fetch label names and delegate for a Linear issue using the caller's auth token.
 * Independent of escalation-gate's label fetch — the proxy resolves state
 * from its own query and never trusts agent-supplied values (§11).
 *
 * Phase 6.5 / H-1: Returns fetchFailed=true on error so callers can
 * decide fail-open vs fail-closed. When the fetch fails, we cannot determine
 * whether the ticket is a workflow ticket, so the caller must apply the
 * configured posture.
 */
async function fetchTicketContext(issueId: string, authToken: string): Promise<TicketContext> {
  const query = `query IssueContext($id: String!) { issue(id: $id) { labels { nodes { name } } delegate { id } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type ContextResp = {
      data?: {
        issue?: {
          labels?: { nodes: Array<{ name: string }> };
          delegate?: { id: string } | null;
        };
      };
    };
    const data = (await res.json()) as ContextResp;
    const issue = data.data?.issue;
    if (!issue) {
      log.warn(`workflow-gate: issue ${issueId} not found in context fetch — returning fetchFailed`);
      return { labels: [], delegateId: null, fetchFailed: true };
    }
    return {
      labels: (issue?.labels?.nodes ?? []).map((n) => n.name),
      delegateId: issue?.delegate?.id ?? null,
      fetchFailed: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: context fetch failed for ${issueId}: ${msg}`);
    return { labels: [], delegateId: null, fetchFailed: true };
  }
}

/**
 * Fetch label nodes with IDs plus the team ID for a Linear issue.
 * Used by B2 to build the label set for the atomic state swap mutation.
 * Returns null on any error — caller fails open.
 */
async function fetchIssueWithLabels(
  issueId: string,
  authToken: string,
): Promise<{ internalId: string; identifier: string; teamId: string; labels: LabelNode[] } | null> {
  const query = `
    query IssueWithLabels($id: String!) {
      issue(id: $id) {
        id
        identifier
        team { id }
        labels { nodes { id name } }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          id: string;
          identifier: string;
          team: { id: string };
          labels: { nodes: LabelNode[] };
        };
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return { internalId: issue.id, identifier: issue.identifier, teamId: issue.team.id, labels: issue.labels.nodes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: issue fetch failed for ${issueId}: ${msg}`);
    return null;
  }
}

/**
 * Resolve the set of `state:*` label IDs in the team that owns the given issue.
 *
 * AI-1612: the proxy is the sole writer of the workflow state label. To enforce
 * that, it strips `state:*` label deltas from the forwarded CLI mutation before
 * `applyStateTransition` runs — so a fail-closed transition is a true no-op
 * rather than a half-applied label move with a stranded delegate. Identifying
 * which delta IDs are state labels needs the team's full label set (the added
 * destination label is not yet on the issue), so this queries team labels, not
 * just the issue's current labels.
 *
 * Returns an empty set on any error — the proxy then fails open (strips nothing),
 * preserving prior behavior rather than risk dropping legitimate non-state labels.
 */
export async function fetchTeamStateLabelIds(
  issueId: string,
  authToken: string,
): Promise<Set<string>> {
  const query = `
    query TeamStateLabels($id: String!) {
      issue(id: $id) {
        team {
          labels { nodes { id name } }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: { issue?: { team?: { labels?: { nodes: LabelNode[] } } } };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.team?.labels?.nodes ?? [];
    return new Set(nodes.filter((n) => /^state:/i.test(n.name)).map((n) => n.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: team state-label fetch failed for ${issueId}: ${msg} — failing open`);
    return new Set();
  }
}

/**
 * Find an existing label by name in the team, or create it if absent.
 * Returns the label ID, or null if both lookup and creation fail.
 */
async function findOrCreateLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
  // AI-2176: LIF-team governed transitions silently declined here — create-on-miss
  // for `state:product-definition` fail-closed and the mechanism was invisible.
  // Two hardenings, both fully backwards-compatible with flat colon-named labels
  // (GEN, and the state:* labels LIF already carries):
  //   1. Group-aware resolution. A team may model `state:*` as a Linear label GROUP
  //      ("state") with child labels ("product-definition"), where the child's own
  //      name is the bare suffix and the group owns the "state" namespace. A blind
  //      flat lookup then misses the existing child, and a flat create collides with
  //      the group-owned namespace and fail-closes. Match/create against the group.
  //   2. Raw GraphQL error surfacing (AI-2177). The old fail-closed path swallowed
  //      the GraphQL `errors` body, so the decline reason never reached the logs.
  //
  // Split "group:child" on the FIRST colon only. Labels with no colon have no group.
  const colonIdx = labelName.indexOf(":");
  const groupName = colonIdx > 0 ? labelName.slice(0, colonIdx) : null;
  const childName = colonIdx > 0 ? labelName.slice(colonIdx + 1) : labelName;

  const lookupQuery = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels(first: 250) { nodes { id name isGroup parent { id name } } }
      }
    }
  `;
  let nodes: LabelNode[] = [];
  try {
    const lookupRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: lookupQuery, variables: { teamId } }),
    });
    type LookupResp = { data?: { team?: { labels: { nodes: LabelNode[] } } }; errors?: unknown };
    const lookupData = (await lookupRes.json()) as LookupResp;
    if (lookupData.errors) {
      log.warn(`workflow-gate: team label lookup GraphQL errors for team=${teamId} label='${labelName}': ${JSON.stringify(lookupData.errors)}`);
    }
    nodes = lookupData.data?.team?.labels?.nodes ?? [];
    // (a) Flat exact match — GEN and the flat state:* labels LIF already carries.
    const flat = nodes.find((n) => n.name === labelName && !n.isGroup);
    if (flat) return flat.id;
    // (b) Group-child match — the label is modeled as a child of a `groupName` group.
    if (groupName) {
      const child = nodes.find(
        (n) => !n.isGroup && n.parent?.name === groupName && n.name === childName,
      );
      if (child) return child.id;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: team label lookup failed for team=${teamId}: ${msg}`);
    return null;
  }

  // Not found — create it with a neutral grey color. If a group owns the namespace,
  // create the label as that group's child (name = bare suffix, parentId = group);
  // otherwise create a flat colon-named label exactly as before.
  const group = groupName ? nodes.find((n) => n.isGroup && n.name === groupName) : undefined;
  const createName = group ? childName : labelName;
  const createMutation = group
    ? `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!, $parentId: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color, parentId: $parentId }) {
        success
        issueLabel { id }
      }
    }
  `
    : `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
        success
        issueLabel { id }
      }
    }
  `;
  const createVars = group
    ? { teamId, name: createName, color: "#94a3b8", parentId: group.id }
    : { teamId, name: createName, color: "#94a3b8" };
  try {
    const createRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: createMutation, variables: createVars }),
    });
    type CreateResp = {
      data?: { issueLabelCreate?: { success: boolean; issueLabel?: { id: string } } };
      errors?: unknown;
    };
    const createData = (await createRes.json()) as CreateResp;
    const result = createData.data?.issueLabelCreate;
    if (result?.success && result.issueLabel) {
      log.info(
        `workflow-gate: created label '${labelName}' in team ${teamId}${group ? ` (child of group '${groupName}')` : ""}`,
      );
      return result.issueLabel.id;
    }
    // AI-2177: surface the raw failure instead of swallowing it — this is the log
    // line that makes a B2 label-resolve fail-closed diagnosable.
    const errorBody = createData.errors ? JSON.stringify(createData.errors) : "none";
    log.error(
      `workflow-gate: B2 label create FAIL-CLOSED for '${labelName}' in team ${teamId} (${group ? `child of group '${groupName}'` : "flat"}): success=${result?.success ?? "null"} errors=${errorBody}`,
    );

    // AI-2176 inherited-label fallback: when a sub-team (e.g. LIF) tries to create a
    // label that conflicts with an inherited label from a parent team (e.g. GEN),
    // Linear rejects the create with "conflicting inherited label". The inherited
    // label's ID is still usable for issue mutations on the sub-team. Fall back to
    // querying all org teams for the label by name (org has ~3 teams; acceptable).
    const isInheritedConflict = createData.errors &&
      Array.isArray(createData.errors) &&
      createData.errors.some((e: Record<string, unknown>) =>
        typeof e.message === "string" && e.message.includes("conflicting inherited label"),
      );
    if (isInheritedConflict) {
      log.info(`workflow-gate: attempting inherited-label fallback for '${labelName}' on team ${teamId}`);
      try {
        // Fetch all teams in the org, then search each for the label.
        const teamsQuery = `query OrgTeams { teams { nodes { id } } }`;
        const teamsRes = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authToken },
          body: JSON.stringify({ query: teamsQuery }),
        });
        const teamsData = (await teamsRes.json()) as {
          data?: { teams?: { nodes: Array<{ id: string }> } };
        };
        const teamIds = teamsData.data?.teams?.nodes?.map((t) => t.id).filter((id) => id !== teamId) ?? [];
        for (const otherTeamId of teamIds) {
          const otherLabelsQuery = `
            query OtherTeamLabels($tid: String!) {
              team(id: $tid) {
                labels(first: 250) { nodes { id name } }
              }
            }
          `;
          const otherRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: otherLabelsQuery, variables: { tid: otherTeamId } }),
          });
          const otherData = (await otherRes.json()) as {
            data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } };
          };
          const match = otherData.data?.team?.labels?.nodes?.find((l) => l.name === labelName);
          if (match) {
            log.info(`workflow-gate: inherited-label fallback found '${labelName}' as id=${match.id} on team ${otherTeamId} (usable on sub-team ${teamId})`);
            return match.id;
          }
        }
        log.warn(`workflow-gate: inherited-label fallback found no org-wide match for '${labelName}' across ${teamIds.length} teams`);
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        log.warn(`workflow-gate: inherited-label fallback query failed: ${fallbackMsg}`);
      }
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: label creation failed for '${labelName}': ${msg}`);
    return null;
  }
}

/**
 * Derive legal assignment targets for a transition based on destination state's owner_role.
 * Returns mode=none for terminal states or roles with no bodies.
 * mode=auto when singleton, mode=required when multiple bodies fill the role.
 */
export async function resolveTransitionTargets(
  transition: WorkflowTransition,
  def: WorkflowDef,
): Promise<{ bodies: string[]; mode: 'auto' | 'required' | 'none' }> {
  const destState = def.states.find((s) => s.id === transition.to);
  const ownerRole = destState?.owner_role;
  if (!ownerRole || destState?.kind === 'terminal') {
    return { bodies: [], mode: 'none' };
  }
  const bodies = await resolveBodiesForRole(ownerRole);
  if (bodies.length === 0) return { bodies: [], mode: 'none' };
  if (bodies.length === 1) return { bodies, mode: 'auto' };
  return { bodies, mode: 'required' };
}

/**
 * AI-1977: Pre-resolve the delegateId for a workflow transition before the proxy
 * forwards the mutation. This is called from proxy.ts to inject the correct
 * delegateId into the forwarded mutation (so webhook #1 carries the right delegate)
 * and passed as delegateOverride to applyStateTransition to skip its duplicate write.
 *
 * Returns null for terminal/exit states (delegate should be cleared).
 * Returns undefined when the delegate cannot be determined (multi-body role without
 * a CLI target) — in that case the proxy should NOT inject a delegateId into the
 * forward mutation and should NOT set delegateOverride, letting applyStateTransition
 * resolve it independently (or fail-closed as before).
 *
 * This is a bounded reimplementation of the delegate resolution logic inside
 * applyStateTransition's Step 2. Uses the same resolution chain:
 * 1. Explicit CLI target
 * 2. Prior implementer (if transition has assign.default: prior-implementer)
 * 3. Singleton role auto-assign
 */
export async function resolveTransitionDelegate(
  toStateName: string,
  matchedTransition: WorkflowTransition | undefined,
  def: WorkflowDef,
  issueId: string,
  cliTarget?: string,
): Promise<string | null | undefined> {
  const destStateNode = def.states.find((s) => s.id === toStateName);
  if (!destStateNode) return undefined;
  const destOwnerRole = destStateNode.owner_role;
  const isTerminal = destStateNode.kind === 'terminal' || !destOwnerRole;
  if (isTerminal) return null;

  const wantsPriorImplementer = matchedTransition?.assign?.default === 'prior-implementer';

  // (1) Explicit CLI target wins.
  if (cliTarget) {
    const targetAgent = getAgent(cliTarget);
    if (targetAgent?.linearUserId) {
      return targetAgent.linearUserId;
    }
  }

  // (2) Prior implementer routing.
  if (wantsPriorImplementer) {
    const priorImplementer = await getImplementer(issueId);
    if (priorImplementer) {
      const agent = getAgent(priorImplementer);
      if (agent?.linearUserId) {
        return agent.linearUserId;
      }
    }
  }

  // (3) Role-based resolution (singleton only).
  try {
    const roleBodies = await resolveBodiesForRole(destOwnerRole);
    if (roleBodies.length === 1) {
      const agent = getAgent(roleBodies[0]);
      if (agent?.linearUserId) {
        return agent.linearUserId;
      }
    }
  } catch {
    // Role resolution failure — return undefined, skip pre-resolution.
  }

  return undefined;
}

export function getWorkflowId(labels: string[]): string | null {
  const label = labels.find((l) => /^wf:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
}

/**
 * Resolve the ticket's current workflow state id from its labels.
 *
 * AI-2094: a correctly-maintained ticket carries exactly one `state:*` label
 * (the atomic swap in applyStateTransition enforces this on every transition).
 * But a ticket that drifted BEFORE that invariant was enforced — the live
 * GEN-103 shape — can carry two, e.g. a stale `state:routing` alongside the
 * real `state:review`. The old `.find()` returned the FIRST match by label
 * order, which is nondeterministic and, for the GEN-103 ordering, bound
 * `continue-workflow` to routing's `assign` edge instead of review's `approve`
 * — the "mis-routes to assign" symptom.
 *
 * When a `def` is supplied and more than one `state:*` label is present, resolve
 * deterministically to the MOST-ADVANCED state (furthest along the def's state
 * ordering). Forward progress is exactly what leaves an earlier label stale, so
 * the furthest-along label reflects the true position. Without a def, or with a
 * single label, behavior is unchanged.
 */
export function getCurrentState(labels: string[], def?: WorkflowDef): string | null {
  const ids = labels
    .filter((l) => /^state:/i.test(l))
    .map((l) => l.slice(l.indexOf(":") + 1).toLowerCase());
  if (ids.length === 0) return null;
  if (ids.length === 1 || !def) return ids[0];

  // >1 state:* label + a def to order them: prefer the most-advanced state.
  // Rank by index in def.states (canonical authoring order = forward order).
  // Labels whose state is unknown to the def rank below any known state, so a
  // stray non-workflow `state:*` label can never win over a real one.
  let best = ids[0];
  let bestRank = -1;
  for (const id of ids) {
    const rank = def.states.findIndex((s) => s.id === id);
    if (rank > bestRank) {
      bestRank = rank;
      best = id;
    }
  }
  return best;
}

/**
 * Thrown by fetchWorkflowLabels when the Linear API returns a transient error
 * (network failure, 401, 5xx). Non-transient errors (e.g. 404, 403) still fail
 * open with an empty array.
 *
 * AI-1708: Callers in the delivery path catch this to retry or emit a WARN
 * before falling back to a generic message, rather than silently downgrading.
 */
export class TransientLabelFetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TransientLabelFetchError";
  }
}

/**
 * Fetch label names for a Linear issue.
 * Used by the outbound delivery path (B3) to detect workflow/state labels.
 *
 * AI-1708: Transient failures (network errors, 401, 5xx) now throw
 * TransientLabelFetchError instead of silently returning []. Callers that
 * need fail-open behavior can catch and return []. Non-transient errors
 * (e.g. malformed response, 4xx other than 401) still fail open with [].
 */
export async function fetchWorkflowLabels(issueId: string, authToken: string): Promise<string[]> {
  const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });

    // AI-1708: Transient HTTP errors should trigger retry, not silent fail-open.
    if (res.status === 401 || res.status >= 500) {
      throw new TransientLabelFetchError(
        `Linear API returned ${res.status} for label fetch on ${issueId}`,
        res.status,
      );
    }

    type LabelResp = { data?: { issue?: { labels?: { nodes: Array<{ name: string }> } } } };
    const data = (await res.json()) as LabelResp;
    return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
  } catch (err) {
    // Re-throw transient errors so callers can retry.
    if (err instanceof TransientLabelFetchError) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    // Network errors (ECONNRESET, ETIMEDOUT, etc.) are transient.
    if (isTransientNetworkError(msg)) {
      throw new TransientLabelFetchError(
        `Network error during label fetch for ${issueId}: ${msg}`,
      );
    }

    log.warn(`workflow-gate: outbound label fetch failed for ${issueId}: ${msg} — failing open`);
    return [];
  }
}

/**
 * Heuristic: does this error message look like a transient network error?
 * Covers ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed, etc.
 */
function isTransientNetworkError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("network error") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted")
  );
}

// ── Done gate: branch/PR verification (AI-1475 Defect 1) ─────────────────

interface BranchAndPRStatus {
  /** True when the issue has a branch that has been pushed to origin. */
  hasBranch: boolean;
  /** True when the issue has at least one associated pull request. */
  hasPR: boolean;
  /** True when the issue has at least one merged pull request. */
  hasMergedPR: boolean;
}

/**
 * Query Linear for the issue's branch and pull request status.
 * Used by the done gate (§5.6) to verify that implementation was actually
 * pushed and reviewed before allowing the terminal done transition.
 * Returns null on any error — caller decides fail-open vs fail-closed.
 *
 * AI-1797: `Issue.branch` / `Issue.pullRequests` are NOT in Linear's public
 * GraphQL schema — the original query was rejected with
 * GRAPHQL_VALIDATION_FAILED for the connector's authenticated OAuth actors
 * too (verified live 2026-07-05), so this function returned null on every
 * call and the gate silently fail-opened. PR/branch data is only surfaced
 * via `attachments` created by Linear's GitHub integration; a GitHub PR
 * attachment implies a pushed branch, so hasBranch mirrors hasPR and the
 * branch-without-PR partial-evidence case is no longer observable.
 * NOTE: the workspace currently has no GitHub integration installed, so
 * attachments are empty on every issue and the gate passes evidence-free
 * (AI-1497 fail-open) until the integration is enabled — see the
 * no-evidence alert at the deploy gate.
 */
async function fetchBranchAndPRStatus(
  issueId: string,
  authToken: string,
): Promise<BranchAndPRStatus | null> {
  const query = `
    query IssueBranchAndPR($id: String!) {
      issue(id: $id) {
        attachments {
          nodes {
            url
            sourceType
            metadata
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type AttachmentNode = {
      url?: string | null;
      sourceType?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    type PRResp = {
      data?: { issue?: { attachments?: { nodes: AttachmentNode[] } } };
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    const data = (await res.json()) as PRResp;
    if (data.errors?.length) {
      // A validation/auth error here is persistent, not transient — the exact
      // failure mode that went unnoticed before AI-1797. Never silent again.
      const summary = data.errors.map((e) => e.message ?? e.extensions?.code ?? "unknown").join("; ");
      log.warn(`workflow-gate: IssueBranchAndPR query returned errors for ${issueId}: ${summary}`);
      notify({
        severity: "warning",
        source: "done-gate",
        title: "IssueBranchAndPR gate query failing — done gate is fail-opening",
        detail: `Query errors for ${issueId}: ${summary}`,
        ticket: issueId,
        dedupKey: "done-gate|query-failing",
      });
      return null;
    }
    const issue = data.data?.issue;
    if (!issue) {
      log.warn(`workflow-gate: IssueBranchAndPR returned no issue for ${issueId}`);
      return null;
    }
    const nodes = issue.attachments?.nodes ?? [];
    const prNodes = nodes.filter((n) => typeof n.url === "string" && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(n.url));
    const hasPR = prNodes.length > 0;
    const hasMergedPR = prNodes.some((n) => {
      const meta = n.metadata ?? {};
      const status = (meta as { status?: unknown; state?: unknown }).status ?? (meta as { state?: unknown }).state;
      return typeof status === "string" && status.toLowerCase() === "merged";
    });
    return {
      // Attachments cannot see branches directly; a PR implies a pushed branch.
      hasBranch: hasPR,
      hasPR,
      hasMergedPR,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: branch/PR fetch failed for ${issueId}: ${msg}`);
    return null;
  }
}

// ── Repo resolution for the no-CI-auto-deploy guard (AI-1795) ─────────────

/**
 * Resolve which GitHub repos a ticket's implementation touched, from its
 * GitHub-sourced attachments (PR/branch links synced by Linear's GitHub
 * integration). Returns "owner/repo" refs. Fail-open: any error → [].
 *
 * Deliberately a separate query from fetchBranchAndPRStatus: the guard must
 * not risk regressing the done gate, and attachments are plain public schema.
 */
async function fetchGithubRepoRefs(issueId: string, authToken: string): Promise<string[]> {
  const query = `query IssueRepoAttachments($id: String!) { issue(id: $id) { attachments { nodes { url sourceType } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type AttachResp = {
      data?: { issue?: { attachments?: { nodes: Array<{ url?: string | null; sourceType?: string | null }> } } };
    };
    const data = (await res.json()) as AttachResp;
    const nodes = data.data?.issue?.attachments?.nodes ?? [];
    const refs = new Set<string>();
    for (const node of nodes) {
      const repo = node.url ? githubRepoFromUrl(node.url) : null;
      if (repo) refs.add(repo);
    }
    return [...refs];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: attachment fetch failed for ${issueId}: ${msg} — repo guard fails open`);
    return [];
  }
}

/**
 * AI-1795: collect a ticket's repo refs from explicit `repo:*` labels plus
 * GitHub attachments. Labels win nothing over attachments — both are checked;
 * the guard blocks if ANY resolved repo is flagged (host-deploy is a harmless
 * no-op for repos that do auto-deploy, per deployment.md).
 */
async function resolveTicketRepoRefs(
  labels: string[],
  issueId: string,
  authToken: string,
): Promise<string[]> {
  const fromLabels = labels
    .filter((l) => l.toLowerCase().startsWith("repo:"))
    .map((l) => l.slice("repo:".length).trim())
    .filter((l) => l.length > 0);
  const fromAttachments = await fetchGithubRepoRefs(issueId, authToken);
  return [...new Set([...fromLabels, ...fromAttachments])];
}

// ── Issue description fetch (AI-1482) ─────────────────────────────────────

/**
 * Fetch the description of a Linear issue.
 * Used by the verbatim AC capture to extract the AC from the description at accept time.
 * Returns an empty string on any error.
 */
async function fetchIssueDescription(issueId: string, authToken: string): Promise<{ description: string; fetchFailed: boolean }> {
  const query = `query IssueDescription($id: String!) { issue(id: $id) { description } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type DescResp = { data?: { issue?: { description?: string | null } } };
    const data = (await res.json()) as DescResp;
    const desc = data.data?.issue?.description;
    if (desc === undefined || desc === null) {
      log.warn(`workflow-gate: description fetch returned no description for ${issueId} — AC capture may be incomplete`);
      return { description: "", fetchFailed: true };
    }
    return { description: desc, fetchFailed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: description fetch failed for ${issueId}: ${msg} — AC capture will be incomplete`);
    return { description: "", fetchFailed: true };
  }
}

/**
 * AI-1776 AC2: Post a fail-visible warning comment when a capture_ac: true
 * transition captures nothing (null extraction or description fetch failure).
 * Signal, not gate — the transition still completes. The comment tells the
 * steward the AC of record was not captured and why, so they can react.
 */
async function postAcCaptureWarningComment(
  internalIssueId: string,
  issueIdentifier: string,
  authToken: string,
  cause: string,
): Promise<void> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  const body =
    `[AC Capture Warning] The AC of record was **not captured** at accept time: ${cause}. ` +
    `The transition proceeded, but there is no verbatim AC snapshot for this ticket. ` +
    `Use the recapture verb to create the AC record from the current description once an Acceptance Criteria section is present.`;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalIssueId, body } }),
    });
    log.info(`workflow-gate: H-7: posted AC capture warning comment for ${issueIdentifier}`);
  } catch (err) {
    log.warn(`workflow-gate: H-7: failed to post AC capture warning comment for ${issueIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Stakes-level resolution (AI-1482) ───────────────────────────────────────

/**
 * Resolve a ticket's numeric stakes level from its labels.
 * The stakes label namespace is whatever the def's `stakes.levels` map keys on
 * (currently `risk:*` — `risk:low`/`risk:medium`/`risk:high`; historically
 * `stakes:*`). Resolution is namespace-agnostic: a label counts as the stakes
 * label iff it is a key in `stakesConfig.levels`. This avoids the AI-1539 class
 * of bug where a hardcoded prefix (`/^stakes:/`) silently fails to match the
 * configured namespace and forces every ticket to fail closed.
 *
 * Fails OPEN (AI-1539, Matt directive 2026-06-11): when the ticket carries none
 * of the configured level labels, returns 0 (lowest stakes) — a *missing* tag
 * must not hold a task up for human review. Only an EXPLICIT high-stakes label
 * (e.g. risk:high mapping to >= threshold) trips the human sign-off gate.
 * Tradeoff accepted by the owner: a genuinely high-stakes task left untagged
 * will deploy without sign-off; tag it risk:high to gate it.
 */
export function resolveStakesLevel(labels: string[], stakesConfig: StakesLevel): number {
  const stakesLabel = labels.find((l) =>
    Object.prototype.hasOwnProperty.call(stakesConfig.levels, l),
  );
  if (!stakesLabel) {
    log.warn(`workflow-gate: resolveStakesLevel: no configured stakes label found (levels: ${Object.keys(stakesConfig.levels).join(", ")}) — failing open (level 0, no human sign-off required)`);
    return 0; // fail open (Matt directive): a missing tag must not force human review
  }
  return stakesConfig.levels[stakesLabel];
}

// ── Public enforcement API ─────────────────────────────────────────────────

/**
 * Resolve a meta-intent (`continue-workflow` or `request-revision`) to the actual
 * workflow transition command name for the ticket's current state.
 *
 * Returns `{ resolved: commandName }` on success, or `{ error: rejectionMessage }` if
 * the meta-intent cannot be resolved (non-workflow ticket, no matching transition, etc.).
 *
 * For non-meta intents, passes through with `{ resolved: intent }`.
 */
export async function resolveMetaIntent(
  intent: string,
  issueId: string,
  authToken: string,
  // AI-1860: source state snapshotted at command start. When a non-empty string is
  // provided, the meta-intent is resolved against it instead of the live-fetched
  // state, so a multi-step governed command (e.g. continue-workflow) does not
  // re-resolve against its own post-transition state on a follow-up mutation
  // (the AI-1872 "no continue transition in state 'done'" repro).
  snapshotState?: string | null,
): Promise<{ resolved: string } | { error: string }> {
  if (intent !== 'continue-workflow' && intent !== 'request-revision') {
    return { resolved: intent };
  }

  const { labels, fetchFailed } = await fetchTicketContext(issueId, authToken);
  if (fetchFailed) {
    return { error: `[Proxy] '${intent}' blocked: unable to fetch ticket context for ${issueId}.` };
  }

  const workflowId = getWorkflowId(labels);
  if (!workflowId) {
    return { error: `[Proxy] '${intent}' is only valid on workflow tickets (ticket has no wf:* label).` };
  }

  let def: WorkflowDef;
  try {
    const registry = await loadWorkflowRegistry();
    const d = registry.get(workflowId);
    if (!d) {
      return { error: `[Proxy] '${intent}': workflow '${workflowId}' is not registered.` };
    }
    def = d;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `[Proxy] '${intent}' blocked: workflow registry unavailable (${msg}).` };
  }

  const currentState =
    typeof snapshotState === "string" && snapshotState.length > 0
      ? snapshotState
      : getCurrentState(labels, def); // AI-2094: def-aware — a stale state:* label can never win over the real one
  if (!currentState) {
    return { error: `[Proxy] '${intent}' blocked: ticket has no current workflow state label.` };
  }

  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) {
    return { error: `[Proxy] '${intent}' blocked: current state '${currentState}' not found in workflow definition.` };
  }

  const genericRole: 'continue' | 'revision' = intent === 'continue-workflow' ? 'continue' : 'revision';
  const transition = stateNode.transitions?.find((t) => t.generic === genericRole);

  if (!transition) {
    const available = stateNode.transitions?.map((t) => t.command).join(', ') ?? 'none';
    return {
      error:
        `[Proxy] '${intent}' has no ${genericRole} transition in state '${currentState}' ` +
        `(wf:${workflowId}). Available named commands: ${available}.`,
    };
  }

  return { resolved: transition.command };
}

/**
 * The CLI verb an agent actually types for a transition. Generic-tagged
 * transitions resolve via the meta-intent commands; def-internal command
 * names (e.g. task.yaml's `request`) do not exist as CLI commands, so
 * rejection hints must never render them bare (pilot finding, 2026-07-03).
 */
export function cliVerbFor(t: { command: string; generic?: string }): string {
  if (t.generic === "continue") return "continue-workflow";
  if (t.generic === "revision") return "request-revision";
  return t.command;
}

/**
 * Evaluate full workflow-def-driven command validation for an inbound proxied request.
 *
 * Returns a rejection message when the command should be blocked, or null to forward.
 * Fails open on missing issueId, missing state label, unknown workflow, or label-fetch
 * failure — enforcement only blocks with affirmative evidence of a violation.
 *
 * @param callerLinearUserId - Linear user ID of the requesting agent (from agents.ts);
 *   used for delegate-only enforcement (AI-1397). Null/undefined → fail-open.
 */
/**
 * AI-1769 AC2: verify an X-Openclaw-Comment-Satisfied-By reference.
 *
 * When a governed transition's required comment is suppressed client-side as a
 * near-duplicate of an existing comment (a prior blocked attempt already posted
 * the feedback), the CLI sends the transition trigger WITHOUT a commentCreate
 * and points at the comment that already carries the feedback. A
 * requires_comment gate may treat that as satisfied ONLY when the referenced
 * comment (1) exists, (2) belongs to the transitioning issue, (3) is recent
 * (≤1h — the CLI dedup window is 10min, so this is generous), and (4) was
 * authored by the calling agent when the caller is resolvable.
 *
 * Fail-closed: any verification failure returns false and the gate blocks
 * exactly as it would without the header.
 */
export async function verifyCommentSatisfiedBy(
  issueId: string,
  commentId: string,
  authToken: string,
  callerLinearUserId?: string | null,
): Promise<boolean> {
  const query = `query SatisfiedByComment($id: String!) { comment(id: $id) { id createdAt user { id } issue { id identifier } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: commentId } }),
    });
    type CommentResp = {
      data?: {
        comment?: {
          id: string;
          createdAt?: string;
          user?: { id: string } | null;
          issue?: { id: string; identifier?: string } | null;
        } | null;
      };
    };
    const data = (await res.json()) as CommentResp;
    const comment = data.data?.comment;
    if (!comment) {
      log.warn(`workflow-gate: satisfied-by: comment ${commentId} not found — rejecting`);
      return false;
    }
    const issueMatches =
      comment.issue?.id === issueId ||
      (comment.issue?.identifier ?? "").toUpperCase() === issueId.toUpperCase();
    if (!issueMatches) {
      log.warn(`workflow-gate: satisfied-by: comment ${commentId} belongs to ${comment.issue?.identifier ?? comment.issue?.id ?? "unknown"}, not ${issueId} — rejecting`);
      return false;
    }
    const ageMs = Date.now() - new Date(comment.createdAt ?? 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 3_600_000) {
      log.warn(`workflow-gate: satisfied-by: comment ${commentId} is too old (${Math.round(ageMs / 1000)}s) — rejecting`);
      return false;
    }
    if (callerLinearUserId && comment.user?.id !== callerLinearUserId) {
      log.warn(`workflow-gate: satisfied-by: comment ${commentId} was authored by ${comment.user?.id ?? "unknown"}, caller is ${callerLinearUserId} — rejecting`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: satisfied-by: verification failed for comment ${commentId} on ${issueId}: ${msg} — rejecting (fail-closed)`);
    return false;
  }
}

export async function checkWorkflowRules(
  intent: string,
  issueId: string | null,
  authToken: string,
  bodyId: string,
  target: string | null = null,
  callerLinearUserId?: string | null,
  artifactRef?: string | null,
  breakGlassOverride: boolean = false,
  isMetaIntent: boolean = false,
  hasComment: boolean = false,
  // AI-1860: when provided, used in place of the live-fetched delegateId for authorization
  // checks so multi-step governed commands don't self-block after applyStateTransition
  // reassigns the delegate. undefined = no snapshot (re-fetch live); null = caller was
  // delegate but delegate field was empty at command start.
  snapshotDelegateId?: string | null,
  // AI-1860: source state snapshotted at command start. When a non-empty string is
  // provided, the transition-legality check runs against it instead of the live
  // state label, so a multi-step governed command's follow-up mutation is not
  // re-gated against its own post-transition state (the "'<intent>' is not a legal
  // command in state '<new-state>'" repro on ac-fail / request-revision / needs-human).
  snapshotState?: string | null,
): Promise<string | null> {
  // TODO(AI-1347): fail-open on missing issueId is a Layer A carry-forward.
  // Harden by deriving issueId from the request body when headers are absent.
  if (!issueId) return null;

  // G-13a (AI-1551): identity gate — break-glass is restricted to the recovery
  // steward. 2026-07-02 (Matt): human:escalate moved to Ai (the human gateway);
  // break-glass authority stays with the workflow steward via workflow:break-glass.
  if (breakGlassOverride) {
    const authorized = await bodyHasCapability(bodyId, "workflow:break-glass");
    if (!authorized) {
      log.warn(`workflow-gate: break-glass identity gate rejected — '${bodyId}' lacks workflow:break-glass`);
      return `[Proxy] Break-glass rejected: caller '${bodyId}' is not authorized. Only the recovery steward (workflow:break-glass) may use break-glass.`;
    }
  }

  const { labels, delegateId: fetchedDelegateId, fetchFailed } = await fetchTicketContext(issueId, authToken);

  // AI-1860: use snapshotted delegateId for authorization checks when provided.
  // snapshotDelegateId is the delegateId captured at command start (first mutation);
  // it remains stable across applyStateTransition so subsequent mutations in the
  // same multi-step command are not self-blocked by a post-transition delegate change.
  // The fetched delegateId is still used for informational fields (legal-moves messages).
  const delegateId = snapshotDelegateId !== undefined ? snapshotDelegateId : fetchedDelegateId;

  // Phase 6.5 / H-1: Fail-closed on context-fetch failure.
  // When we can't fetch the ticket's labels, we cannot determine whether
  // it's a workflow ticket. If the caller explicitly set an intent header
  // (signaling they believe this is a workflow command), fail closed.
  // Break-glass override bypasses this check.
  if (fetchFailed && !breakGlassOverride) {
    // Safety: begin-work and note pass through even on fetch failure because:
    //   - begin-work on an ad-hoc ticket is harmless (labels are empty → getWorkflowId
    //     returns null → pass-through below), and it's the only way to add a wf:*
    //     label to start workflowing a ticket.
    //   - note is informational-only and never mutates state, so allowing it through
    //     is safe even if we can't verify workflow membership.
    // All other intents are rejected because they would mutate workflow state without
    //     being able to validate the move.
    const looksLikeWorkflowCommand = intent !== "begin-work" && intent !== "note";
    if (looksLikeWorkflowCommand) {
      log.error(`workflow-gate: FAIL-CLOSED — context fetch failed for ${issueId}, cannot determine if workflow ticket — rejecting '${intent}'`);
      return (
        `[Proxy] '${intent}' blocked: unable to fetch ticket context for ${issueId}. ` +
        `Cannot determine workflow state — failing closed for safety. ` +
        `A steward can use break-glass to bypass this check.`
      );
    }
  }

  // §4.6 mode switch: ad-hoc tickets (no wf:* label) are full pass-through.
  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null;

  // ── Phase 6.5 / H-1: Fail-closed on config-load failure (§16.0) ──────
  if (!breakGlassOverride && !isConfigHealthy()) {
    log.error(`workflow-gate: config-health FAIL-CLOSED — rejecting '${intent}' on wf:${workflowId} ticket ${issueId} because config is degraded`);
    return (
      `[Proxy] '${intent}' blocked: config artifacts are degraded and enforcement cannot be trusted. ` +
      `A steward can use break-glass (--break-glass flag or X-Openclaw-Break-Glass header) to bypass this check.`
    );
  }

  let def: WorkflowDef | undefined;
  try {
    const registry = await loadWorkflowRegistry();
    def = registry.get(workflowId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Phase 6.5 / H-1: FAIL CLOSED on workflow registry load failure (§16.0).
    if (breakGlassOverride) {
      log.warn(`workflow-gate: workflow registry load failed but break-glass override active — allowing through: ${msg}`);
      return null;
    }
    log.error(`workflow-gate: FAIL-CLOSED — workflow registry load failed, rejecting '${intent}' on wf:${workflowId} ticket ${issueId}: ${msg}`);
    return (
      `[Proxy] '${intent}' blocked: workflow definition could not be loaded (${msg}). ` +
      `A steward can use break-glass to bypass this check.`
    );
  }

  // AI-1530: dispatch by wf:<id> label. A ticket whose wf: matches no registered
  // def remains pass-through (unknown / unenforced workflow).
  if (!def) return null;

  // §5.3 Asymmetry enforcement: children running wf:dev-impl have no legal
  // command to address the parent's ux-audit workflow. This is structural:
  //   - The dev-impl workflow def has no 'address-parent' or 'barrier-signal' command.
  //   - Layer 2 (checkRawMutationInterception) blocks raw label/state mutations.
  //   - The proxy only validates against the loaded workflow def.
  // AC3 (B-3): Children cannot address the parent — enforced by the absence of
  // any upward-directed command in the dev-impl state machine.

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  // AI-1402: Fail-closed on unknown caller. When the caller's body is not in the
  // capability policy and the ticket is a governed workflow ticket, block the mutation.
  // Exception: an actual human (unknown to the AI capability policy) must be able to
  // sign off on stakes-gated high-stakes transitions — see stakes check below.
  const isCallerKnown = await isBodyKnown(bodyId);
  if (!isCallerKnown) {
    // Allow unknown callers through ONLY for the human sign-off path.
    const preState = getCurrentState(labels);
    const preNode = preState ? def.states.find((s) => s.id === preState) : undefined;
    const preTx = preNode?.transitions?.find((t) => t.command === intent);
    const isHumanSignoffPath = !!(
      preTx?.requires_human_signoff_above_stakes &&
      def.stakes &&
      resolveStakesLevel(labels, def.stakes) >= def.stakes.threshold
    );
    if (!isHumanSignoffPath) {
      log.warn(`workflow-gate: unknown caller '${bodyId}' on wf:${workflowId} ticket ${issueId} — blocking`);
      const legalMoves = [...(preNode?.transitions?.map((t) => cliVerbFor(t)) ?? []), breakGlassCommand].join(", ");
      return (
        `[Proxy] Unknown caller '${bodyId}' blocked on workflow ticket. ` +
        `Ensure this agent is registered in the capability policy. ` +
        `Legal moves: ${legalMoves}.`
      );
    }
    log.info(`workflow-gate: unknown caller '${bodyId}' on wf:${workflowId} — human sign-off path, allowing through`);
  }

  // §4.4 / AI-1668: break-glass escape is caller-gated.
  // The delegate can always escape their own ticket; the workflow steward
  // (break_glass.owner_role) can escape any ticket. All other known agents
  // are blocked. Fail-open when no delegate is set or caller identity is
  // unknown (preserves existing behaviour for no-delegate / legacy callers).
  if (intent === breakGlassCommand) {
    if (!delegateId) return null;
    if (!callerLinearUserId) return null;
    if (callerLinearUserId === delegateId) return null;
    const stewardRole = def.break_glass?.owner_role;
    if (stewardRole) {
      const stewards = await resolveBodiesForRole(stewardRole);
      if (stewards.includes(bodyId)) return null;
    }
    log.warn(`workflow-gate: escape blocked agent=${bodyId} ticket=${issueId} (not delegate or steward)`);
    const escapeCurrentState = getCurrentState(labels);
    const escapeNode = escapeCurrentState ? def.states.find((s) => s.id === escapeCurrentState) : undefined;
    const escapeLegalMoves = [...(escapeNode?.transitions?.map((t) => cliVerbFor(t)) ?? []), breakGlassCommand].join(", ");
    return (
      `[Proxy] 'escape' blocked: '${bodyId}' is not the current delegate or the workflow steward. ` +
      `Only the assigned delegate or a workflow steward may use break-glass on a governed ticket. ` +
      `Contact the current delegate or escalate to a steward to escape. ` +
      `Legal moves: ${escapeLegalMoves}.`
    );
  }

  // AI-1460/AI-1574: refuse-work is caller-gated. Only the current delegate or
  // the workflow steward (break_glass.owner_role) may refuse on a governed
  // ticket. A non-delegate, non-steward caller is blocked to prevent third-party
  // rerouting. When no delegate is set, fail-open (nothing to protect).
  if (intent === "refuse-work") {
    if (!delegateId) return null;
    if (callerLinearUserId && callerLinearUserId === delegateId) return null;
    const stewardRole = def.break_glass?.owner_role;
    if (stewardRole) {
      const stewards = await resolveBodiesForRole(stewardRole);
      if (stewards.includes(bodyId)) return null;
    }
    log.warn(`workflow-gate: refuse-work blocked agent=${bodyId} ticket=${issueId} (not delegate or steward)`);
    return (
      `[Proxy] 'refuse-work' blocked: '${bodyId}' is not the current delegate or the workflow steward. ` +
      `Only the assigned delegate or workflow steward may refuse work on a governed ticket.`
    );
  }

  // AI-1576 AC3: demote guard — block demote when ticket has in-flight or merged work.
  // Scoped to wf:dev-impl only: sprint/ux-audit demotes are not gated.
  // A demote on a dev-impl ticket carrying a pushed branch or open/merged PR silently
  // drops it off-spine while implementation is already underway. Fail-open on fetch
  // error so a transient API outage never permanently strands a genuinely-fresh intake.
  if (intent === "demote" && workflowId === "dev-impl" && !breakGlassOverride) {
    const branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    if (branchStatus && (branchStatus.hasBranch || branchStatus.hasPR)) {
      log.warn(`workflow-gate: AI-1576 demote-guard blocked agent=${bodyId} ticket=${issueId} (hasBranch=${branchStatus.hasBranch} hasPR=${branchStatus.hasPR})`);
      return (
        `[Proxy] 'demote' blocked on ${issueId}: this ticket has in-flight or merged implementation work ` +
        `(branch: ${branchStatus.hasBranch}, PR: ${branchStatus.hasPR}). ` +
        `Demoting would silently drop it off the dev-impl spine while implementation is underway. ` +
        `Use break-glass ('escape') to override if intentional.`
      );
    }
  }

  // AI-1397: delegate-only enforcement at proxy (CLI-version-agnostic).
  // If both the caller's Linear user ID and the ticket's delegate ID are known,
  // block any agent that is not the current delegate. Fails open when either is
  // unknown (delegate not set, agent config missing linearUserId, fetch error).
  // AI-1400 B2: additionally fail-closed when the caller identity is unknown
  // (no linearUserId in agents.json) but the ticket has a known delegate — an
  // unverifiable caller must not be allowed to mutate a delegated ticket.
  if (!callerLinearUserId && delegateId) {
    log.warn(`workflow-gate: unknown-caller block agent=${bodyId} intent=${intent} ticket=${issueId}`);
    const wcState = getCurrentState(labels);
    const wcNode = wcState ? def.states.find((s) => s.id === wcState) : undefined;
    const legalMoves = [...(wcNode?.transitions?.map((t) => cliVerbFor(t)) ?? []), breakGlassCommand].join(", ");
    return (
      `[Proxy] '${intent}' blocked: caller '${bodyId}' cannot be verified and the ticket has a known delegate. ` +
      `Register the agent in agents.json with a linearUserId to proceed. ` +
      `Legal moves: ${legalMoves}.`
    );
  }
  if (callerLinearUserId && delegateId && callerLinearUserId !== delegateId) {
    // Designated-approver exception (Matt directive 2026-07-12, via Astrid): when
    // the workflow def marks the EXACT transition being invoked with
    // `designated_approver: true` AND names a `requires_capability`, a caller
    // holding that capability may fire that transition without being the current
    // delegate. This is how a def nominates a sign-off authority for a ticket
    // delegated to the work's author (e.g. Ai holding sprint:signoff on
    // sprint-spawner's determining-scope → launching), preserving
    // author-cannot-self-bless without requiring a human. The flag is a deliberate
    // opt-in: a bare requires_capability (dev-impl's deploy) does NOT lift the
    // delegate gate for capability holders (G-13 AC1 semantics preserved). Scoped
    // to the matched transition only, and the requires_capability gate below
    // re-verifies the grant on the same def lookup.
    const daState =
      typeof snapshotState === "string" && snapshotState.length > 0
        ? snapshotState
        : getCurrentState(labels);
    const daNode = daState ? def.states.find((s) => s.id === daState) : undefined;
    const daTx = daNode?.transitions?.find((t) => t.command === intent);
    const isDesignatedApprover = !!(
      daTx?.designated_approver === true &&
      daTx.requires_capability &&
      (await bodyHasCapability(bodyId, daTx.requires_capability))
    );
    if (isDesignatedApprover) {
      log.info(`workflow-gate: designated-approver delegate bypass agent=${bodyId} intent=${intent} ticket=${issueId} (holds '${daTx?.requires_capability}' named on the transition, not current delegate)`);
    } else {
      // AI-1936 Defect 2: steward break-glass exception — the delegate-only gate must
      // allow the recovery steward (workflow:break-glass) to advance a stranded ticket
      // without becoming the current delegate first. Without this exception, the steward
      // must use raw escape (full spine restart via intake) for every forward recovery,
      // losing all ticket context and forcing re-verification. Check break-glass capability
      // before blocking so the steward can use continue-workflow / request-revision directly.
      const hasBreakGlass = await bodyHasCapability(bodyId, "workflow:break-glass");
      if (!hasBreakGlass) {
        log.warn(`workflow-gate: delegate-only block agent=${bodyId} intent=${intent} ticket=${issueId}`);
        const wdState = getCurrentState(labels);
        const wdNode = wdState ? def.states.find((s) => s.id === wdState) : undefined;
        const legalMoves = [...(wdNode?.transitions?.map((t) => cliVerbFor(t)) ?? []), breakGlassCommand].join(", ");
        return (
          `[Proxy] '${intent}' blocked: ${bodyId} is not the current delegate for ${issueId}. ` +
          `Only the ticket delegate may mutate its state. ` +
          `Legal moves: ${legalMoves}.`
        );
      }
      log.info(`workflow-gate: break-glass delegate bypass agent=${bodyId} intent=${intent} ticket=${issueId} (workflow:break-glass holder, not current delegate)`);
    }
  }

  // AI-1860: prefer the command-start source-state snapshot for the transition-legality
  // check. On a multi-step governed command's follow-up mutation the live label has
  // already advanced to the post-transition state; re-checking legality against it
  // self-blocks the command (exit 1) after its own transition applied. The live state
  // is still used above for informational legal-moves hints in block messages.
  const currentState =
    typeof snapshotState === "string" && snapshotState.length > 0
      ? snapshotState
      : getCurrentState(labels, def); // AI-2094: def-aware — a stale state:* label can never win over the real one
  if (!currentState) {
    // AI-1402: For needs-human, fail-closed even without a state label.
    // We cannot determine if there is a forward path, so treat the ticket as actionable.
    // Agents must use 'escape' (break-glass) to exit the workflow.
    if (intent === "needs-human") {
      const legalMoves = `${breakGlassCommand} (break-glass)`;
      return (
        `[Proxy] 'needs-human' is blocked on this workflow ticket (state unknown — treated as actionable). ` +
        `Use '${breakGlassCommand}' to exit the workflow. Legal moves: ${legalMoves}.`
      );
    }
    // A governed wf:dev-impl ticket enters at entry_state with a state:* label applied
    // atomically; a missing label means the projection was corrupted (e.g. a label-stripping
    // CLI verb ran). Previously this failed OPEN — allowing ANY intent, including a deploy
    // that bypasses the Done gate (§5.6). That is exactly how a ticket reached terminal without
    // a pushed branch/PR. Fail CLOSED for all state-advancing intents: the only legal moves on a
    // state-corrupted ticket are the recovery hatches already handled above — 'escape'
    // (break-glass, line ~467), 'refuse-work' (line ~474), and 'needs-human'. The steward must
    // re-establish state (re-accept) to resume the workflow.
    log.warn(`workflow-gate: no state:* label on ${issueId} — blocking '${intent}' (state corrupted; use escape/needs-human or re-accept)`);
    return (
      `[Proxy] '${intent}' blocked: ${issueId} has no 'state:*' workflow label — its workflow state cannot be determined ` +
      `(the projection was likely stripped by a raw mutation or a label-stripping command). ` +
      `Re-establish state via the steward ('accept'), or use '${breakGlassCommand}' to exit the workflow.`
    );
  }

  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) {
    // AI-1872: a state label that exists on the ticket but NOT in the workflow def
    // means the state was removed (e.g. the old `deployment`/`host-deploy` labels
    // after the merge+deploy split) or the def was replaced. Fail CLOSED — a
    // defunct-state ticket must be migrated (escape → re-intake) before any
    // command can proceed. Previously this failed open, which let defunct-state
    // tickets mutate freely after a def change.
    log.warn(`workflow-gate: unknown state '${currentState}' on ${issueId} — failing closed (state not in def)`);
    return (
      `[Proxy] '${intent}' blocked: ticket is in state '${currentState}' which is not defined in workflow '${workflowId}'. ` +
      `This state was likely removed in a workflow def update. ` +
      `Use break-glass ('escape') to re-enter the workflow at intake, or contact a steward to migrate the ticket.`
    );
  }

  const transitions = stateNode.transitions ?? [];
  const match = transitions.find((t) => t.command === intent);

  if (!match) {
    const legalMoves = [...transitions.map((t) => t.command), breakGlassCommand].join(", ");
    return (
      `[Proxy] '${intent}' is not a legal command in state '${currentState}'. ` +
      `Legal moves: ${legalMoves}.`
    );
  }

  // Capability gate — e.g. deploy:execute is Hanzo-only (§16.2).
  // Unknown callers (humans on the sign-off path) bypass capability checks.
  if (match.requires_capability && isCallerKnown) {
    const allowed = await bodyHasCapability(bodyId, match.requires_capability);
    if (!allowed) {
      const legalMoves = [...transitions.map((t) => t.command), breakGlassCommand].join(", ");
      return (
        `[Proxy] '${intent}' requires the '${match.requires_capability}' capability; ` +
        `handoff to the deployment body to proceed. ` +
        `Legal moves: ${legalMoves}.`
      );
    }
  }

  // AI-1731: Comment requirement gate.
  // Transitions marked requires_comment: true must be accompanied by a non-empty
  // comment body (posted via commentCreate in the same request). This ensures
  // review feedback and rejection reasons are never lost. Break-glass is exempt.
  if (match.requires_comment && !hasComment && !breakGlassOverride) {
    log.warn(`workflow-gate: comment gate: '${intent}' on ${issueId} requires a comment — none provided`);
    return (
      `[Proxy] '${intent}' requires a comment explaining the transition. ` +
      `Use --comment-file (or the X-Openclaw-Comment header) to attach a comment to '${intent}'.`
    );
  }

  // §5.7 item 1 / C-2: Artifact-binding gate.
  // If the transition requires an artifact (requires_artifact: true), the caller
  // must supply an artifact ref via the X-Openclaw-Artifact-Ref header.
  // The engine refuses the transition if no artifact is bound — freehand scope
  // has no command (this is the F1 structural kill at the source for Archetype C).
  if (match.requires_artifact && !artifactRef) {
    log.warn(`workflow-gate: artifact gate: ${intent} on ${issueId} requires a bound artifact — none provided`);
    return (
      `[Proxy] '${intent}' requires a bound sprint-plan artifact. ` +
      `Provide a sprint-plan doc reference via the --artifact-ref flag (or X-Openclaw-Artifact-Ref header). ` +
      `Example: ai-systems/projects/<project>/sprints/<sprint-plan>.md`
    );
  }

  // Phase 6.5 / H-7 (AI-1482): Stakes-threshold sign-off gate.
  // If the transition has requires_human_signoff_above_stakes: true and the
  // ticket's stakes level meets or exceeds the workflow's threshold, the deploy
  // must come from a human (Matt), not an AI agent. An AI agent cannot both
  // author the spec and bless its fulfillment on consequential work.
  // A body is considered an AI agent if it is registered in the capability
  // policy (known body = AI agent). Unknown bodies are assumed human.
  if (match.requires_human_signoff_above_stakes && def.stakes) {
    const ticketStakesLevel = resolveStakesLevel(labels, def.stakes);
    if (ticketStakesLevel >= def.stakes.threshold) {
      // AI-2358: designated-approver bypass — if the transition names a
      // requires_capability holder and the caller holds it, they are the
      // designated approver and bypass the stakes gate. Only the designated
      // approver passes; all other AI agents are still blocked.
      if (match.requires_capability && (await bodyHasCapability(bodyId, match.requires_capability))) {
        log.info(`workflow-gate: stakes-threshold gate: ${intent} on ${issueId} — stakes level ${ticketStakesLevel} >= threshold ${def.stakes.threshold}, but caller '${bodyId}' holds required capability '${match.requires_capability}' — designated-approver bypass`);
      } else {
        // A body known in the capability policy is an AI agent; unknown = human
        const isAgent = await isBodyKnown(bodyId);
        if (isAgent) {
          log.warn(`workflow-gate: stakes-threshold gate: ${intent} on ${issueId} blocked — stakes level ${ticketStakesLevel} >= threshold ${def.stakes.threshold}, caller '${bodyId}' is a known AI agent`);
          const legalMoves = [...transitions.map((t) => t.command), breakGlassCommand].join(", ");
          return (
            `[Proxy] '${intent}' blocked: this ticket has elevated stakes (level ${ticketStakesLevel}) ` +
            `and requires human sign-off. AI agent '${bodyId}' cannot self-sign-off on high-stakes work. ` +
            `Legal moves: ${legalMoves}.`
          );
        }
        log.info(`workflow-gate: stakes-threshold gate: ${intent} on ${issueId} — stakes level ${ticketStakesLevel} >= threshold ${def.stakes.threshold}, but caller '${bodyId}' is human/unknown — allowing`);
      }
    }
  }

  // Resolve destination state for subsequent gates.
  const destStateNode = def.states.find((s) => s.id === match.to);

  // AI-1475 Defect 1 + AI-1492 + AI-1497: Merged-PR release gate (§5.6) — a
  // wf:dev-impl ticket must not leave the deployment state forward without
  // evidence that the implementation was pushed, reviewed, and merged.
  // v8: deployment now has two forward exits — `deploy` (→ ac-validate, CI
  // auto-deploys) and `handoff-host-deploy` (→ host-deploy, bare-metal action).
  // The PR merge happens in `deployment` before either, so the gate fires on
  // both. (`done` is now reached later via `validated`, after ac-validate.)
  // Other workflows (ux-audit) have their own gate paths (parent-AC gate).
  //
  // AI-1492 fix: A merged PR satisfies the gate even when the source branch was
  // auto-deleted by GitHub after a squash merge.
  //
  // AI-1497 fix: When branch+PR data are completely absent (both false), this is
  // indistinguishable from a successfully-merged ticket whose data was lost to
  // auto-delete. Since the ticket is in 'deployment' state (reachable only after
  // code-review approval), fail-open rather than stranding the ticket. Only block
  // when partial evidence exists (has branch but no PR = pushed but never reviewed).
  // Also fail-open on null (transient API failure) after one retry.
  if (intent === 'deploy' || intent === 'handoff-host-deploy') {
    let branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    // AI-1497: retry once on null — transient Linear API failure during
    // Hanzo merge+deploy quick succession.
    if (!branchStatus) {
      await new Promise((r) => setTimeout(r, 1000));
      branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    }
    if (!branchStatus) {
      // Two consecutive nulls — transient API failure. Fail-open to avoid
      // stranding tickets; deployment state is already past code review.
      log.warn(`workflow-gate: done gate: could not verify branch/PR status for ${issueId} after retry — failing open`);
    } else if (branchStatus.hasMergedPR) {
      log.info(`workflow-gate: done gate: ${issueId} passed (merged PR confirmed)`);
    } else if (!branchStatus.hasBranch && !branchStatus.hasPR) {
      // AI-1497: Complete absence of evidence — likely lost to auto-delete.
      // Fail-open: a ticket in deployment state has already passed code review,
      // so the PR almost certainly existed and was merged.
      log.info(`workflow-gate: done gate: ${issueId} passed (no branch/PR evidence — treating as merged, data likely lost to auto-delete)`);
      // AI-1797: with no GitHub integration installed, EVERY ticket takes this
      // path — an evidence-free gate. Constant dedup key: one folded alert row,
      // count keeps rising until the integration lands, then it goes quiet.
      notify({
        severity: "warning",
        source: "done-gate",
        title: "done gate passed with no branch/PR evidence (GitHub integration missing?)",
        detail: `Ticket ${issueId} passed '${intent}' with zero GitHub attachments. If this fires for every deploy, the Linear GitHub integration is not installed and the merged-PR gate is verifying nothing.`,
        ticket: issueId,
        dedupKey: "done-gate|no-evidence",
      });
    } else {
      // Partial evidence exists (has branch but no PR, or similar).
      // Block: affirmative evidence that review was not completed.
      // AI-1797: with attachment-derived status hasBranch ≡ hasPR, so this
      // block is currently unreachable (open PR falls through to the pass
      // log below). Kept for defense-in-depth if a richer source returns.
      const missing: string[] = [];
      if (!branchStatus.hasBranch) missing.push('branch not pushed to origin');
      if (!branchStatus.hasPR) missing.push('no pull request associated');
      if (missing.length > 0) {
        log.warn(`workflow-gate: release gate: ${issueId} blocked — ${missing.join('; ')}`);
        return (
          `[Proxy] '${intent}' blocked: cannot release unmerged work. Missing: ${missing.join('; ')}. ` +
          `Push the branch and open a pull request before deploying.`
        );
      }
      log.info(`workflow-gate: done gate: ${issueId} passed (has branch + PR, not yet merged)`);
    }
  }

  // AI-1795: no-CI-auto-deploy guard. On repos flagged `ci_auto_deploy: false`
  // in the instance deploy policy, `deploy` (merge → ac-validate directly) is
  // rejected: merge alone leaves the running service on the old build, and
  // ac-validate would verify a stale artifact (recurred twice on AI-1775).
  // The legal exit for such repos is `handoff-host-deploy` → host-deploy,
  // which is never blocked here. Repo resolution: `repo:*` labels + GitHub
  // attachments; unresolvable or unflagged repos pass (guard is opt-in per
  // repo). Break-glass is exempt (steward recovery path, identity-gated).
  if (intent === "deploy" && !breakGlassOverride) {
    const repoRefs = await resolveTicketRepoRefs(labels, issueId, authToken);
    const flagged = reposWithoutCiAutoDeploy(repoRefs);
    if (flagged.length > 0) {
      const repoList = flagged.join("', '");
      log.warn(`workflow-gate: AI-1795 no-CI-auto-deploy guard blocked 'deploy' on ${issueId} (repo '${repoList}', agent=${bodyId})`);
      notify({
        severity: "warning",
        source: "deploy-policy",
        title: `no-CI-auto-deploy guard blocked 'deploy' (repo: ${flagged.join(", ")})`,
        detail: `Ticket ${issueId}: 'deploy' would advance to ac-validate without the merged artifact running. Agent must use 'handoff-host-deploy' → host-deploy instead.`,
        agent: bodyId,
        ticket: issueId,
      });
      const legalMoves = [...transitions.filter((t) => t.command !== "deploy").map((t) => cliVerbFor(t)), breakGlassCommand].join(", ");
      return (
        `[Proxy] 'deploy' blocked: repo '${repoList}' has no CI auto-deploy — merging alone leaves the running service on the old build, ` +
        `and AC validation would verify a stale artifact. Use 'handoff-host-deploy' to route through host-deploy instead. ` +
        `Legal moves: ${legalMoves}.`
      );
    }
  }

  // Assignment target validation (§4.3, §16.1)
  const ownerRole = destStateNode?.owner_role;
  if (ownerRole && destStateNode?.kind !== 'terminal') {
    let legalBodies: string[];
    try {
      legalBodies = await resolveBodiesForRole(ownerRole);
    } catch {
      legalBodies = []; // fail-open
    }

    if (legalBodies.length > 1) {
      // For meta-intents (continue-workflow/request-revision) on assign.mode: required
      // transitions, a target must be provided. The CLI's generic path does not carry
      // the delegate in the forwarded mutation body (unlike named commands), so a
      // missing target header means no delegate will be set — reject with the valid options.
      if (!target && isMetaIntent && match.assign?.mode === 'required') {
        return `[Proxy] '${intent}' requires an assignment target. Legal targets for role '${ownerRole}': ${legalBodies.join(', ')}.`;
      }
      if (target && !legalBodies.includes(target)) {
        return `[Proxy] '${target}' is not a legal assignment target for '${intent}'. Legal targets for role '${ownerRole}': ${legalBodies.join(', ')}.`;
      }
    } else if (legalBodies.length === 1) {
      if (target && target !== legalBodies[0]) {
        return `[Proxy] '${intent}' auto-assigns to '${legalBodies[0]}' (singleton role); target '${target}' rejected.`;
      }
    }
  }

  // not-implementer constraint (self-review prevention §4.3)
  if (match.assign?.constraint === 'not-implementer' && target && target === bodyId) {
    return `[Proxy] Self-review blocked: reviewer must differ from implementer ('${bodyId}').`;
  }

  // not-self constraint (self-assignment prevention — e.g. a routing head may
  // not claim the worker slot for itself; task.yaml §4.3)
  if (match.assign?.constraint === 'not-self' && target && target === bodyId) {
    return `[Proxy] Self-assignment blocked: '${intent}' may not target the caller ('${bodyId}').`;
  }

  return null;
}

// ── Layer 2: Raw status/assignee mutation interception (AI-1387) ──────────

/**
 * Detect raw mutations on workflow tickets (AI-1387, expanded in AI-1402).
 *
 * When an agent sends an `issueUpdate` with `stateId`, `assigneeId`, or `labelIds`
 * in the input but WITHOUT the `x-openclaw-linear-intent` header, they're bypassing
 * the workflow CLI commands. This function intercepts those raw mutations,
 * resolves the ticket's current state from its labels, and returns a rejection
 * that includes the legal verb set for that state.
 *
 * AI-1402 expansion: also blocks `labelIds` mutations (label manipulation is as
 * capable as state changes for bypassing workflow state) and adds fail-closed
 * enforcement for unknown callers on workflow tickets.
 *
 * Returns null to allow the request through (non-workflow ticket, non-mutation,
 * or no workflow-affecting fields in input). Returns a rejection string otherwise.
 * Fail-open on any error — missing issueId, label fetch failure, etc.
 */
export async function checkRawMutationInterception(
  body: { query?: string; variables?: Record<string, unknown>; operationName?: string } | null,
  issueId: string | null,
  authToken: string,
  bodyId?: string,
  callerLinearUserId?: string | null,
  skipCommentCreate?: boolean,
  skipLabelFields?: boolean,
): Promise<string | null> {
  if (!body) return null;

  // Intercept issueUpdate mutations and commentCreate mutations on governed tickets.
  // AI-1658 AC2: commentCreate bypassed the "issueUpdate-only" guard, letting agents
  // post free-form comments on governed tickets without an intent header.
  const q = body.query ?? "";
  const isIssueUpdate = q.includes("issueUpdate");
  const isCommentCreate = !isIssueUpdate && q.includes("commentCreate");
  if (!isIssueUpdate && !isCommentCreate) return null;

  // When called from the intent path, commentCreate is legitimate — workflow
  // commands (e.g. brief-ready --comment-file) use it to post their required comment.
  if (skipCommentCreate && isCommentCreate) return null;

  // Rebuild WS1 (2026-07-03) — SUPERSEDES AI-1658 AC2: pure commentCreate is
  // ALLOWED on governed tickets. Rationale: (1) comment→delegate routing now
  // wakes the ticket owner, making comments the legitimate nudge/question path
  // mid-state; (2) the step guidance explicitly instructs agents to ask for
  // missing specifics in a comment; (3) human UI comments never went through
  // this gate, so the block only created agent/human asymmetry. State, label,
  // assignee, and delegate manipulation remain fully gated below — a comment
  // cannot smuggle a transition (isCommentCreate excludes issueUpdate).
  if (isCommentCreate) {
    return null;
  }

  // Check if the mutation touches any workflow-affecting field.
  // Blocked: stateId (status), assigneeId (assignee), labelIds (label manipulation).
  // Allowed: title, description, priority, dueDate, and other non-workflow fields.
  //
  // AI-1402 follow-up: a field can reach issueUpdate three ways and the old
  // detector only saw the first, so inlining the input literally in the query
  // string (or routing the value through a differently-named scalar variable)
  // bypassed the gate entirely:
  //   (a) variables.input.<field>        — CLI shape; field key lives in variables
  //   (b) input:{<field>:$var} inline    — field key in query text, value in vars
  //   (c) input:{<field>:"literal"}      — field key and value both in query text
  // GraphQL input-object keys cannot be aliased, so for (b)/(c) the literal field
  // identifier must appear in the query text. Detect across all encodings by
  // (1) scanning the query string for the field identifier and (2) deep-scanning
  // the variables for the field key at any depth.
  const vars = body.variables ?? {};
  const queryHasField = (field: string) => new RegExp(`\\b${field}\\b`).test(q);
  const varsHaveKey = (obj: unknown, key: string): boolean => {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj)) return obj.some((v) => varsHaveKey(v, key));
    const rec = obj as Record<string, unknown>;
    if (key in rec) return true;
    return Object.values(rec).some((v) => varsHaveKey(v, key));
  };
  const touches = (field: string) => queryHasField(field) || varsHaveKey(vars, field);

  const hasStateChange = touches("stateId");
  const hasAssigneeChange = touches("assigneeId");
  // AI-1658 AC1: also intercept addedLabelIds/removedLabelIds — additive/subtractive
  // label mutations that the old check missed, letting agents bypass Layer 2 via these fields.
  // When skipLabelFields is true (intent path after state-label stripping), label fields
  // are excluded from interception — the proxy's stripStateLabelDeltas already handled
  // state:* labels, and non-state labels are legitimate payload.
  const hasLabelChange = !skipLabelFields && (touches("labelIds") || touches("addedLabelIds") || touches("removedLabelIds"));
  // AI-1535: delegate is a distinct field from assignee. App-user delegates are
  // written via `delegateId` (assigneeId is omitted for them, AI-1395), so a raw
  // delegate write was invisible to this detector and bypassed the delegate-only
  // guard entirely — a non-delegate could yank the delegate off the rightful owner.
  const hasDelegateChange = touches("delegateId");

  if (!hasStateChange && !hasAssigneeChange && !hasLabelChange && !hasDelegateChange) return null;

  // AI-1347: this is a raw workflow-affecting mutation but the caller did not
  // expose the ticket id in a place the proxy could resolve (no id variable, no
  // inline id in the query). We cannot fetch labels to confirm whether the ticket
  // is governed, so we cannot prove it is safe. Fail CLOSED: a raw stateId /
  // assigneeId / labelIds change with no resolvable ticket and no intent header
  // is exactly the bypass shape this gate exists to stop.
  if (!issueId) {
    log.warn(`workflow-gate: raw workflow-field mutation with unresolvable issueId — blocking (fail-closed)`);
    return (
      `[Proxy] Direct status/assignee/label changes on workflow tickets must go through ` +
      `workflow commands, and the ticket id could not be resolved from this request. ` +
      `Re-issue using the linear CLI workflow commands (or pass the ticket id as a variable).`
    );
  }

  // This is a raw workflow-affecting mutation — check if the ticket is on a workflow.
  const { labels, delegateId } = await fetchTicketContext(issueId, authToken);
  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null; // ad-hoc ticket — pass-through

  // AI-1402: Fail-closed on unknown caller on governed workflow tickets.
  // If the caller body is not registered in the capability policy, block the mutation.
  if (bodyId && !(await isBodyKnown(bodyId))) {
    log.warn(`workflow-gate: unknown caller '${bodyId}' raw mutation on wf:${workflowId} ticket ${issueId} — blocking`);
    return (
      `[Proxy] Unknown caller '${bodyId}' blocked on workflow ticket. ` +
      `Ensure this agent is registered in the capability policy.`
    );
  }

  let def: WorkflowDef | undefined;
  try {
    const registry = await loadWorkflowRegistry();
    def = registry.get(workflowId);
  } catch {
    return null; // fail-open
  }

  if (!def) return null; // unknown workflow — pass-through (AI-1530)

  // AI-1535: a *delegate-only* raw change (delegateId changed, no state/assignee/
  // label) gets delegate-only semantics rather than the blanket block below. The
  // delegate-routing meta-commands (handoff-work, undelegate) write delegateId
  // with no intent header, and they are LEGITIMATE for the current delegate —
  // blanket-blocking them would break re-routing. But a non-delegate (e.g. a prior
  // owner's lingering session, as in the AI-1531 dogfood) must not be able to yank
  // the delegate. Mirror the intent-path delegate-only rule (lines ~912-925):
  //   - caller IS the current delegate            → allow (legitimate re-route)
  //   - caller is a known non-delegate            → block
  //   - caller unverifiable + ticket has delegate → block (AI-1400 B2 parity)
  //   - no current delegate / no caller+delegate  → fail-open (establishing first delegate)
  //
  // AI-1835: the current-delegate allowance must NOT extend to clearing the
  // delegate (delegateId → null). A null write is a self-clear, not a re-route
  // — it is the shape of the ungoverned direct-Done bypass (the `complete` verb
  // clears delegate + assignee + state). A non-null delegateId write remains
  // legitimate (handoff-work, undelegate).
  const inputDelegateId =
    vars?.input && typeof vars.input === "object"
      ? (vars.input as Record<string, unknown>).delegateId
      : undefined;
  const isClearingDelegate =
    hasDelegateChange && (inputDelegateId === null || /\bdelegateId\s*:\s*null\b/.test(q));
  // AI-1857: Block delegate clears regardless of mutation shape. The combined
  // {delegateId:null, assigneeId:null} shape (partial semantic-verb application)
  // has hasAssigneeChange=true → delegateOnlyChange=false → bypasses the AI-1835 guard.
  // Check isClearingDelegate before delegateOnlyChange so the combined shape is caught.
  // Only applies when no state change is present (hasStateChange=true has its own message).
  if (isClearingDelegate && delegateId && !hasStateChange) {
    log.warn(`workflow-gate: raw delegate null (self-clear) block agent=${bodyId} ticket=${issueId}`);
    return (
      `[Proxy] Direct delegate clear blocked: the current delegate may re-route ${issueId} ` +
      `but may not null the delegate field directly. Use undelegate or handoff-work to release ownership.`
    );
  }
  const delegateOnlyChange =
    hasDelegateChange && !hasStateChange && !hasAssigneeChange && !hasLabelChange;
  if (delegateOnlyChange) {
    if (callerLinearUserId && delegateId && callerLinearUserId === delegateId) {
      if (isClearingDelegate) {
        log.warn(`workflow-gate: raw delegate null (self-clear) block agent=${bodyId} ticket=${issueId}`);
        return (
          `[Proxy] Direct delegate clear blocked: the current delegate may re-route ${issueId} ` +
          `but may not null the delegate field directly. Use undelegate or handoff-work to release ownership.`
        );
      }
      return null; // current delegate may re-route (non-null target only)
    }
    if (!callerLinearUserId && delegateId) {
      log.warn(`workflow-gate: raw delegate unknown-caller block agent=${bodyId} ticket=${issueId}`);
      return (
        `[Proxy] Direct delegate change blocked: caller '${bodyId}' cannot be verified and ${issueId} has a known delegate. ` +
        `Register the agent in agents.json with a linearUserId, or re-route via a workflow command.`
      );
    }
    if (callerLinearUserId && delegateId && callerLinearUserId !== delegateId) {
      log.warn(`workflow-gate: raw delegate-only block agent=${bodyId} ticket=${issueId} (not current delegate)`);
      return (
        `[Proxy] Direct delegate change blocked: ${bodyId} is not the current delegate for ${issueId}. ` +
        `Only the ticket delegate may re-route it (use handoff-work as the delegate, or advance via a workflow transition verb).`
      );
    }
    // AI-1570: no current delegate, but the ticket is governed. The old code
    // fail-opened here, letting ANY known body ESTABLISH a delegate — including a
    // stale out-of-role session (the AI-1560 dogfood: Igor, role `dev`, was sitting
    // in `deployment` state and re-spawned a duplicate Hanzo by writing the delegate
    // after it had been cleared). Authorize the first-delegate write by role: the
    // caller may only set the delegate if it fills the current state's owner_role or
    // the workflow steward (break-glass owner) role. Fail open only on genuine
    // resolution failure (no state label, unknown/terminal/ownerless state, or roles
    // with zero bodies — a policy gap) so legitimate traffic is never blocked.
    const stateId = getCurrentState(labels);
    if (!stateId) return null; // no state label — can't determine owner, fail-open
    // Enrollment carve-out: at the workflow ENTRY state a known orchestrator (e.g.
    // `ai`, which fills no role) legitimately establishes the first delegate when a
    // ticket joins the workflow. The routing-guard corrects the target to the legal
    // state owner on the webhook side, so the worst case is a dispatch to the rightful
    // owner. The AI-1560 incident was at `deployment` (a mid-workflow state), not the
    // entry state, so it stays blocked by the role check below. Only applies with a
    // known caller (unknown bodies were already rejected above, AI-1402).
    if (bodyId && def.entry_state && stateId === def.entry_state) return null;
    // AI-1579: recovery-actor carve-out. A configured recovery identity (e.g.
    // `ai`) may re-establish a delegate on a governed ticket whose delegate is
    // currently EMPTY (orphaned) at ANY state, including a mid-workflow state
    // whose owner_role the actor does not fill. This is the authorization
    // counterpart to the stale-session recovery machinery (StaleSessionForensics
    // .recoverTicket / NoActivityDetector): when a delegate's session dies without
    // advancing the ticket, recovery clears the delegate and must re-dispatch by
    // writing a new delegateId — a raw write from `ai`, which the role check below
    // would reject (the orchestrator fills no workflow role). Scope:
    //   - only reachable when the current delegate is empty (every active-delegate
    //     case returned above) — so this can NEVER steal a live delegate;
    //   - only the configured recovery actor(s); every other out-of-role caller is
    //     still blocked by the role check below (the AI-1560 Igor incident at
    //     `deployment` stays blocked);
    //   - the routing-guard still corrects the dispatch target to the legal state
    //     owner on the webhook side, so the worst case is a dispatch to the
    //     rightful owner.
    const recoveryActors = Array.isArray(def.recovery_actor)
      ? def.recovery_actor
      : def.recovery_actor
        ? [def.recovery_actor]
        : [];
    if (bodyId && recoveryActors.includes(bodyId)) {
      const ownerRoleForLog = def.states.find((s) => s.id === stateId)?.owner_role ?? "(ownerless)";
      log.warn(
        `workflow-gate: recovery-actor first-delegate ALLOW actor=${bodyId} ticket=${issueId} state=${stateId} resolved_owner_role=${ownerRoleForLog} (delegate was empty — orphaned-ticket recovery)`,
      );
      return null;
    }
    const stateNode = def.states.find((s) => s.id === stateId);
    const ownerRole = stateNode?.owner_role;
    if (!ownerRole) return null; // ownerless/terminal state — fail-open
    const authorized = new Set<string>(await resolveBodiesForRole(ownerRole));
    const stewardRole = def.break_glass?.owner_role;
    if (stewardRole) {
      for (const b of await resolveBodiesForRole(stewardRole)) authorized.add(b);
    }
    if (authorized.size === 0) return null; // misconfigured role (no bodies) — fail-open
    if (!bodyId || !authorized.has(bodyId)) {
      log.warn(
        `workflow-gate: raw first-delegate block agent=${bodyId} ticket=${issueId} state=${stateId} owner_role=${ownerRole} (caller is not the state owner or steward)`,
      );
      return (
        `[Proxy] Direct delegate change blocked: '${bodyId}' may not establish a delegate on ${issueId} ` +
        `(state '${stateId}' is owned by role '${ownerRole}'). ` +
        `Only the state owner or workflow steward may set the delegate — advance the ticket via a workflow transition verb instead.`
      );
    }
    return null; // caller fills the owning/steward role — allow first-delegate write
  }

  const breakGlassCommand = def.break_glass?.command ?? "escape";
  const currentState = getCurrentState(labels);

  if (!currentState) {
    // No state label — can't determine legal moves, but still block with a generic message.
    const allCommands = new Set<string>();
    for (const s of def.states) {
      for (const t of s.transitions ?? []) allCommands.add(t.command);
    }
    allCommands.add(breakGlassCommand);
    return (
      `[Proxy] Direct mutation blocked on this workflow ticket (state unknown). ` +
      `Use workflow commands: ${[...allCommands].join(", ")}.`
    );
  }

  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) {
    // AI-1914 AC4: fail CLOSED on a defunct state. The ticket is governed
    // (wf:* present) but its state:* label names a state that no longer exists
    // in the live def — it was removed by a def-version bump. The old fail-OPEN
    // here let ANY known caller silently raw-swap the workflow state label on a
    // stranded ticket (exactly how AI-1857 was migrated through this hole). Block
    // it and point the caller at the sanctioned migration path so closing the
    // hole does not recreate the AI-1857 admin-console-only deadlock: the
    // def-load migration map (AC1) auto-migrates on load, and the steward
    // `migrate-state` verb (AC2, workflow:break-glass) covers the no-map case.
    log.warn(
      `workflow-gate: raw mutation on defunct-state ticket ${issueId} state=${currentState} wf=${workflowId} agent=${bodyId} — blocking (fail-closed, AI-1914 AC4)`,
    );
    return (
      `[Proxy] Direct status/label changes are blocked on ${issueId}: state '${currentState}' no longer exists ` +
      `in workflow '${workflowId}' (removed by a def-version change), so this raw label swap cannot be safely ` +
      `validated. Do not raw-swap the state label. The def-load migration map auto-migrates stranded tickets on ` +
      `load; for a one-off, a steward must use the sanctioned \`migrate-state\` verb (requires workflow:break-glass).`
    );
  }

  // Build per-command help strings with assignment info.
  const helpLines = await Promise.all(
    (stateNode.transitions ?? []).map(async (t) => {
      const { bodies, mode } = await resolveTransitionTargets(t, def);
      let cmd = `linear ${t.command} ${issueId}`;
      if (mode === "required") {
        cmd += ` <${bodies.join("|")}>`;
      }
      return `  - \`${cmd}\` (→ ${t.to})`;
    }),
  );
  helpLines.push(`  - \`linear ${breakGlassCommand} ${issueId}\` (break glass → ${def.break_glass?.to ?? "escape"}, legal from any state)`);

  const changedFields: string[] = [];
  if (hasStateChange) changedFields.push("status");
  if (hasAssigneeChange) changedFields.push("assignee");
  if (hasLabelChange) changedFields.push("labels");
  if (hasDelegateChange) changedFields.push("delegate");

  return (
    `[Proxy] Direct ${changedFields.join("/")} changes are blocked on this workflow ticket ` +
    `(state: **${currentState}**). Use workflow commands instead:\n\n` +
    helpLines.join("\n")
  );
}

// ── Layer 1: Proactive legal-verb re-injection at completion (AI-1387) ────

/**
 * Generate a legal-verb reminder for the NEW state after a successful transition.
 *
 * Layer 1 (AI-1387): re-surfaces the legal command set at the completion/decision
 * moment, so agents don't need to rely on the stale delegation-time injection.
 *
 * Returns null when not applicable (ad-hoc ticket, unknown state, terminal state).
 * Returns a formatted string with the legal commands for the NEW state.
 * Fail-open on any error.
 */
export async function buildStateTransitionReminder(
  intent: string,
  issueId: string | null,
  authToken: string,
): Promise<string | null> {
  if (!issueId) return null;

  // Resolve the correct def for this ticket's workflow.
  // AI-1708: fetchWorkflowLabels now throws TransientLabelFetchError on
  // transient failures — fail open here (no reminder) rather than crash.
  let labels: string[];
  try {
    labels = await fetchWorkflowLabels(issueId, authToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`buildStateTransitionReminder: label fetch failed for ${issueId}: ${msg} — skipping reminder`);
    return null;
  }
  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null; // ad-hoc ticket

  const def = await loadWorkflowDefById(workflowId);
  if (!def) return null;

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  // Determine the destination state from the intent.
  let destStateName: string;
  // AI-2094: also capture the SOURCE state + matched transition so we can detect
  // a same-native-column advance (todo→todo) that needs explicit "advanced"
  // framing (below), lest it read as a silent decline.
  let fromState: WorkflowState | undefined;
  let matched: WorkflowTransition | undefined;
  if (intent === breakGlassCommand) {
    destStateName = def.break_glass?.to ?? "escape";
  } else {
    // Find which transition this intent triggers by scanning all states.
    // We don't know the current state here, so we look for any transition
    // matching this intent. Since commands are unique per state in dev-impl,
    // this works. For ambiguous workflows, the label-based approach below
    // would be needed.
    let found = false;
    for (const s of def.states) {
      const t = (s.transitions ?? []).find((tr) => tr.command === intent);
      if (t) {
        destStateName = t.to;
        fromState = s;
        matched = t;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }

  // destStateName is set above in both branches
  const destState = def.states.find((s) => s.id === (destStateName as string));
  if (!destState) return null;

  // Terminal states have no transitions — no reminder needed.
  if (destState.kind === "terminal" || !destState.transitions?.length) return null;

  const transitions = destState.transitions;
  const helpLines = await Promise.all(
    transitions.map(async (t) => {
      const { bodies, mode } = await resolveTransitionTargets(t, def);
      let cmd = `linear ${t.command} ${issueId}`;
      if (mode === "required") {
        cmd += ` <${bodies.join("|")}>`;
      }
      return `  - \`${cmd}\` (→ ${t.to})`;
    }),
  );
  helpLines.push(`  - \`linear ${breakGlassCommand} ${issueId}\` (break glass, legal from any state)`);

  // AI-2094 (AC3): same-native-column advance legibility. review, sign-off and
  // doing all project to native_state: todo, so a forward `continue` move like
  // `approve` (review → sign-off) advances the state:* label without changing the
  // Linear column — it LOOKS like nothing happened, and operators reached for
  // `escape`, marking genuinely-complete work Invalid (the GEN-103 failure). When
  // the move is a same-column forward continue, prepend an explicit advance banner
  // that names the destination, its owner, and the SECOND continue gate that
  // actually closes the ticket, so a todo→todo move never reads as a silent decline.
  let advanceBanner = "";
  if (
    matched?.generic === "continue" &&
    fromState?.native_state &&
    destState.native_state &&
    fromState.native_state === destState.native_state
  ) {
    const nextContinue = (destState.transitions ?? []).find((t) => t.generic === "continue");
    const owner = destState.owner_role ?? "the next owner";
    if (nextContinue) {
      const nextDest = def.states.find((s) => s.id === nextContinue.to);
      const verb = nextDest?.kind === "terminal" ? "close" : "advance";
      advanceBanner =
        `[Workflow] Advanced to ${destState.id} — this shares the same Linear column ` +
        `(${destState.native_state}) as the previous state, so the board won't visibly change. ` +
        `This is a real forward move, not a decline. The ${owner} must now run ` +
        `\`linear ${nextContinue.command} ${issueId}\` (continue-workflow) to ${verb} the ticket.\n\n`;
    }
  }

  return (
    advanceBanner +
    `[Workflow] You are now in state: **${destState.id}**. Your legal action(s):\n` +
    helpLines.join("\n")
  );
}

// ── B2: Atomic state-label transition application ─────────────────────────

/**
 * Apply the state-label transition triggered by a legal command (AI-1353 / §4.2).
 *
 * Called by proxy.ts after a validated command is successfully forwarded to Linear.
 * Re-derives the ticket's current state via an independent label fetch (never trusts
 * the caller's state snapshot — §11). Applies the transition by swapping state:old →
 * state:new in a single issueUpdate mutation so the ticket never carries zero or two
 * state:* labels.
 *
 * Seam decision (documented per ticket): the proxy applies the transition, not the
 * CLI. This couples the state change to the validated forward — an agent cannot issue
 * a raw GraphQL mutation and skip the transition. The CLI only needs to send the
 * x-openclaw-linear-intent header; the connector handles the bookkeeping.
 *
 * Idempotent: if the ticket is already in the target state, no mutation is issued.
 * Fail-open: any API error is logged; the caller's response is not affected.
 *
 * Special targets:
 *   __ad_hoc__ — ticket leaves the workflow; removes state:* and wf:* labels entirely.
 *   escape     — terminal break-glass state; transitions to state:escape normally.
 */
export interface TransitionFeedback {
  /**
   * The implementer / from-state owner, from X-Openclaw-From-Body.
   * AI-2036: optional — the implementer store supplies it when the header is absent.
   */
  fromBody?: string | null;
  /**
   * The raw reason code from X-Openclaw-Feedback-Category.
   * AI-2036: optional and unvalidated — no client sends this header today, so the
   * write path resolves the category from the comment or falls back. Validation
   * happens in resolveReasonCode(), not here.
   */
  reasonCode?: string | null;
  /** Free-text feedback from the comment body. */
  freeText?: string | null;
  /** Dispatch-cycle correlation id, when the caller knows it. */
  wakeId?: string | null;
}

export interface ApplyStateTransitionOptions {
  /** Agent/body issuing the transition (the reviewer). */
  bodyId?: string;
  /** Optional observation store for recording feedback observations. */
  observationStore?: ObservationStore;
  /** Structured feedback data for transitions with feedback.required. */
  feedback?: TransitionFeedback;
  /** §5.7 item 1 / C-2: artifact ref to bind at intake.accept (sprint-plan doc path). */
  artifactRef?: string | null;
  /**
   * AI-1498 fix: the workflow state the ticket was in BEFORE the CLI's forwarded
   * mutation ran. Because the CLI advances the `state:*` label inside its own
   * forwarded `issueUpdate`, by the time this post-forward pass reads the ticket
   * the label is already at the destination — making an intent-based transition
   * lookup from the (post-move) current state miss and skip the native write.
   * Passing the captured pre-forward state lets the proxy compute the transition
   * from the true source so the atomic label+delegate+native write still fires.
   * Falls back to the ticket's current state:* label when undefined.
   */
  sourceStateOverride?: string;
  /**
   * AI-1709: CLI-supplied target agent name (from X-Openclaw-Linear-Target header).
   * Required for multi-body role transitions (e.g. `tests-ready` targeting a specific
   * dev body). The proxy resolves this to a Linear user ID and sets the delegate
   * atomically with the state label. If the target cannot be resolved, the transition
   * is aborted fail-closed.
   */
  cliTarget?: string;
  /** AI-1799: enrolled-tickets mirror — writes state transitions to the board mirror. */
  enrolledTicketsStore?: EnrolledTicketsStore;
  /** AI-1762: operational-event sink for transition-write-failed events. */
  operationalEventStore?: OperationalEventStore;

  /**
   * AI-1977: Pre-computed delegateId to use instead of resolving via role/prior-implementer.
   * When provided, applyStateTransition skips its own delegate resolution (Step 2) and
   * uses this value directly. This allows the proxy to inject the delegateId into the
   * forwarded mutation (so webhook #1 carries the correct delegate), while
   * applyStateTransition sets only the state label + native state atomically without
   * duplicating the delegate write.
   * Providing `null` here is equivalent to `resolvedDelegateId = null` (terminal state).
   */
  delegateOverride?: string | null;
}

/**
 * AI-1809: machine-readable outcome of applyStateTransition.
 *
 * A workflow transition must be all-or-nothing across its facets (state label,
 * delegate, native status). When it is anything other than fully applied, the
 * caller (the proxy) must be able to surface that to the requesting agent in a
 * machine-readable form — a stderr-only warning beside a success response is
 * how AI-1773 ended up in a split state the proxy itself couldn't route out of.
 */
export interface TransitionApplyResult {
  /**
   * applied — all facets written atomically (or an equivalent gated helper applied them);
   * noop    — nothing to do (ad-hoc ticket, already in target state);
   * blocked — a governance gate intentionally stopped the transition;
   * failed  — a resolution or write genuinely failed; the ticket may now be
   *           inconsistent with the agent's expectation and needs attention.
   */
  status: "applied" | "noop" | "blocked" | "failed";
  /** Stable machine-readable code (e.g. "atomic-mutation-failed", "release-gate"). */
  code: string;
  /** Human-readable detail. */
  detail?: string;
  /** The source state, or null when escaping from a label-stripped ticket (AI-1813). */
  from?: string | null;
  to?: string;
}

/**
 * AI-1992: Fetch just the parent issue description for the pre-transition
 * fan-out spec gate. Query name includes `IssueTeamParent` so it shares the
 * fanout module's fetch shape. Returns null on any failure (caller treats a
 * null/empty description as an unvalidatable spec → refuse).
 */
async function fetchFanoutSpecDescription(issueId: string, authToken: string): Promise<string | null> {
  const query = `
    query IssueTeamParent($id: String!) {
      issue(id: $id) { id description }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    const data = (await res.json()) as { data?: { issue?: { description?: string | null } | null } };
    return data.data?.issue?.description ?? null;
  } catch (err) {
    log.warn(`workflow-gate: AI-1992: failed to fetch description for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * AI-1992: Post a plain workflow comment on a governed ticket (e.g. the
 * fan-out refusal notice). Fail-open — a failed comment never changes control flow.
 */
async function postComment(internalIssueId: string, body: string, authToken: string): Promise<void> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalIssueId, body } }),
    });
  } catch (err) {
    log.warn(`workflow-gate: failed to post comment on ${internalIssueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function applyStateTransition(
  intent: string,
  issueId: string | null,
  authToken: string,
  options?: ApplyStateTransitionOptions,
): Promise<TransitionApplyResult> {
  // TODO(AI-1347): no-op on missing issueId carries the same fail-open posture as B1.
  if (!issueId) return { status: "noop", code: "no-issue-id" };

  const issue = await fetchIssueWithLabels(issueId, authToken);
  if (!issue) {
    log.warn(`workflow-gate: B2 apply: could not fetch labels for ${issueId} — skipping`);
    return { status: "failed", code: "context-fetch-failed", detail: `could not fetch labels for ${issueId}` };
  }

  const labelNames = issue.labels.map((l) => l.name);
  const workflowId = getWorkflowId(labelNames);
  if (!workflowId) return { status: "noop", code: "ad-hoc" }; // ad-hoc ticket — no-op

  let def: WorkflowDef | undefined;
  try {
    const registry = await loadWorkflowRegistry();
    def = registry.get(workflowId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: B2 apply: failed to load workflow registry: ${msg} — skipping`);
    return { status: "failed", code: "registry-load-failed", detail: msg };
  }

  if (!def) return { status: "noop", code: "unknown-workflow", detail: `no definition for wf:${workflowId}` }; // unknown workflow — no-op (AI-1530)

  // AI-1498 fix: prefer the captured pre-forward state. The CLI advances the
  // state:* label inside its own forwarded mutation, so by now `labelNames`
  // already reflects the destination; using it as the transition source makes
  // the intent lookup miss and skips the native write. The proxy captures the
  // true source before forwarding and passes it as sourceStateOverride.
  const actualStateName = getCurrentState(labelNames, def); // AI-2094: def-aware most-advanced resolution
  const currentStateName = options?.sourceStateOverride ?? actualStateName;

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  // AI-2035: terminal re-entry guard (reciprocal of the setStateAtomic terminal
  // guard at §"AI-1954 AC3"). A reviewer's semantic command can emit >1 mutation
  // under one sticky intent header; the trailing same-turn mutation re-enters
  // here ~seconds later, inside Linear's read-after-write lag window, so the live
  // reads (actualStateName) and the proxy's captured sourceStateOverride BOTH
  // still show the pre-terminal state — and would match a forward edge that
  // silently overwrites the just-applied terminal state (the observed Done→Doing
  // bounce on AI-2027). getAppliedState is the authoritative destination that
  // write 1 recorded via recordAppliedState; it is lag-proof, so prefer it as the
  // true source. If that source is terminal, refuse the trailing write LOUDLY.
  // break-glass (escape) is exempt: it is the recovery path OUT of a terminal or
  // corrupted state and must stay legal.
  if (intent !== breakGlassCommand) {
    const resolvedSource = getAppliedState(issue.identifier) ?? currentStateName;
    const resolvedSourceNode = resolvedSource
      ? def.states.find((s) => s.id === resolvedSource)
      : undefined;
    if (resolvedSourceNode?.kind === "terminal") {
      log.warn(
        `workflow-gate: AI-2035: terminal re-entry guard — refusing '${intent}' on ${issueId}; ` +
          `applied source state '${resolvedSource}' is terminal` +
          (resolvedSource !== currentStateName ? ` (live read lagged at '${currentStateName ?? "unknown"}')` : ""),
      );
      return {
        status: "blocked",
        code: "terminal-reentry-guard",
        detail:
          `'${intent}' refused: ${issueId} is already at terminal state '${resolvedSource}'. ` +
          `This is a trailing same-turn mutation inside the read-after-write lag window; the terminal ` +
          `disposition stands and must not be reopened by a re-entrant write.`,
        from: resolvedSource,
      };
    }
  }

  let toStateName: string;
  let matchedTransition: WorkflowTransition | undefined;

  // AI-1813 fix: break-glass (escape) must be legal when no state:* label is
  // present — that's precisely the corruption escape exists to recover from.
  // The no-source-state guard below applies only to non-break-glass intents.
  if (intent === breakGlassCommand) {
    toStateName = def.break_glass?.to ?? "escape";
  } else {
    if (!currentStateName) {
      log.warn(`workflow-gate: B2 apply: no state:* label on ${issueId} — skipping`);
      return { status: "failed", code: "no-state-label", detail: `workflow ticket ${issueId} has no state:* label` };
    }
    const stateNode = def.states.find((s) => s.id === currentStateName);
    matchedTransition = stateNode?.transitions?.find((t) => t.command === intent);
    if (!matchedTransition) {
      // Should not happen — B1 already validated the command — but fail-open.
      log.warn(
        `workflow-gate: B2 apply: no transition for '${intent}' in state '${currentStateName}' on ${issueId} — skipping`,
      );
      return { status: "failed", code: "no-transition", detail: `no transition for '${intent}' in state '${currentStateName}'`, from: currentStateName };
    }
    toStateName = matchedTransition.to;
  }

  // ── Special target: __ad_hoc__ ─────────────────────────────────────────
  // Ticket is demoted out of the workflow — remove state:* and wf:* labels.
  if (toStateName === "__ad_hoc__") {
    const keepIds = issue.labels
      .filter((l) => !l.name.startsWith("state:") && !l.name.startsWith("wf:"))
      .map((l) => l.id);
    await issueUpdateLabels(issue.internalId, keepIds, authToken);
    // AI-1534: ticket left the workflow — drop any cached state so it can't
    // override a later live read.
    clearAppliedState(issue.identifier);
    // AI-1799: mirror — mark the ticket as having left the workflow.
    options?.enrolledTicketsStore?.demoteEnrolled(issue.identifier ?? issueId);
    log.info(
      `workflow-gate: B2 apply: ${issueId} demoted to __ad_hoc__ — removed state:* and wf:* labels`,
    );
    return { status: "applied", code: "demoted-ad-hoc", from: currentStateName, to: "__ad_hoc__" };
  }

  // ── AI-1992: Pre-transition fan-out spec gate (AC5) ──────────────────────
  // When the current state declares a `fanout` block, the spawn spec must be
  // fully validated BEFORE the atomic state mutation. A malformed, ambiguous,
  // or empty spec refuses the transition outright — no state change, no partial
  // spawn — and posts an actionable error comment. The validated findings are
  // stashed and reused post-transition so the engine never re-guesses the spec.
  let pendingFanout: { config: FanoutConfig; findings: Finding[] } | null = null;
  const fanoutConfig = intent === breakGlassCommand
    ? null
    : shouldTriggerFanout(def, currentStateName ?? "", intent);
  if (fanoutConfig) {
    const specDescription = await fetchFanoutSpecDescription(issueId, authToken);
    // AI-2199: load registry to validate per-entry child workflow ids.
    // Fail-open: if registry load fails, skip per-entry validation (backward compat).
    let registeredWorkflows: Set<string> | undefined;
    try {
      const registry = await loadWorkflowRegistry();
      registeredWorkflows = new Set(registry.keys());
    } catch (err) {
      log.warn(`workflow-gate: AI-2199: failed to load workflow registry for per-entry validation: ${err instanceof Error ? err.message : String(err)}`);
    }
    const validation = validateFanoutSpec(specDescription, fanoutConfig, registeredWorkflows);
    if (!validation.ok) {
      log.warn(
        `workflow-gate: AI-1992: fan-out spec REFUSED for ${issueId} (state '${currentStateName}' → '${toStateName}'): ${validation.reason}`,
      );
      await postComment(
        issue.internalId,
        `⛔️ **Fan-out refused — transition not applied.**\n\n` +
        `The \`${intent}\` transition out of \`${currentStateName}\` fans out into \`${fanoutConfig.child_workflow}\` children, ` +
        `but the spawn spec could not be validated:\n\n> ${validation.reason}\n\n` +
        `No state change was made and no children were created. Fix the spec and re-run \`${intent}\`.`,
        authToken,
      );
      return {
        status: "failed",
        code: "fanout-spec-invalid",
        detail: validation.reason,
        from: currentStateName,
        to: toStateName,
      };
    }
    pendingFanout = { config: fanoutConfig, findings: validation.findings };
  }

  // ── Idempotency check (AI-1490 hardened) ────────────────────────────────
  // If the ticket is already in the target state, verify the state:* label
  // is actually present. If it's missing (CLI partial failure, race condition),
  // re-stamp it. Previously this was a blind no-op, which meant a lost label
  // would never be recovered.
  // AI-1534: this branch is state-preserving (source === destination), so it
  // intentionally neither records nor clears the applied-state cache — any
  // existing entry already holds this same state, and its absence is harmless.
  if (currentStateName === toStateName) {
    const targetLabelName = `state:${toStateName}`;
    const hasTargetLabel = issue.labels.some((l) => l.name === targetLabelName);
    if (hasTargetLabel) {
      // AI-2115 Bug 2: the idempotency short-circuit must not fire while a *stale*
      // `state:*` label lingers alongside the correct target label. getCurrentState
      // returns the first `state:*` label it finds, so a stale label mis-derives the
      // workflow state and (via the meta-intent resolver) mis-routes forward commands
      // — this is how a stale `state:routing` label survived `escape` and kept GEN-33
      // wedged. Purge any non-target `state:*` label here, and fail loudly if the
      // mutation does not persist; never silently no-op with a stale label present.
      const staleStateLabels = issue.labels.filter(
        (l) => l.name.startsWith("state:") && l.name !== targetLabelName,
      );
      if (staleStateLabels.length > 0) {
        const cleanedLabelIds = issue.labels
          .filter((l) => !l.name.startsWith("state:"))
          .map((l) => l.id);
        const targetLabelId = issue.labels.find((l) => l.name === targetLabelName)?.id;
        if (targetLabelId) cleanedLabelIds.push(targetLabelId);
        const purged = await issueUpdateLabels(issue.internalId, cleanedLabelIds, authToken);
        if (!purged) {
          log.warn(
            `workflow-gate: B2 apply: ${issueId} in state '${toStateName}' — failed to purge stale state:* label(s): ${staleStateLabels.map((l) => l.name).join(", ")}`,
          );
          return { status: "failed", code: "atomic-mutation-failed", detail: `purge of stale state:* label(s) [${staleStateLabels.map((l) => l.name).join(", ")}] did not apply`, from: currentStateName, to: toStateName };
        }
        log.info(
          `workflow-gate: B2 apply: ${issueId} in state '${toStateName}' — purged ${staleStateLabels.length} stale state:* label(s): ${staleStateLabels.map((l) => l.name).join(", ")}`,
        );
        return { status: "applied", code: "stale-label-purged", from: currentStateName, to: toStateName };
      }
      log.info(
        `workflow-gate: B2 apply: ${issueId} already in state '${toStateName}' with label present — no-op`,
      );
      return { status: "noop", code: "already-in-state", from: currentStateName, to: toStateName };
    }
    // Label is missing despite being in the correct state — re-stamp.
    log.warn(
      `workflow-gate: B2 apply: ${issueId} is in state '${toStateName}' but label '${targetLabelName}' is missing — re-stamping`,
    );
    const newLabelId = await findOrCreateLabel(
      issue.teamId,
      targetLabelName,
      authToken,
    );
    if (!newLabelId) {
      log.warn(`workflow-gate: B2 apply: could not create label '${targetLabelName}' for re-stamp on ${issueId} — skipping`);
      return { status: "failed", code: "label-resolve-failed", detail: `could not resolve label '${targetLabelName}' for re-stamp`, from: currentStateName, to: toStateName };
    }
    // Remove any stale state:* labels and add the correct one.
    const cleanedLabelIds = issue.labels
      .filter((l) => !l.name.startsWith("state:"))
      .map((l) => l.id);
    cleanedLabelIds.push(newLabelId);
    const applied = await issueUpdateLabels(issue.internalId, cleanedLabelIds, authToken);
    if (applied) {
      log.info(`workflow-gate: B2 apply: ${issueId} re-stamped label '${targetLabelName}'`);
      return { status: "applied", code: "re-stamped", from: currentStateName, to: toStateName };
    }
    return { status: "failed", code: "atomic-mutation-failed", detail: `re-stamp of '${targetLabelName}' did not apply`, from: currentStateName, to: toStateName };
  }

  // ── AI-1475 Defect 1 + AI-1492 + AI-1497: Merged-PR release gate defense-in-depth (§5.6) ─
  // Block the forward label swap out of deployment if the branch/PR gate is not
  // satisfied. Defense-in-depth: checkWorkflowRules is the primary gate, but
  // applyStateTransition also blocks to prevent any bypass path.
  // v8: fires on both forward exits from deployment — `deploy` and
  // `handoff-host-deploy` (the merge precedes either).
  //
  // AI-1492: A merged PR satisfies the gate even without a branch (auto-deleted
  // after squash merge).
  //
  // AI-1497: Fail-open on null (after retry) and on complete absence of evidence
  // (no branch + no PR). Only block on partial evidence (branch exists but no PR).
  if (intent === 'deploy' || intent === 'handoff-host-deploy') {
    let branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    if (!branchStatus) {
      await new Promise((r) => setTimeout(r, 1000));
      branchStatus = await fetchBranchAndPRStatus(issueId, authToken);
    }
    const hasMergedPR = branchStatus?.hasMergedPR === true;
    const hasBranchAndPR = branchStatus?.hasBranch && branchStatus?.hasPR;
    const noEvidenceAtAll = branchStatus && !branchStatus.hasBranch && !branchStatus.hasPR;
    if (!hasMergedPR && !hasBranchAndPR && !noEvidenceAtAll) {
      // Block: either null after retry (branchStatus is null → noEvidenceAtAll is false)
      // or partial evidence (has branch but no PR).
      // But AI-1497: if null after retry, fail-open instead of blocking.
      if (!branchStatus) {
        log.warn(`workflow-gate: B2 apply: done gate could not verify status for ${issueId} after retry — failing open`);
      } else {
        const missing: string[] = [];
        if (!branchStatus.hasBranch) missing.push('branch not pushed to origin');
        if (!branchStatus.hasPR) missing.push('no pull request associated');
        log.warn(`workflow-gate: B2 apply: done gate blocked for ${issueId} — ${missing.join('; ')}`);
        return { status: "blocked", code: "release-gate", detail: missing.join('; '), from: currentStateName, to: toStateName }; // Block the transition
      }
    } else if (noEvidenceAtAll) {
      log.info(`workflow-gate: B2 apply: done gate for ${issueId} — no branch/PR evidence, treating as merged (AI-1497 fail-open)`);
    }
  }

  // ── Phase 5 / B-4: Parent-AC gate for review → done (F2b, §5.6) ─────
  // Before the atomic label swap, check if this is a review → done transition
  // on a ux-audit ticket. If so, the parent-AC gate must pass (§5.6): the
  // parent's own AC is verified, not the sum of children.
  // Fail-closed: if the AC gate cannot be evaluated (description fetch error),
  // block the transition to prevent premature done.
  const disposition = resolveDisposition(workflowId, currentStateName ?? "", intent);
  if (disposition === "done") {
    try {
      log.info(`workflow-gate: B-4 review: evaluating parent-AC gate for ${issueId} (review → done)`);
      const acResult = await dispositionToDone(issueId, authToken);
      if (!acResult.applied) {
        log.warn(`workflow-gate: B-4 review: → done blocked for ${issueId}: ${acResult.error ?? "unknown"}`);
        return { status: "blocked", code: "parent-ac-gate", detail: acResult.error ?? "unknown", from: currentStateName, to: toStateName }; // Block the transition — AC gate failed
      }
      // AC gate passed and dispositionToDone already applied the label swap + comment.
      // Skip the normal atomic swap below — dispositionToDone handled it.
      // AI-1534: terminal state, no further per-step delivery — drop any cached state.
      clearAppliedState(issue.identifier);
      log.info(`workflow-gate: B-4 review: ${issueId} review → done (parent AC satisfied)`);
      return { status: "applied", code: "disposition-done", from: currentStateName, to: "done" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-4 review: parent-AC gate failed for ${issueId}: ${msg} — blocking transition`);
      return { status: "blocked", code: "parent-ac-gate-error", detail: msg, from: currentStateName, to: toStateName };
    }
  }

  if (disposition === "spawning") {
    try {
      log.info(`workflow-gate: B-4 review: disposition → spawning for ${issueId} (follow-up gaps)`);
      const spawnResult = await dispositionToSpawning(issueId, authToken);
      if (!spawnResult.applied) {
        log.warn(`workflow-gate: B-4 review: → spawning failed for ${issueId}: ${spawnResult.error ?? "unknown"}`);
        // Fall through to normal transition — it'll go to spawning via the standard path
      } else {
        // dispositionToSpawning applied the label swap + comment.
        // AI-1534: this helper, not the atomic path below, applied the swap —
        // drop the now-stale cached state rather than leave a wrong override.
        clearAppliedState(issue.identifier);
        log.info(`workflow-gate: B-4 review: ${issueId} review → spawning (follow-up)`);
        return { status: "applied", code: "disposition-spawning", from: currentStateName, to: "spawning" };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-4 review: → spawning failed for ${issueId}: ${msg}`);
      // Fall through to normal transition
    }
  }

  // ── §5.7 item 1 / C-2: Sprint artifact gate at validating → done ────
  // For the sprint workflow, the approve transition from validating to done
  // requires that the artifact bound at intake is still present.
  // This is the §5.6 gate inherited from B-4, adapted for sprint: the
  // validating gate reads the bound artifact as the parent AC source.
  if (workflowId === "sprint" && currentStateName === "validating" && intent === "approve") {
    const artifact = getBoundArtifact(issueId);
    if (!artifact) {
      log.warn(`workflow-gate: C-2: sprint artifact gate: ${issueId} validating → done blocked — no bound artifact`);
      // Post a diagnostic comment
      const internalId = issue.internalId;
      const mutation = `
        mutation($issueId: ID!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }
      `;
      const commentBody =
        `[Artifact Gate] Cannot advance to **done** — no sprint-plan artifact is bound. ` +
        `The sprint workflow requires a sprint-plan document to be bound at intake before the validating gate can pass.`;
      try {
        await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authToken },
          body: JSON.stringify({ query: mutation, variables: { issueId: internalId, body: commentBody } }),
        });
      } catch (commentErr) {
        log.warn(`workflow-gate: C-2: failed to post diagnostic comment for ${issueId}: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`);
      }
      return { status: "blocked", code: "artifact-gate", detail: "no sprint-plan artifact bound at intake", from: currentStateName, to: toStateName }; // Block the transition
    }
    log.info(`workflow-gate: C-2: sprint artifact gate: ${issueId} artifact '${artifact.ref}' present — allowing validating → done`);
  }

  // ── Phase 6.5 / H-7 (AI-1482): Verbatim AC capture at accept ──────────
  // When the accept transition has capture_ac: true, extract the verbatim AC
  // from the issue description and store it as the immutable AC of record.
  // This closes the gap where Ai's paraphrase silently becomes the de-facto spec.
  if (matchedTransition?.capture_ac && intent === 'accept') {
    try {
      const { description, fetchFailed } = await fetchIssueDescription(issueId, authToken);
      if (fetchFailed) {
        log.warn(`workflow-gate: H-7: description fetch failed for ${issueId} — AC capture skipped, delivery message will note incomplete capture`);
        // AI-1776 AC2: fail-visible — post a warning comment so the steward knows
        // the AC of record was not captured and why. Signal, not gate: the
        // transition still proceeds below.
        await postAcCaptureWarningComment(issue.internalId, issueId, authToken,
          'description fetch failed — could not retrieve the issue description to extract acceptance criteria');
      } else {
        const verbatimAc = extractAcFromDescription(description);
        if (verbatimAc) {
          await captureAc(issueId, {
            verbatimAc,
            capturedAt: new Date().toISOString(),
            capturedBy: options?.bodyId ?? 'unknown',
            source: 'description',
          });
          log.info(`workflow-gate: H-7: captured verbatim AC for ${issueId} (${verbatimAc.length} chars)`);
        } else {
          log.warn(`workflow-gate: H-7: no AC section header found in description for ${issueId} — AC capture skipped (description has no '### Acceptance' or '### AC' section)`);
          // AI-1776 AC2: fail-visible — no AC section header found.
          await postAcCaptureWarningComment(issue.internalId, issueId, authToken,
            "no acceptance criteria header found in the ticket description — the AC of record was not captured. Add an '## Acceptance Criteria' or '### AC' section and use the recapture verb to create the record.");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: H-7: AC capture failed for ${issueId}: ${msg}`);
    }
  }

  // ── AI-1493: Pre-compute full transition tuple (atomic + fail-closed) ──
  // Before any mutation, resolve ALL facets: {label swap, delegate}.
  // If any facet cannot be resolved for deterministic transitions, fail CLOSED.

  // AI-2036: capture the implementer BEFORE Step 3 overwrites it with the
  // destination delegate. The observation's from_body is "whose work was
  // rejected", which is the record standing at the moment of rejection — not
  // whoever the ticket is being routed to (a reviewer may redirect with
  // --target, and Step 3's fallback records the reviewer's own id).
  const priorImplementerAtFeedback = matchedTransition?.feedback?.required
    ? await getImplementer(issueId).catch(() => null)
    : null;

  // Step 1: Resolve label IDs for the state swap.
  const newLabelId = await findOrCreateLabel(
    issue.teamId,
    `state:${toStateName}`,
    authToken,
  );
  if (!newLabelId) {
    log.error(
      `workflow-gate: B2 apply: FAIL-CLOSED — could not resolve label id for state:${toStateName}. Transition aborted.`,
    );
    return { status: "failed", code: "label-resolve-failed", detail: `could not resolve label id for state:${toStateName}`, from: currentStateName, to: toStateName };
  }

  // AI-1498 fix: compute the target label set robustly — strip ALL state:* labels
  // and add exactly the destination. The CLI may have already advanced (or partially
  // advanced) the state:* label inside its forwarded mutation, so we must not depend
  // on the source label still being present. This guarantees the ticket ends with a
  // single state:* label matching the destination, regardless of the CLI's pre-write.
  const newLabelIds = [
    ...issue.labels.filter((l) => !l.name.startsWith("state:")).map((l) => l.id),
    newLabelId,
  ];

  // Step 2: Resolve the next delegate.
  // AI-1493: Deterministic owner-routing for ALL transitions.
  const destStateNode = def.states.find((s) => s.id === toStateName);
  const destOwnerRole = destStateNode?.owner_role;
  const isTerminal = destStateNode?.kind === 'terminal' || !destOwnerRole;
  let resolvedDelegateId: string | null | undefined = undefined;

  // AI-1977: delegate override — skip resolution entirely when pre-computed by proxy.
  // The proxy resolves the delegate before forwarding so webhook #1 carries the
  // correct target. applyStateTransition still writes the state label + native state.
  if (options?.delegateOverride !== undefined) {
    resolvedDelegateId = options.delegateOverride;
    log.info(
      `workflow-gate: B2 apply: ${issueId} ${intent} — using delegateOverride=${resolvedDelegateId}, skipping resolution`,
    );
  }

  // Only resolve the delegate if not overridden by delegateOverride.
  // When delegateOverride is provided, the proxy already set delegateId in the
  // forwarded mutation — skip the full resolution path to avoid conflicting with
  // the pre-forward determination or overwriting a terminal null.
  if (options?.delegateOverride === undefined) {
    // Rebuild WS2 (2026-07-03): delegate routing is DEF-DRIVEN, not state-name-
    // driven. The matched transition's `assign.default: prior-implementer` marks
    // deterministic return-to-worker routing (dev-impl: → implementation; task:
    // → doing). Identical dev-impl behavior — its yaml carries the field on
    // exactly the transitions the old hardcode matched.
    const wantsPriorImplementer = matchedTransition?.assign?.default === 'prior-implementer';

    if (isTerminal) {
      resolvedDelegateId = null;
    } else {
      // (a) Explicit CLI target wins. Legality against the destination role was
      // already validated in checkWorkflowRules; this makes the wake brief's
      // "overridable with --target" true, and makes zero-body roles drivable.
      const explicitTarget = options?.cliTarget;
      if (explicitTarget) {
        const targetAgent = getAgent(explicitTarget);
        if (targetAgent?.linearUserId) {
          resolvedDelegateId = targetAgent.linearUserId;
          log.info(
            `workflow-gate: B2 apply: ${issueId} ${intent} — explicit target '${explicitTarget}' → delegate=${resolvedDelegateId}`,
          );
        } else {
          log.error(
            `workflow-gate: B2 apply: FAIL-CLOSED — CLI target '${explicitTarget}' cannot be resolved to a Linear user ID for ${issueId}. Register the agent in agents.json with a linearUserId. Transition aborted.`,
          );
          return { status: "failed", code: "target-unresolved", detail: `CLI target '${explicitTarget}' has no linearUserId`, from: currentStateName, to: toStateName };
        }
      }

      // (b) Deterministic prior-implementer routing (def-driven).
      if (resolvedDelegateId === undefined && wantsPriorImplementer) {
        const priorImplementer = await getImplementer(issueId);
        if (priorImplementer) {
          const agent = getAgent(priorImplementer);
          if (agent?.linearUserId) {
            resolvedDelegateId = agent.linearUserId;
            log.info(
              `workflow-gate: B2 apply: ${issueId} ${intent} → ${toStateName}, routing to prior implementer '${priorImplementer}'`,
            );
          } else {
            log.error(
              `workflow-gate: B2 apply: FAIL-CLOSED — prior implementer '${priorImplementer}' has no linearUserId. Cannot route ${intent} on ${issueId}.`,
            );
            return { status: "failed", code: "delegate-unresolved", detail: `prior implementer '${priorImplementer}' has no linearUserId`, from: currentStateName, to: toStateName };
          }
        } else {
          log.warn(
            `workflow-gate: B2 apply: no prior implementer recorded for ${issueId} on ${intent} — falling back to role resolution`,
          );
        }
      }

      // Role-based resolution (singleton auto-assign, multi-body skip).
      if (resolvedDelegateId === undefined) {
        try {
          const roleBodies = await resolveBodiesForRole(destOwnerRole!);
          if (roleBodies.length === 1) {
            const agent = getAgent(roleBodies[0]);
            if (agent?.linearUserId) {
              resolvedDelegateId = agent.linearUserId;
            } else {
              log.warn(
                `workflow-gate: B2 apply: singleton body '${roleBodies[0]}' for role '${destOwnerRole}' has no linearUserId — skipping auto-delegate`,
              );
            }
          } else if (roleBodies.length > 1) {
            log.error(
              `workflow-gate: B2 apply: FAIL-CLOSED — multi-body role '${destOwnerRole}' (${roleBodies.join(", ")}) on '${intent}' for ${issueId} requires a CLI --target${wantsPriorImplementer ? " (no prior implementer recorded)" : ""} but none was supplied. Transition aborted.`,
            );
            return { status: "failed", code: "delegate-unresolved", detail: `multi-body role '${destOwnerRole}' requires a --target`, from: currentStateName, to: toStateName };
          } else {
            if (intent === 'approve' || intent === 'reject') {
              log.error(
                `workflow-gate: B2 apply: FAIL-CLOSED — no bodies found for role '${destOwnerRole}' on '${intent}'. Transition aborted per AI-1493.`,
              );
              return { status: "failed", code: "delegate-unresolved", detail: `no bodies found for role '${destOwnerRole}'`, from: currentStateName, to: toStateName };
            }
            log.warn(
              `workflow-gate: B2 apply: no bodies found for role '${destOwnerRole}' on '${intent}' — skipping auto-delegate`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            `workflow-gate: B2 apply: FAIL-CLOSED — role resolution failed for '${destOwnerRole}': ${msg}. Transition aborted.`,
          );
          return { status: "failed", code: "delegate-unresolved", detail: `role resolution failed for '${destOwnerRole}': ${msg}`, from: currentStateName, to: toStateName };
        }
      }
    }
  }

  // Step 3: Record implementer BEFORE the mutation. Def-driven (rebuild WS2):
  // the "worker" states are those any prior-implementer-default transition
  // returns to (dev-impl: implementation; task: doing).
  const implementerEntryStates = new Set<string>();
  for (const st of def.states) {
    for (const t of st.transitions ?? []) {
      if (t.assign?.default === 'prior-implementer') implementerEntryStates.add(t.to);
    }
  }
  if (implementerEntryStates.has(toStateName) && resolvedDelegateId) {
    const agents = getAgents();
    const implementerAgent = agents.find(a => a.linearUserId === resolvedDelegateId);
    if (implementerAgent) {
      await recordImplementer(issueId, implementerAgent.name, workflowId);
      log.info(
        `workflow-gate: B2 apply: recorded implementer '${implementerAgent.name}' for ${issueId}`,
      );
    } else if (options?.bodyId) {
      await recordImplementer(issueId, options.bodyId, workflowId);
      log.info(
        `workflow-gate: B2 apply: recorded implementer from bodyId '${options.bodyId}' for ${issueId}`,
      );
    }
  }

  // Step 4 (AI-1498): Resolve native stateId from YAML native_state field.
  // The proxy is now the SOLE writer of all three facets: label, delegate, AND native state.
  // Fail-closed: if the destination state has a native_state field but we can't resolve
  // the Linear stateId, abort the transition (this is the structural guarantee that
  // prevents desync).
  let resolvedNativeStateId: string | null | undefined = undefined;
  const destNativeState = destStateNode?.native_state;
  if (destNativeState) {
    const stateId = await resolveNativeStateId(issue.teamId, destNativeState, authToken);
    if (!stateId) {
      log.error(
        `workflow-gate: B2 apply: FAIL-CLOSED — could not resolve native stateId for '${destNativeState}' on team ${issue.teamId}. Transition aborted.`,
      );
      return { status: "failed", code: "native-state-unresolved", detail: `could not resolve native stateId for '${destNativeState}'`, from: currentStateName, to: toStateName };
    }
    resolvedNativeStateId = stateId;
    log.info(
      `workflow-gate: B2 apply: resolved native_state '${destNativeState}' → stateId=${stateId} for ${issueId}`,
    );
  } else if (destStateNode) {
    // State exists but has no native_state — this should have been caught at load-time
    // validation (AI-1498 hard-fail). If we somehow reach here, fail-closed.
    log.error(
      `workflow-gate: B2 apply: FAIL-CLOSED — destination state '${toStateName}' has no native_state field. Transition aborted.`,
    );
    return { status: "failed", code: "native-state-missing", detail: `destination state '${toStateName}' has no native_state field`, from: currentStateName, to: toStateName };
  }

  // Step 5: Apply the FULL transition atomically (labels + delegate + native state in one
  // mutation), verified read-after-write with bounded internal retry (AI-1762) — Linear can
  // report success while silently dropping facets (live: app-user delegateId, AI-1759).
  const writeOutcome = await issueUpdateAtomicVerified(
    issue.internalId,
    newLabelIds,
    authToken,
    resolvedDelegateId,
    resolvedNativeStateId,
    toStateName,
  );
  const applied = writeOutcome.ok;

  if (applied) {
    // AI-1534: record the authoritative destination state so the outbound
    // per-step delivery prefers it over a lag-prone live label read. Keyed by
    // the human identifier to match build-message's lookup key.
    recordAppliedState(issue.identifier, toStateName);

    // AI-1799: mirror — record the transition (or mark terminal) in the enrolled-tickets store.
    const mirror = options?.enrolledTicketsStore;
    if (mirror) {
      if (isTerminal) {
        mirror.markTerminal(issue.identifier ?? issueId, intent);
      } else {
        // Resolve the agent name from the delegate linear user id for the mirror.
        const allAgents = getAgents();
        const delegateAgent = allAgents.find((a) => a.linearUserId === resolvedDelegateId);
        mirror.recordTransition({
          ticketId: issue.identifier ?? issueId,
          toState: toStateName,
          delegate: delegateAgent?.name ?? null,
          eventKind: intent,
        });
      }
    }

    // AI-1666: cache per-state no-activity timeout for the newly-entered state.
    const noActivityTimeoutSecs = destStateNode?.noActivityTimeout;
    const cacheKey = issue.identifier?.toUpperCase();
    if (cacheKey) {
      if (typeof noActivityTimeoutSecs === "number" && noActivityTimeoutSecs > 0) {
        _noActivityTimeoutCache.set(cacheKey, noActivityTimeoutSecs * 1000);
      } else {
        _noActivityTimeoutCache.delete(cacheKey);
      }
    }

    log.info(
      `workflow-gate: B2 apply: ${issueId} state:${currentStateName} → state:${toStateName}` +
      (resolvedDelegateId != null ? ` delegate=${resolvedDelegateId}` : resolvedDelegateId === null ? ` delegate=cleared` : ``) +
      (resolvedNativeStateId ? ` native=${destNativeState}(${resolvedNativeStateId})` : ``),
    );
  } else {
    log.error(
      `workflow-gate: B2 apply: transition write FAILED for ${issueId} after ${writeOutcome.attempts} attempt(s) (${writeOutcome.failureKind})` +
      (writeOutcome.divergent.length ? ` — ${writeOutcome.divergent.join("; ")}` : ""),
    );
    // AI-1762 AC2: fail LOUDLY — operational event + alert, never a silent partial apply.
    emitTransitionWriteFailure({
      identifier: issue.identifier ?? issueId,
      from: currentStateName,
      to: toStateName,
      intent,
      agent: options?.bodyId ?? null,
      outcome: writeOutcome,
      operationalEventStore: options?.operationalEventStore,
    });
    if (writeOutcome.failureKind === "verification") {
      return { status: "failed", code: "transition-write-unverified", detail: `transition write did not persist after ${writeOutcome.attempts} attempt(s) — ${writeOutcome.divergent.join("; ")}`, from: currentStateName, to: toStateName };
    }
    return { status: "failed", code: "atomic-mutation-failed", detail: `atomic issueUpdate (label + delegate + native state) did not apply after ${writeOutcome.attempts} attempt(s)`, from: currentStateName, to: toStateName };
  }

  // ── §5.7 item 1 / C-2: Artifact-binding recording ────────────────────
  if (matchedTransition?.requires_artifact && options?.artifactRef) {
    try {
      bindArtifact(issueId, {
        ref: options.artifactRef,
        boundAt: new Date().toISOString(),
        boundBy: options.bodyId ?? "unknown",
      });
      log.info(
        `workflow-gate: C-2: artifact bound for ${issueId}: '${options.artifactRef}'`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: C-2: artifact bind failed for ${issueId}: ${msg}`);
    }
  }

  // Clean up artifact binding and implementer record on escape/demote
  if (toStateName === "escape" || toStateName === "__ad_hoc__") {
    removeArtifact(issueId);
    await removeAcRecord(issueId);
  }
  // Clean up implementer record on terminal states
  if (isTerminal) {
    await removeImplementer(issueId);
  }

  // ── Phase 5 / B-2 + AI-1992: Fan-out edge (spawning 1→N) ────────────
  // After a successful state transition out of a state that declares a `fanout`
  // block, mint N children under the configured child_workflow. The spec was
  // already validated pre-transition (AC5) and the findings stashed in
  // `pendingFanout`, so this never re-guesses the spec.
  // Fail-open: fan-out errors are logged and never block the transition.
  if (applied && pendingFanout) {
    try {
      log.info(`workflow-gate: AI-1992 fan-out: triggering fan-out for ${issueId} (${currentStateName} → ${toStateName}, child=${pendingFanout.config.child_workflow})`);
      const fanoutResult = await executeFanout(issueId, authToken, pendingFanout.config, {
        findingsOverride: pendingFanout.findings,
      });
      if (fanoutResult.created > 0) {
        log.info(
          `workflow-gate: B-2 fan-out: ${fanoutResult.created} child(ren) created for ${issueId}: ${fanoutResult.childIdentifiers.join(", ")}`,
        );
      } else {
        log.warn(`workflow-gate: B-2 fan-out: no children created for ${issueId} — ${fanoutResult.errors.map((e) => e.message).join(";")}`);
      }
      // Post a summary comment on the parent ticket with the fan-out result.
      if (fanoutResult.created > 0) {
        await postFanoutSummaryComment(issue.internalId, fanoutResult, authToken);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-2 fan-out: fan-out failed for ${issueId}: ${msg}`);
    }
  }

  // ── AI-1730 + AI-1992: Zero-child barrier auto-advance on barrier entry ──
  // After the fan-out block (which may create 0..N children), check if the
  // barrier is already satisfied. This is a no-op when children are in-progress
  // — it only fires when all children are terminal or none exist. Barrier-ness
  // is config-driven (any state declaring `barrier: true`), not just "managing".
  if (applied && destStateNode?.barrier === true) {
    try {
      const barrierResult = await onManagingEntry(issueId, authToken);
      if (barrierResult) {
        if (barrierResult.transitioned) {
          log.info(
            `workflow-gate: AI-1730: zero-child/all-terminal barrier auto-advanced ` +
            `${issueId} managing → (next state) (${barrierResult.totalChildren} children)`,
          );
          clearAppliedState(issue.identifier);
          return { status: "applied", code: "transition-applied", from: currentStateName, to: toStateName };
        }
        log.info(
          `workflow-gate: AI-1730: onManagingEntry returned no transition for ${issueId} — children still active`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: AI-1730: onManagingEntry failed for ${issueId}: ${msg}`);
      // Fail-open: don't block the flow
    }
  }

  // ── Phase 4 / P4-1: Record feedback observation ──────────────────────
  // Every feedback-required transition produces exactly one observation — or a
  // counted, logged skip. AI-2036: the guard used to also require
  // `options.feedback`, which the proxy only built when the request carried
  // X-Openclaw-Feedback-Category. No client has ever sent that header, so the
  // block never ran and, having no `else`, said nothing about it. The write no
  // longer depends on any header: the category degrades to `unclassified` and
  // the from-body falls back to the implementer store.
  //
  // Fail-open: recordObservation never throws — an observation must not be able
  // to block the transition it describes. Gated on `applied` like the barrier
  // blocks below: today every write failure returns early, but an observation
  // describes a rejection that actually happened, so it must never outlive the
  // transition it records.
  if (applied && matchedTransition?.feedback?.required) {
    await recordObservation({
      store: options?.observationStore,
      events: options?.operationalEventStore,
      // The human identifier ("AI-2036"), not the internal UUID the proxy
      // extracts from the mutation's `id` variable. Clustering groups by ticket
      // and the admin API filters on it; a UUID here is a populated column that
      // nothing can join on. Mirrors the mutation-audit path's `?? issueId`.
      ticket: issue.identifier ?? issueId,
      workflow: workflowId,
      step: currentStateName ?? "(none)",
      reviewerBody: options?.bodyId ?? "unknown",
      headerReasonCode: options?.feedback?.reasonCode,
      headerFromBody: options?.feedback?.fromBody,
      freeText: options?.feedback?.freeText ?? null,
      wakeId: options?.feedback?.wakeId ?? null,
      resolveImplementer: async () => priorImplementerAtFeedback,
    });
  }

  // ── Phase 5 / B-3: Barrier (N→1) — event-driven parent auto-advance ─
  // After a successful state transition to a terminal state (done, escape),
  // fire the barrier check to see if the parent should auto-advance from
  // managing → review. The barrier module handles the full evaluation:
  // fetch parent, check all children, transition if ready.
  // Fail-open: barrier errors are logged and never block the transition.
  if (applied && isTerminalState(toStateName)) {
    try {
      log.info(`workflow-gate: B-3 barrier: child ${issueId} reached terminal state '${toStateName}' — checking parent barrier`);
      const barrierResult = await onChildTerminal(issueId, authToken);
      if (barrierResult?.transitioned) {
        log.info(
          `workflow-gate: B-3 barrier: parent auto-advanced managing → review via ${issueId}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`workflow-gate: B-3 barrier check failed for ${issueId}: ${msg}`);
    }
  }

  return { status: "applied", code: "transition-applied", from: currentStateName, to: toStateName };
}

/**
 * Post a summary comment on the parent ticket after a fan-out, listing
 * the created child issues.
 */
async function postFanoutSummaryComment(
  issueInternalId: string,
  result: import("./fanout.js").FanoutResult,
  authToken: string,
): Promise<void> {
  const childLinks = result.childIdentifiers.map((id) => `- ${id}`).join("\n");
  const body =
    `[Fan-out] Spawned ${result.created} child issue(s):\n${childLinks}` +
    (result.errors.length > 0
      ? `\n\n⚠️ ${result.errors.length} error(s): ${result.errors.map((e) => e.message).join("; ")}`
      : "");

  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
    });
    log.info(`workflow-gate: B-2 fan-out: summary comment posted on ${issueInternalId}`);
  } catch (err) {
    log.warn(`workflow-gate: B-2 fan-out: failed to post summary comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * AI-1493: Atomic issue update — sets labels AND delegate in a single mutation.
 * This replaces the separate issueUpdateLabels + issueUpdateDelegate calls
 * so the transition is all-or-nothing: either the full tuple lands or nothing does.
 *
 * @param delegateId - Linear user ID for the new delegate, or null to skip delegate update.
 */
async function issueUpdateAtomic(
  internalId: string,
  labelIds: string[],
  authToken: string,
  delegateId?: string | null,
  nativeStateId?: string | null,
): Promise<boolean> {
  // Build the mutation input: include delegateId when explicitly set (string or null to clear).
  // undefined means "don't touch delegate". null means "clear delegate".
  // AI-1498: include nativeStateId when explicitly set — the proxy writes ALL three facets
  // (label, delegate, native state) in a single mutation.
  const hasDelegate = delegateId !== undefined;
  const hasStateId = nativeStateId !== undefined;

  const inputParts: string[] = ["labelIds: $labelIds"];
  if (hasDelegate) inputParts.push("delegateId: $delegateId");
  if (hasStateId) inputParts.push("stateId: $stateId");

  const mutation = `
    mutation ApplyAtomicTransition($issueId: String!, $labelIds: [String!]!${hasDelegate ? ", $delegateId: String" : ""}${hasStateId ? ", $stateId: String" : ""}) {
      issueUpdate(id: $issueId, input: { ${inputParts.join(", ")} }) {
        success
      }
    }
  `;
  const variables: Record<string, unknown> = { issueId: internalId, labelIds };
  if (hasDelegate) variables.delegateId = delegateId;
  if (hasStateId) variables.stateId = nativeStateId;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`workflow-gate: atomic issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: atomic issueUpdate failed for ${internalId}: ${msg}`);
    return false;
  }
}

/**
 * AI-1762: bounded retry + read-after-write verification policy for governed
 * transition writes. Linear has been observed returning HTTP 200 / success:true
 * while silently dropping facets of the update (live: app-user delegateId on
 * AI-1759), so trusting the mutation's own success flag is not enough.
 */
export interface TransitionWritePolicy {
  maxAttempts: number;
  retryDelayMs: number;
}
const DEFAULT_TRANSITION_WRITE_POLICY: TransitionWritePolicy = { maxAttempts: 3, retryDelayMs: 250 };
let transitionWritePolicy: TransitionWritePolicy = { ...DEFAULT_TRANSITION_WRITE_POLICY };

/** Test hook: override (or reset, with no args) the transition write retry policy. */
export function _setTransitionWritePolicyForTests(policy?: Partial<TransitionWritePolicy>): void {
  transitionWritePolicy = { ...DEFAULT_TRANSITION_WRITE_POLICY, ...(policy ?? {}) };
}

/**
 * AI-1762: read-after-write check for a transition write. Fetches the issue and
 * compares the facets we just wrote:
 *   - state:* label — by NAME (label ids differ per team; the name is the contract)
 *   - delegate — by user id, only when the write set one (null = expect cleared)
 *   - native workflow state — by state id, only when the write set one
 * Returns the list of divergent facets (empty = fully persisted), or null when
 * the issue could not be read back (unverifiable — caller decides posture).
 */
async function verifyTransitionWritePersisted(
  internalId: string,
  expected: { stateName: string; delegateId?: string | null; nativeStateId?: string | null },
  authToken: string,
): Promise<string[] | null> {
  const query = `query VerifyTransitionWrite($id: String!) { issue(id: $id) { labels { nodes { name } } delegate { id } state { id } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: internalId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          labels?: { nodes: Array<{ name: string }> };
          delegate?: { id: string } | null;
          state?: { id: string } | null;
        };
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;

    const divergent: string[] = [];
    const labelNames = (issue.labels?.nodes ?? []).map((n) => n.name);
    if (!labelNames.includes(`state:${expected.stateName}`)) {
      const got = labelNames.find((n) => n.startsWith("state:")) ?? "(none)";
      divergent.push(`state-label expected 'state:${expected.stateName}' got '${got}'`);
    }
    if (expected.delegateId !== undefined) {
      const got = issue.delegate?.id ?? null;
      if (got !== expected.delegateId) {
        divergent.push(`delegate expected '${expected.delegateId ?? "null"}' got '${got ?? "null"}'`);
      }
    }
    if (expected.nativeStateId !== undefined && expected.nativeStateId !== null) {
      const got = issue.state?.id ?? null;
      if (got !== expected.nativeStateId) {
        divergent.push(`native-state expected '${expected.nativeStateId}' got '${got ?? "null"}'`);
      }
    }
    return divergent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: AI-1762: transition write verification read failed for ${internalId}: ${msg}`);
    return null;
  }
}

/** Outcome of a verified transition write (AI-1762). */
interface VerifiedWriteOutcome {
  ok: boolean;
  attempts: number;
  /** What the final failure was: the mutation itself, or the read-back verification. */
  failureKind: "none" | "mutation" | "verification";
  /** Divergent facets from the last verification (verification failures only). */
  divergent: string[];
  /** True when the write was accepted without a successful read-back (fail-open). */
  unverified: boolean;
}

/**
 * AI-1762: issueUpdateAtomic wrapped in read-after-write verification and a
 * bounded internal retry. Each attempt re-issues the FULL bundled mutation
 * (labels + delegate + native state — the shape empirically observed to
 * persist), then reads the issue back and confirms every written facet landed.
 *
 * Fail-open only on an unreadable verification (network error on the read-back):
 * the mutation reported success and we cannot prove otherwise — rejecting it
 * would fail transitions that almost certainly applied (AI-1775 lesson).
 * A readable divergence always retries, and exhausted retries always fail loudly.
 */
async function issueUpdateAtomicVerified(
  internalId: string,
  labelIds: string[],
  authToken: string,
  delegateId: string | null | undefined,
  nativeStateId: string | null | undefined,
  expectedStateName: string,
): Promise<VerifiedWriteOutcome> {
  const { maxAttempts, retryDelayMs } = transitionWritePolicy;
  let failureKind: "mutation" | "verification" = "mutation";
  let divergent: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt - 1)));
    }
    const applied = await issueUpdateAtomic(internalId, labelIds, authToken, delegateId, nativeStateId);
    if (!applied) {
      failureKind = "mutation";
      divergent = [];
      log.warn(`workflow-gate: AI-1762: atomic mutation attempt ${attempt}/${maxAttempts} failed for ${internalId}${attempt < maxAttempts ? " — retrying" : ""}`);
      continue;
    }
    const verification = await verifyTransitionWritePersisted(
      internalId,
      { stateName: expectedStateName, delegateId, nativeStateId },
      authToken,
    );
    if (verification === null) {
      log.warn(`workflow-gate: AI-1762: write for ${internalId} reported success but could not be read back — accepting unverified (attempt ${attempt})`);
      return { ok: true, attempts: attempt, failureKind: "none", divergent: [], unverified: true };
    }
    if (verification.length === 0) {
      return { ok: true, attempts: attempt, failureKind: "none", divergent: [], unverified: false };
    }
    failureKind = "verification";
    divergent = verification;
    log.warn(`workflow-gate: AI-1762: write attempt ${attempt}/${maxAttempts} for ${internalId} reported success but did NOT fully persist — ${verification.join("; ")}${attempt < maxAttempts ? " — retrying" : ""}`);
  }

  return { ok: false, attempts: maxAttempts, failureKind, divergent, unverified: false };
}

/**
 * AI-1762 AC2: a transition that cannot fully apply after retries must fail
 * LOUDLY — operational event + alert-bus warning — never a silent partial apply.
 * Both sinks are best-effort: emitting must never mask the transition failure.
 */
function emitTransitionWriteFailure(args: {
  identifier: string;
  from: string | null | undefined;
  to: string;
  intent: string;
  agent: string | null;
  outcome: VerifiedWriteOutcome;
  operationalEventStore?: OperationalEventStore;
}): void {
  const { identifier, from, to, intent, agent, outcome } = args;
  const summary =
    outcome.failureKind === "verification"
      ? `facets did not persist: ${outcome.divergent.join("; ")}`
      : "atomic issueUpdate mutation failed";
  const detail = {
    intent,
    from: from ?? null,
    to,
    attempts: outcome.attempts,
    failureKind: outcome.failureKind,
    divergent: outcome.divergent,
  };
  try {
    args.operationalEventStore?.append({
      outcome: "transition-write-failed",
      type: "workflow-transition",
      agent,
      key: identifier,
      workflowState: to,
      plane: "connector",
      errorSummary: summary,
      detail,
    });
  } catch (err) {
    log.warn(`workflow-gate: AI-1762: failed to append transition-write-failed event for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
  }
  notify({
    severity: "warning",
    source: "workflow-gate",
    title: `transition write failed after ${outcome.attempts} attempt(s): ${identifier} ${from ?? "?"} → ${to} — ${summary}`,
    agent,
    ticket: identifier,
    detail,
    dedupKey: `transition-write-failed|${identifier}`,
  });
}

/**
 * Legacy label-only update, kept for non-atomic paths (ad_hoc demote, re-stamp).
 */
async function issueUpdateLabels(
  internalId: string,
  labelIds: string[],
  authToken: string,
): Promise<boolean> {
  return issueUpdateAtomic(internalId, labelIds, authToken);
}

/**
/**
 * Update only the delegate (for cases where the atomic label+delegate path
 * is not needed). Delegates to issueUpdateAtomic with empty label behavior.
 * Used by the auto-delegate assignment logic (AI-1463) after a state transition
 * to ensure the new state's owner body becomes the delegate.
 * Fail-open: returns false on any error, never throws.
 */
async function issueUpdateDelegateOnly(
  internalId: string,
  delegateLinearUserId: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalId, delegateId: delegateLinearUserId } }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`workflow-gate: delegate-only issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: delegate-only issueUpdate failed for ${internalId}: ${msg}`);
    return false;
  }
}

/**
 * AI-1584: Enrollment gap repair.
 *
 * Detects and heals the dead-on-arrival condition where a ticket carries a `wf:*`
 * label but no `state:*` label — a gap that occurs when tickets are created via
 * bulk scripts or the raw Linear API and the entry-state stamp is never applied.
 *
 * This function is idempotent: it is a no-op when the ticket already has a
 * `state:*` label or when no `wf:*` label is present (ad-hoc ticket).
 *
 * Called from the webhook inbound path on every Issue event so gaps are healed
 * within one reconciliation cycle (i.e. the next webhook fire after creation).
 *
 * Fail-open: any API or registry failure logs a warning and returns
 * `{ enrolled: false }` — the inbound path is never blocked by enrollment.
 */
export interface EnrollHealInfo {
  /** Display identifier or UUID the caller passed in. */
  issueId: string;
  /** Linear internal issue UUID the label write was applied to. */
  internalId: string;
  /** Resolved workflow id (e.g. "dev-impl"). */
  workflowId: string;
  /** Entry state stamped (e.g. "intake"). */
  entryState: string;
}

export async function enrollIfMissing(
  issueId: string,
  authToken: string,
  onHeal?: (info: EnrollHealInfo) => void,
): Promise<{ enrolled: boolean; entryState?: string }> {
  const issue = await fetchIssueWithLabels(issueId, authToken);
  if (!issue) {
    log.warn(`workflow-gate: enrollIfMissing: failed to fetch labels for ${issueId} — skipping`);
    return { enrolled: false };
  }

  const labelNames = issue.labels.map((l) => l.name);
  const workflowId = getWorkflowId(labelNames);
  if (!workflowId) return { enrolled: false }; // ad-hoc ticket

  const currentState = getCurrentState(labelNames);
  if (currentState) return { enrolled: false }; // already enrolled

  // Gap: wf:* present, state:* missing.
  let def: WorkflowDef | undefined;
  try {
    const registry = await loadWorkflowRegistry();
    def = registry.get(workflowId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`workflow-gate: enrollIfMissing: registry load failed for ${issueId}: ${msg} — skipping`);
    return { enrolled: false };
  }

  if (!def?.entry_state) {
    log.warn(`workflow-gate: enrollIfMissing: no entry_state in def for wf:${workflowId} on ${issueId} — skipping`);
    return { enrolled: false };
  }

  const entryLabelName = `state:${def.entry_state}`;
  const entryLabelId = await findOrCreateLabel(issue.teamId, entryLabelName, authToken);
  if (!entryLabelId) {
    log.warn(`workflow-gate: enrollIfMissing: could not resolve label '${entryLabelName}' for ${issueId} — skipping`);
    return { enrolled: false };
  }

  const existingIds = issue.labels.map((l) => l.id);
  const newLabelIds = [...existingIds, entryLabelId];
  const success = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
  if (!success) {
    log.warn(`workflow-gate: enrollIfMissing: label update failed for ${issueId} — skipping`);
    return { enrolled: false };
  }

  log.info(`workflow-gate: enrollIfMissing: stamped '${entryLabelName}' on ${issueId} (wf:${workflowId} had no state:*)`);
  // AI-1585 / AC2: emit a structured audit signal so a reconciliation heal is
  // observable in the operational event store, not only in logs.
  try {
    onHeal?.({ issueId, internalId: issue.internalId, workflowId, entryState: def.entry_state });
  } catch (err) {
    log.warn(`workflow-gate: enrollIfMissing: onHeal audit hook threw for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { enrolled: true, entryState: def.entry_state };
}

// ── AI-1546 / G-6: Steward/human-only atomic set-state ─────────────────────

export interface SetStateAtomicResult {
  ok: boolean;
  ticketId: string;
  from: string | null;
  to: string;
  error?: string;
  /** Body name that received the re-dispatch after the state write, if any. */
  redispatched?: string;
  /** Linear internal UUID of the issue (set on success). AI-1954 attribution. */
  internalId?: string;
}

export interface SetStateAtomicOptions {
  /**
   * If provided, called after a successful write to send a wake-up signal to
   * the new state's owner role (AI-1607). Fail-open: errors are logged and
   * never cause the set-state to return ok:false.
   */
  sendWakeUp?: (agentId: string, ticketId: string) => Promise<void>;
  /** AI-1762: operational-event sink for transition-write-failed events. */
  operationalEventStore?: OperationalEventStore;
  /**
   * AI-1954 AC3: allow forcing terminal set-state from an active (non-terminal)
   * workflow state. Without this flag such transitions are refused with an
   * explanatory error.
   */
  force?: boolean;
}

/**
 * Atomically re-establish the full workflow triple (state:* label, native Linear
 * state, delegate) on any governed ticket, including tickets in a terminal state.
 * No legal-move validation — the caller is the steward and has already been
 * authenticated at the HTTP layer.
 *
 * AC1: atomically sets label + native + delegate; consistency asserted after.
 * AC3: works from any source state including terminal states.
 * AC4: issueUpdateAtomic is a single issueUpdate mutation; Linear applies all
 *      fields atomically or none — no partial state possible on failure.
 */
export async function setStateAtomic(
  ticketIdentifier: string,
  targetState: string,
  delegate: string | null | undefined,
  authToken: string,
  options?: SetStateAtomicOptions,
): Promise<SetStateAtomicResult> {
  const fail = (error: string, from: string | null = null): SetStateAtomicResult =>
    ({ ok: false, ticketId: ticketIdentifier, from, to: targetState, error });

  // Step 1: Fetch current issue.
  const issue = await fetchIssueWithLabels(ticketIdentifier, authToken);
  if (!issue) return fail(`could not fetch issue '${ticketIdentifier}'`);

  const fromState = getCurrentState(issue.labels.map((l) => l.name)) ?? null;

  // Step 2: Locate workflow def.
  const workflowId = getWorkflowId(issue.labels.map((l) => l.name));
  let def: WorkflowDef | undefined;
  if (workflowId) {
    try {
      const registry = await loadWorkflowRegistry();
      def = registry.get(workflowId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`could not load workflow registry: ${msg}`, fromState);
    }
  }

  // Step 3: Validate target state exists in the workflow def.
  if (def) {
    const stateNode = def.states.find((s) => s.id === targetState);
    if (!stateNode) {
      const valid = def.states.map((s) => s.id).join(", ");
      return fail(`unknown target state '${targetState}' in workflow '${workflowId}'; valid: ${valid}`, fromState);
    }
  }

  // AI-1954 AC3: terminal set-state from a non-terminal (active) workflow state
  // requires an explicit force:true flag to prevent accidental closure.
  if (def && !options?.force) {
    const targetStateNode = def.states.find((s) => s.id === targetState);
    const fromStateNode = fromState ? def.states.find((s) => s.id === fromState) : null;
    if (
      targetStateNode?.kind === "terminal" &&
      fromStateNode &&
      fromStateNode.kind !== "terminal"
    ) {
      return fail(
        `set-state to terminal state '${targetState}' from active workflow state '${fromState}' requires force:true`,
        fromState,
      );
    }
  }

  // Step 4: Build new label set — strip old state:*, add new state:<target>.
  const targetLabelName = `state:${targetState}`;
  const newTargetLabelId = await findOrCreateLabel(issue.teamId, targetLabelName, authToken);
  if (!newTargetLabelId) return fail(`could not resolve label '${targetLabelName}'`, fromState);

  const newLabelIds = [
    ...issue.labels.filter((l) => !l.name.startsWith("state:")).map((l) => l.id),
    newTargetLabelId,
  ];

  // Step 5: Resolve native Linear state id.
  let resolvedNativeStateId: string | null | undefined = undefined;
  if (def) {
    const destNativeState = def.states.find((s) => s.id === targetState)?.native_state;
    if (destNativeState) {
      const nativeId = await resolveNativeStateId(issue.teamId, destNativeState, authToken);
      if (!nativeId) return fail(`could not resolve native stateId for '${destNativeState}' on team ${issue.teamId}`, fromState);
      resolvedNativeStateId = nativeId;
    }
  }

  // Step 6: Resolve delegate Linear user id.
  let resolvedDelegateId: string | null | undefined = undefined;
  if (delegate === null) {
    resolvedDelegateId = null;
  } else if (typeof delegate === "string") {
    const agent = getAgent(delegate);
    if (!agent?.linearUserId) {
      return fail(`delegate agent '${delegate}' not found or has no linearUserId`, fromState);
    }
    resolvedDelegateId = agent.linearUserId;
  }

  // Step 7+8: Atomic write (AC4 — single mutation), verified read-after-write with
  // bounded internal retry (AI-1762). Verification covers all three facets — state
  // label, delegate, native state — superseding the label-only consistency check.
  const writeOutcome = await issueUpdateAtomicVerified(
    issue.internalId,
    newLabelIds,
    authToken,
    resolvedDelegateId,
    resolvedNativeStateId,
    targetState,
  );
  if (!writeOutcome.ok) {
    emitTransitionWriteFailure({
      identifier: ticketIdentifier,
      from: fromState,
      to: targetState,
      intent: "set-state",
      agent: null,
      outcome: writeOutcome,
      operationalEventStore: options?.operationalEventStore,
    });
    if (writeOutcome.failureKind === "verification") {
      log.warn(`workflow-gate: set-state: consistency check FAILED for ${ticketIdentifier} after ${writeOutcome.attempts} attempt(s) — ${writeOutcome.divergent.join("; ")}`);
      return fail(`consistency check failed: write did not persist after ${writeOutcome.attempts} attempt(s) — ${writeOutcome.divergent.join("; ")}`, fromState);
    }
    return fail("atomic issueUpdate mutation failed", fromState);
  }

  log.info(
    `workflow-gate: set-state (G-6): ${ticketIdentifier} ${fromState ?? "(unknown)"} → ${targetState}` +
    (resolvedDelegateId != null ? ` delegate=${resolvedDelegateId}` : resolvedDelegateId === null ? ` delegate=cleared` : ``) +
    (resolvedNativeStateId ? ` native=${resolvedNativeStateId}` : ``),
  );

  // Step 9: Re-dispatch to the new state's owner (AI-1607).
  // Fail-open: errors are logged but never block the set-state result.
  let redispatched: string | undefined;
  if (def && options?.sendWakeUp) {
    const destNode = def.states.find((s) => s.id === targetState);
    const ownerRole = destNode?.owner_role;
    const isTerminal = destNode?.kind === "terminal" || !ownerRole;
    if (!isTerminal && ownerRole) {
      try {
        const roleBodies = await resolveBodiesForRole(ownerRole);
        if (roleBodies.length === 1) {
          await options.sendWakeUp(roleBodies[0], ticketIdentifier);
          redispatched = roleBodies[0];
          log.info(
            `workflow-gate: set-state: re-dispatched ${ticketIdentifier} to '${roleBodies[0]}' (role '${ownerRole}') after advancing to '${targetState}'`,
          );
        } else if (roleBodies.length > 1) {
          log.warn(
            `workflow-gate: set-state: skipping re-dispatch for ${ticketIdentifier} — role '${ownerRole}' has multiple bodies (${roleBodies.join(", ")}); delegate manually`,
          );
        } else {
          log.warn(
            `workflow-gate: set-state: skipping re-dispatch for ${ticketIdentifier} — role '${ownerRole}' has no bodies`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`workflow-gate: set-state: re-dispatch failed for ${ticketIdentifier}: ${msg} — continuing`);
      }
    }
  }

  return { ok: true, ticketId: ticketIdentifier, from: fromState, to: targetState, internalId: issue.internalId, ...(redispatched ? { redispatched } : {}) };
}

/**
 * AI-1857 AC4: Fetch a gate-verification snapshot for a ticket.
 * Used by the proxy to include post-transition ticket state in gate-decline responses
 * so the CLI can verify "no partial state was written" without a separate fetch.
 */
export async function fetchTicketVerification(
  issueId: string,
  authToken: string,
): Promise<{ labels: string[]; delegateId: string | null; stateLabel: string | null }> {
  const { labels, delegateId } = await fetchTicketContext(issueId, authToken);
  const stateLabel = labels.find((l) => l.startsWith("state:")) ?? null;
  return { labels, delegateId, stateLabel };
}
