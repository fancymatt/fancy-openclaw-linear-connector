/**
 * AI-1914 — Workflow-def state-removal migration.
 *
 * When a workflow def version removes a state, any governed ticket still labeled
 * `state:<removed>` is stranded: every forward verb fails closed on the unknown
 * state and the only sanctioned exit (`escape`) is lossy. This module provides
 * the non-lossy, agent-reachable path:
 *
 *   - planDefStateMigration()      — AC1/AC5: decide whether a ticket at a removed
 *                                    state has a mapped target (auto-migrate) or is
 *                                    an unmapped strand (leave alone).
 *   - runDefStateMigrationSweep()  — AC1: enumerate governed tickets and migrate
 *                                    each mapped defunct-state ticket atomically
 *                                    (label swap + re-dispatch + operational event).
 *   - validateDefStateRemovals()   — AC3: refuse to activate a def that removes a
 *                                    state without a mapping or an explicit strand ack.
 *   - registerDefStateMigrationRunner() — AC6: bootstrap wiring; runs the sweep on
 *                                    load and exposes liveness for /health.
 *
 * The raw-mutation fail-open that this path replaces is closed in
 * `workflow-gate.ts` (`checkRawMutationInterception`, AC4).
 */

import { createLogger, componentLogger } from "./logger.js";
import type { WorkflowDef } from "./workflow-gate.js";
import { getWorkflowId, getCurrentState } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
import type { OperationalEventInput } from "./store/operational-event-store.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "def-state-migration");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DefStateMigrationPlan {
  fromState: string;
  toState: string;
  /** owner_role of the TARGET state — re-dispatch must reach this role, not the source's. */
  ownerRole?: string;
}

/** Minimal operational-event sink. Supports both the real store (`append`) and the
 *  `record`-shaped sink used elsewhere (rescue sweep); either is honored. */
// This module only emits the two def-state-migration outcomes, both members of
// the store's OperationalEventOutcome union — so the payload is a real
// OperationalEventInput. Method syntax (bivariant params) keeps both the real
// OperationalEventStore.append and a `record`-shaped test sink assignable.
type OperationalEventPayload = OperationalEventInput;
interface OperationalEventSink {
  append?(event: OperationalEventPayload): unknown;
  record?(event: OperationalEventPayload): unknown;
}

export interface DefStateMigrationSweepOptions {
  /** Linear auth token (Bearer ...). */
  authToken: string;
  /** Workflow registry: map of wf-id → WorkflowDef. */
  workflowRegistry: Map<string, WorkflowDef>;
  /** Operational event store (optional; one event per migrated ticket). */
  operationalEventStore?: OperationalEventSink;
  /** Resolver: label name → Linear label UUID (or null). When omitted, team labels
   *  are fetched per team to build the mapping (mirrors the rescue sweep). */
  labelNameToId?: (name: string) => string | null;
  /** Re-dispatch primitive: wake the target owner for a migrated ticket. */
  wakeFn: (agent: string, identifier: string) => Promise<void>;
}

export interface DefStateMigrationSweepResult {
  scanned: number;
  migrated: Array<{ ticketId: string; identifier: string; fromState: string; toState: string }>;
  errors: string[];
}

interface FetchedTicket {
  id: string;
  identifier: string;
  labels: string[];
  labelNodes: Array<{ id: string; name: string }>;
  teamId: string;
}

// ── AC1/AC5: per-ticket migration decision ────────────────────────────────────

/**
 * Decide whether a ticket's labels indicate a def-state migration.
 *
 * Returns a plan `{fromState, toState, ownerRole}` when the ticket's `state:*`
 * label names a state that is ABSENT from `def.states` but PRESENT as a key in
 * `def.migrations`. Returns null for a still-valid state, a removed state with
 * no mapping (a strand, not an auto-migration), an ungoverned ticket (no wf:*),
 * or a governed ticket with no state:* label.
 */
export function planDefStateMigration(
  labels: string[],
  def: WorkflowDef,
): DefStateMigrationPlan | null {
  if (!getWorkflowId(labels)) return null; // ungoverned — no wf:* label
  const fromState = getCurrentState(labels);
  if (!fromState) return null; // no state:* label

  // Still a live state → nothing to migrate.
  if (def.states.some((s) => s.id === fromState)) return null;

  // Removed state: auto-migrate only if a mapping exists (else it is a strand).
  const toState = def.migrations?.[fromState];
  if (!toState) return null;

  const ownerRole = def.states.find((s) => s.id === toState)?.owner_role;
  return { fromState, toState, ownerRole };
}

// ── AC3: def validation — refuse silent stranding ─────────────────────────────

/**
 * Return an error per state present in `previousStateIds` but absent from
 * `nextDef.states` that has NEITHER a `nextDef.migrations` mapping NOR an entry
 * in `nextDef.strand_acknowledged`. Empty array ⇒ safe to activate.
 */
export function validateDefStateRemovals(
  previousStateIds: string[],
  nextDef: WorkflowDef,
): string[] {
  const nextStateIds = new Set(nextDef.states.map((s) => s.id));
  const mapped = new Set(Object.keys(nextDef.migrations ?? {}));
  const acked = new Set(nextDef.strand_acknowledged ?? []);
  const errors: string[] = [];

  for (const removed of previousStateIds) {
    if (nextStateIds.has(removed)) continue; // still present
    if (mapped.has(removed) || acked.has(removed)) continue; // covered
    errors.push(
      `workflow '${nextDef.id}' removes state '${removed}' without a migrations mapping or a strand_acknowledged ` +
        `entry — this would silently strand in-flight tickets. Add migrations['${removed}'] → <target-state> or ` +
        `list '${removed}' under strand_acknowledged to activate this def.`,
    );
  }
  return errors;
}

// ── Linear helpers ────────────────────────────────────────────────────────────

async function fetchGovernedTickets(authToken: string): Promise<FetchedTicket[]> {
  const query = `
    query WorkflowIssues {
      issues(filter: { labels: { some: { name: { startsWith: "wf:" } } } }) {
        nodes {
          id
          identifier
          state { name }
          labels { nodes { id name } }
          team { id }
        }
      }
    }
  `;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query }),
  });
  type IssueNode = {
    id: string;
    identifier: string;
    labels: { nodes: Array<{ id: string; name: string }> };
    team: { id: string } | null;
  };
  type Resp = { data?: { issues?: { nodes: IssueNode[] } } };
  const data = (await res.json()) as Resp;
  return (data.data?.issues?.nodes ?? []).map((n) => ({
    id: n.id,
    identifier: n.identifier,
    labels: n.labels.nodes.map((l) => l.name),
    labelNodes: n.labels.nodes,
    teamId: n.team?.id ?? "",
  }));
}

async function fetchTeamLabelMap(teamId: string, authToken: string): Promise<Map<string, string>> {
  const query = `query TeamLabels($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { teamId } }),
    });
    type Resp = { data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } } };
    const data = (await res.json()) as Resp;
    const map = new Map<string, string>();
    for (const n of data.data?.team?.labels?.nodes ?? []) map.set(n.name, n.id);
    return map;
  } catch (err) {
    log.error(`fetchTeamLabelMap failed for team ${teamId}: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

async function applyLabelIds(ticketId: string, labelIds: string[], authToken: string): Promise<boolean> {
  const mutation = `mutation UpdateLabels($id: String!, $labelIds: [String!]!) { issueUpdate(id: $id, input: { labelIds: $labelIds }) { success } }`;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query: mutation, variables: { id: ticketId, labelIds } }),
  });
  type Resp = { data?: { issueUpdate?: { success: boolean } } };
  const data = (await res.json()) as Resp;
  return data.data?.issueUpdate?.success ?? false;
}

function emitEvent(store: OperationalEventSink | undefined, event: OperationalEventPayload): void {
  if (!store) return;
  try {
    if (typeof store.record === "function") store.record(event);
    else if (typeof store.append === "function") store.append(event);
  } catch (err) {
    log.warn(`operational event emit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── AC1: the sweep ────────────────────────────────────────────────────────────

/**
 * Enumerate governed (wf:*) tickets and migrate each ticket stranded at a
 * removed state that carries a `migrations` mapping in its def: atomically swap
 * the `state:*` label (drop defunct, add target), re-dispatch (wake) the target
 * state's owner role, and emit one operational event per migrated ticket.
 *
 * Idempotent: a ticket at a live state (or a removed state with no mapping) is
 * left untouched. Nothing is fetched when no registered def declares a migration
 * map — there is nothing an auto-migration could act on.
 */
export async function runDefStateMigrationSweep(
  options: DefStateMigrationSweepOptions,
): Promise<DefStateMigrationSweepResult> {
  const { authToken, workflowRegistry, operationalEventStore, wakeFn } = options;
  const migrated: DefStateMigrationSweepResult["migrated"] = [];
  const errors: string[] = [];

  // Short-circuit: no migration maps anywhere ⇒ nothing to auto-migrate, no fetch.
  const anyMigrations = [...workflowRegistry.values()].some(
    (d) => d.migrations && Object.keys(d.migrations).length > 0,
  );
  if (!anyMigrations) return { scanned: 0, migrated, errors };

  let tickets: FetchedTicket[] = [];
  try {
    tickets = await fetchGovernedTickets(authToken);
  } catch (err) {
    errors.push(`fetchGovernedTickets error: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned: 0, migrated, errors };
  }

  // Build label name → UUID resolver: injected (tests) or per-team fetch (prod).
  let labelNameToId: (name: string) => string | null;
  if (options.labelNameToId) {
    labelNameToId = options.labelNameToId;
  } else {
    const labelMap = new Map<string, string>();
    for (const teamId of [...new Set(tickets.map((t) => t.teamId).filter(Boolean))]) {
      for (const [name, id] of await fetchTeamLabelMap(teamId, authToken)) labelMap.set(name, id);
    }
    labelNameToId = (name: string) => labelMap.get(name) ?? null;
  }

  for (const ticket of tickets) {
    const wfId = getWorkflowId(ticket.labels);
    const def = wfId ? workflowRegistry.get(wfId) : undefined;
    if (!def) continue;

    const plan = planDefStateMigration(ticket.labels, def);
    if (!plan) continue;

    const targetLabelId = labelNameToId(`state:${plan.toState}`);
    if (!targetLabelId) {
      errors.push(`could not resolve label UUID for state:${plan.toState} on ${ticket.identifier}`);
      emitEvent(operationalEventStore, {
        outcome: "def-state-migration-failed",
        type: "def-state-migration",
        key: ticket.id,
        detail: { identifier: ticket.identifier, fromState: plan.fromState, toState: plan.toState, reason: "target-label-unresolved" },
      });
      continue;
    }

    // Atomic label swap: keep every existing label except the defunct state:*,
    // and add the target state label.
    const fromLabelName = `state:${plan.fromState}`;
    const nextLabelIds = ticket.labelNodes
      .filter((n) => n.name !== fromLabelName)
      .map((n) => n.id);
    if (!nextLabelIds.includes(targetLabelId)) nextLabelIds.push(targetLabelId);

    let ok = false;
    try {
      ok = await applyLabelIds(ticket.id, nextLabelIds, authToken);
    } catch (err) {
      ok = false;
      errors.push(`label swap failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!ok) {
      emitEvent(operationalEventStore, {
        outcome: "def-state-migration-failed",
        type: "def-state-migration",
        key: ticket.id,
        detail: { identifier: ticket.identifier, fromState: plan.fromState, toState: plan.toState, reason: "label-swap-failed" },
      });
      continue;
    }

    // Re-dispatch to the TARGET state's owner role.
    let wakeTarget = plan.ownerRole ?? "";
    if (plan.ownerRole) {
      try {
        const bodies = await resolveBodiesForRole(plan.ownerRole);
        if (bodies.length > 0) wakeTarget = bodies[0];
      } catch {
        /* fall back to the role name */
      }
    }
    try {
      await wakeFn(wakeTarget, ticket.identifier);
    } catch (err) {
      errors.push(`re-dispatch failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`);
    }

    migrated.push({ ticketId: ticket.id, identifier: ticket.identifier, fromState: plan.fromState, toState: plan.toState });
    emitEvent(operationalEventStore, {
      outcome: "def-state-migrated",
      type: "def-state-migration",
      agent: wakeTarget || null,
      key: ticket.id,
      detail: { identifier: ticket.identifier, fromState: plan.fromState, toState: plan.toState, ownerRole: plan.ownerRole },
    });
    log.info(`def-state-migrated ${ticket.identifier}: ${plan.fromState} → ${plan.toState} (owner ${plan.ownerRole ?? "?"})`);
  }

  return { scanned: tickets.length, migrated, errors };
}

// ── AC6: bootstrap wiring + /health liveness ──────────────────────────────────

export interface DefStateMigrationLiveness {
  /** True once the runner has been registered at bootstrap. */
  ranOnLoad: boolean;
  /** Number of tickets migrated on the most recent load sweep (0 allowed). */
  migratedCount: number;
  /** Number of governed tickets scanned on the most recent load sweep. */
  scanned: number;
  /** ISO timestamp of the last completed sweep, or null if it has not finished yet. */
  lastRunAt: string | null;
  /** Non-fatal errors from the last sweep. */
  errors: string[];
}

let _liveness: DefStateMigrationLiveness = {
  ranOnLoad: false,
  migratedCount: 0,
  scanned: 0,
  lastRunAt: null,
  errors: [],
};

/** Liveness snapshot for /health (AC6): confirms the migration check ran on load. */
export function getDefStateMigrationLiveness(): DefStateMigrationLiveness {
  return { ..._liveness, errors: [..._liveness.errors] };
}

/** Test hook: reset liveness between app boots. */
export function resetDefStateMigrationLiveness(): void {
  _liveness = { ranOnLoad: false, migratedCount: 0, scanned: 0, lastRunAt: null, errors: [] };
}

export interface DefStateMigrationRunnerOptions {
  authToken: string;
  /** Lazily resolve the workflow registry (async load happens off the boot path). */
  loadRegistry: () => Promise<Map<string, WorkflowDef>>;
  operationalEventStore?: OperationalEventSink;
  wakeFn: (agent: string, identifier: string) => Promise<void>;
  labelNameToId?: (name: string) => string | null;
}

/**
 * AC6: register the def-load migration runner at server bootstrap. Marks
 * liveness synchronously (so /health reports a numeric migratedCount of 0
 * immediately) and runs the sweep off the boot path, updating the count when it
 * completes. Reachable from the production entry point (index.ts createApp).
 */
export function registerDefStateMigrationRunner(options: DefStateMigrationRunnerOptions): void {
  _liveness = { ranOnLoad: true, migratedCount: 0, scanned: 0, lastRunAt: null, errors: [] };

  // No Linear auth token ⇒ the sweep cannot enumerate governed tickets, so skip
  // the registry load + sweep entirely (mirrors the sla-sweep `if (authToken)`
  // gate). This keeps the runner from triggering a config-health-recording
  // registry load on every createApp() in the test suite, which would otherwise
  // race into unrelated tests. Liveness still reports ranOnLoad with a 0 count.
  if (!options.authToken || options.authToken.trim() === "") {
    _liveness = { ranOnLoad: true, migratedCount: 0, scanned: 0, lastRunAt: null, errors: ["skipped: no Linear auth token"] };
    log.info("def-state migration runner registered but skipped — no Linear auth token available");
    return;
  }

  void (async () => {
    try {
      const registry = await options.loadRegistry();
      const result = await runDefStateMigrationSweep({
        authToken: options.authToken,
        workflowRegistry: registry,
        operationalEventStore: options.operationalEventStore,
        wakeFn: options.wakeFn,
        labelNameToId: options.labelNameToId,
      });
      _liveness = {
        ranOnLoad: true,
        migratedCount: result.migrated.length,
        scanned: result.scanned,
        lastRunAt: new Date().toISOString(),
        errors: result.errors,
      };
      log.info(`def-state migration load sweep complete: scanned=${result.scanned} migrated=${result.migrated.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      _liveness = { ranOnLoad: true, migratedCount: 0, scanned: 0, lastRunAt: new Date().toISOString(), errors: [msg] };
      log.error(`def-state migration load sweep failed: ${msg}`);
    }
  })();
}
