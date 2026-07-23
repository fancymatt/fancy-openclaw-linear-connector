/**
 * AI-2009 — Connector: first-action watchdog with auto-remediation ladder
 * (redispatch → unreachable + alert → optional capability-policy re-route).
 *
 * Stall DETECTION already exists (sweeps + nudges) but has no remediation power:
 * every major dev-impl stall was detected within hours, nudged with zero effect,
 * and ultimately resolved by hand. This watchdog closes the loop — it arms a
 * per-state deadline at dispatch delivery and, on breach, walks an escalation
 * ladder that actually re-wakes / re-routes / alerts, rung by rung.
 *
 * Design constraints baked into the contract (see the AI-2009 test suite):
 *   - NEVER auto-transitions workflow state (the ladder nudges the owner, it does
 *     not advance the machine).
 *   - NEVER fires on human-assigned or Matt-blocked (`needs-human`) tickets — the
 *     standing org rule against nudging Matt-blocked work.
 *   - Re-entry / revision dispatches get identical coverage to first-pass ones
 *     (round-trips are the fragile path).
 *   - The rung-1 re-dispatch is a genuine fresh wake that bypasses dispatch
 *     idempotency suppression (AI-1969 admit semantics) — an ordinary duplicate
 *     would be swallowed by the guard.
 *
 * I/O is injected (listTickets / redispatch / escalateUnreachable / reroute /
 * notify / now) exactly like runSlaSweep, so the ladder logic is unit-tested in
 * isolation; index.ts wires the real data plane (delivered-at from the
 * operational event store, first-owner-action-at from Linear, delegate/labels
 * from the enrolled-tickets mirror).
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";
import {
  markFirstActionWatchdogScheduled,
  getFirstActionLadder,
  upsertFirstActionLadder,
  deleteFirstActionLadder,
  type FirstActionLadder,
  type LadderHistoryEntry,
} from "./first-action-watchdog-state.js";
import type { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
import { StallReasonCode, type StallReason } from "./wake-observability/index.js";

const CRON_NAME = "first-action-watchdog";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEFAULT_DEADLINE_MS = 45 * MINUTE;
/**
 * AI-2091 §4–§6 — restart-safety arming horizon. The watchdog's ladder state is
 * in-memory: after a restart it is empty. A ticket whose dispatch was delivered
 * long before this process started must NOT breach on the very first sweep — that
 * re-fired whole dead backlogs (the AI-2015 AC4/AC6 storm). On a cold/first arm
 * (no persisted ladder for this dispatch), if the delivery predates `now` by more
 * than this horizon we treat it as pre-restart backlog and clamp the armed time
 * forward to `now`, giving the owner a fresh deadline measured from restart rather
 * than instantly breaching. The horizon sits well above any first-action deadline
 * (defs top out at 45m) so it never suppresses a legitimate in-process breach.
 */
const MAX_ARM_LOOKBACK_MS = 2 * HOUR;
const DEFAULT_MAX_RUNGS = 3;
const DEFAULT_CADENCE_MS = 5 * MINUTE;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A watchdog ticket record as produced by the (injected) data plane. */
export interface WatchdogTicket {
  ticket: string;
  workflow: string;
  state: string;
  delegate: string;
  humanAssigned: boolean;
  labels: string[];
  /** Epoch ms the dispatch was delivered — the deadline is armed from here. */
  dispatchDeliveredAtMs: number;
  /** ISO updatedAt tuple component for the idempotency key. */
  dispatchUpdatedAt: string;
  /** Epoch ms of the first visible owner action, or null if none yet. */
  firstOwnerActionAtMs: number | null;
  isReentry?: boolean;
  /** Rungs already fired in prior sweeps (the persisted ladder accumulator). */
  rungsFired?: number;
  /** Reason-code from the stall resolver — lets the watchdog escalate based on
   *  the actual cause instead of treating every stall identically. */
  stallReason?: StallReason;
}

/** Minimal shape of a capability policy for re-route resolution. */
export interface WatchdogCapabilityPolicy {
  bodies: Array<{ id: string; fills_roles: string[] }>;
  roles?: Array<{ id: string; exclusive?: boolean }>;
  [key: string]: unknown;
}

export interface RedispatchPayload {
  ticket: string;
  state: string;
  agent: string;
}

export interface UnreachableAlert {
  severity: string;
  source: string;
  title: string;
  ticket: string;
  state: string;
  delegate: string;
  /** Real escalation rungs fired before exhaustion (≤ maxRungs) — use this in
   *  alert copy, NOT history.length (history also logs the exhaustion entry). */
  rungsFired: number;
  history: LadderHistoryEntry[];
  [key: string]: unknown;
}

/** Verdict of the on-breach cross-check against authoritative Linear state.
 *  "stale" means the caller found the mirror row wrong (ticket done / deleted /
 *  demoted / state-corrected) and healed it — the ladder must be dropped
 *  without firing a rung. "unknown" (Linear unreachable) fails open to normal
 *  ladder behavior. */
export type CrossCheckVerdict = "live" | "stale" | "unknown";

export interface ReroutePayload {
  ticket: string;
  fromAgent: string;
  toAgent: string;
  role: string;
}

export interface FirstActionWatchdogOptions {
  authToken?: string;
  /** File OR directory of workflow def YAML; per-state first_action_deadline. */
  workflowDefPath?: string;
  listTickets: () => Promise<WatchdogTicket[]>;
  now?: () => number;
  defaultDeadlineMs?: number;
  maxRungs?: number;
  capabilityPolicy?: WatchdogCapabilityPolicy;
  /** Ops-channel alert sink (rung 2). */
  notify?: (alert: UnreachableAlert) => void;
  /** Rung 1 — genuine fresh wake (bypasses idempotency in the wired impl). */
  redispatch?: (payload: RedispatchPayload) => Promise<{ admitted: boolean }>;
  /** Rung 2 — mark the delegate unreachable for this ticket. */
  escalateUnreachable?: (payload: {
    ticket: string;
    state: string;
    agent: string;
    history: LadderHistoryEntry[];
  }) => Promise<void>;
  /** Rung 3 — optional re-route to a fallback body. */
  reroute?: (payload: ReroutePayload) => Promise<void>;
  /** On-breach cross-check against authoritative Linear state. The caller is
   *  responsible for healing the mirror row when it returns "stale". Only
   *  invoked for breached tickets, so the Linear read cost stays proportional
   *  to actual stalls. */
  crossCheck?: (ticket: WatchdogTicket) => Promise<CrossCheckVerdict>;
  /** Present only so the sweep can assert it NEVER auto-transitions. */
  transition?: (payload: unknown) => Promise<void>;
  cadenceMs?: number;
}

export interface WatchdogSweepResult {
  scanned: number;
  armed: number;
  breached: number;
  redispatched: number;
  unreachable: number;
  reroutes: number;
  /** Breached tickets whose mirror row turned out stale (done/deleted/demoted
   *  in Linear) — healed by the cross-check and dropped without alerting. */
  staleCleared: number;
  /** Always 0 — the ladder never auto-transitions workflow state. */
  transitions: number;
  humanExcluded: number;
  errors: unknown[];
}

/** Row for the per-state dwell/idle metrics aggregate (p4 distillation). */
export interface DwellRow {
  state: string;
  enteredAtMs: number;
  firstOwnerActionAtMs: number | null;
  exitedAtMs: number | null;
}

export interface PerStateDwellAggregate {
  state: string;
  count: number;
  totalDwellMs: number;
  totalIdleMs: number;
  maxDwellMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a duration string ("45m", "2h", "3600000") to ms; null if unparseable. */
function parseDurationToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(d|h|m|s|ms)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "d": return n * 24 * 60 * MINUTE;
    case "h": return n * 60 * MINUTE;
    case "m": return n * MINUTE;
    case "s": return n * 1_000;
    case "ms": case "": return n;
    default: return null;
  }
}

interface WorkflowStateDef {
  id: string;
  owner_role?: string;
  first_action_deadline?: string | number;
  [key: string]: unknown;
}

/**
 * Resolve the def for a (workflow, state) from a workflow-def path that may be a
 * single file or a directory of *.yaml defs. Returns the matched state def (with
 * owner_role + optional first_action_deadline), or undefined.
 */
function loadWorkflowStateDef(
  defPath: string | undefined,
  workflowId: string,
  stateId: string,
): WorkflowStateDef | undefined {
  if (!defPath || !fs.existsSync(defPath)) return undefined;
  let files: string[];
  if (fs.statSync(defPath).isDirectory()) {
    files = fs
      .readdirSync(defPath)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort()
      .map((f) => path.join(defPath, f));
  } else {
    files = [defPath];
  }
  for (const file of files) {
    let def: { id?: string; states?: WorkflowStateDef[] } | undefined;
    try {
      def = yaml.load(fs.readFileSync(file, "utf8")) as typeof def;
    } catch {
      continue;
    }
    if (!def || def.id !== workflowId || !Array.isArray(def.states)) continue;
    const state = def.states.find((s) => s.id === stateId);
    if (state) return state;
  }
  return undefined;
}

// ── Re-route resolution (rung 3) ──────────────────────────────────────────────

/**
 * Resolve a fallback body that fills `role` and is NOT the current delegate.
 * Returns null for singleton/exclusive roles (e.g. test-author) and for roles
 * with no alternate body — the ladder must never re-route those.
 */
export function resolveRerouteTarget(
  policy: WatchdogCapabilityPolicy | undefined,
  role: string,
  currentDelegate: string,
): string | null {
  if (!policy || !Array.isArray(policy.bodies)) return null;
  const roleDef = policy.roles?.find((r) => r.id === role);
  // Exclusive/singleton roles are never re-routed — there is no legal alternate.
  if (roleDef?.exclusive) return null;
  const fallback = policy.bodies
    .filter((b) => Array.isArray(b.fills_roles) && b.fills_roles.includes(role))
    .map((b) => b.id)
    .find((id) => id !== currentDelegate);
  return fallback ?? null;
}

/**
 * Resolve the role for a MODEL_DEGRADED stall. Prefers the explicit owner_role
 * from the workflow state def, but falls back to the first role the delegate
 * fills in the capability policy that has an alternate body — allowing
 * reroute even when the workflow def doesn't declare an owner_role.
 */
function resolveModelDegradedRole(
  explicitRole: string | undefined,
  delegate: string,
  policy: WatchdogCapabilityPolicy | undefined,
): string | null {
  if (explicitRole) return explicitRole;
  if (!policy || !Array.isArray(policy.bodies)) return null;
  const bodyDef = policy.bodies.find((b) => b.id === delegate);
  if (!bodyDef || !Array.isArray(bodyDef.fills_roles)) return null;
  // Find the first role the delegate fills that has an alternate body
  for (const role of bodyDef.fills_roles) {
    const roleDef = policy.roles?.find((r) => r.id === role);
    if (roleDef?.exclusive) continue; // Can't reroute exclusive roles
    const alternate = policy.bodies.find(
      (b) => b.id !== delegate && Array.isArray(b.fills_roles) && b.fills_roles.includes(role),
    );
    if (alternate) return role;
  }
  return null;
}

// ── Re-dispatch bypassing idempotency (rung 1, AI-1969 admit semantics) ────────

/**
 * A watchdog re-dispatch is a GENUINE fresh wake: it must admit the same
 * (ticket, state, agent, updatedAt) tuple that dispatch idempotency would
 * otherwise suppress as a duplicate. We clear the prior idempotency rows for the
 * (ticket, agent) — the store's documented manual-recovery escape hatch — then
 * record afresh, so the wake is admitted rather than swallowed.
 */
export function redispatchViaWatchdog(
  store: DispatchIdempotencyStore,
  dispatch: {
    ticketKey: string;
    workflowState: string;
    agent: string;
    updatedAt: string;
  },
): { admitted: boolean; suppressed: boolean } {
  store.clearAgentRows(dispatch.ticketKey, dispatch.agent);
  const result = store.checkAndRecord(
    dispatch.ticketKey,
    dispatch.workflowState,
    dispatch.agent,
    dispatch.updatedAt,
  );
  return { admitted: !result.suppressed, suppressed: result.suppressed };
}

// ── Per-state dwell/idle aggregates (AC5, p4 metrics distillation) ─────────────

/**
 * Aggregate dwell (time in state) and idle (delivery → first owner action) per
 * state. Open rows (no exit) are measured to `nowMs`; rows with no owner action
 * count their whole dwell as idle. So this analysis is a dashboard read next
 * time, not a manual archaeology pass.
 */
export function computePerStateDwellAggregates(
  rows: DwellRow[],
  nowMs: number,
): PerStateDwellAggregate[] {
  const byState = new Map<string, PerStateDwellAggregate>();
  for (const row of rows) {
    const exitedOrNow = row.exitedAtMs ?? nowMs;
    const dwellMs = exitedOrNow - row.enteredAtMs;
    const idleEnd = row.firstOwnerActionAtMs ?? exitedOrNow;
    const idleMs = idleEnd - row.enteredAtMs;
    let agg = byState.get(row.state);
    if (!agg) {
      agg = { state: row.state, count: 0, totalDwellMs: 0, totalIdleMs: 0, maxDwellMs: 0 };
      byState.set(row.state, agg);
    }
    agg.count += 1;
    agg.totalDwellMs += dwellMs;
    agg.totalIdleMs += idleMs;
    if (dwellMs > agg.maxDwellMs) agg.maxDwellMs = dwellMs;
  }
  return [...byState.values()];
}

// ── The sweep ─────────────────────────────────────────────────────────────────

export async function runFirstActionWatchdogSweep(
  opts: FirstActionWatchdogOptions,
): Promise<WatchdogSweepResult> {
  const now = opts.now ? opts.now() : Date.now();
  const defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRungs = opts.maxRungs ?? DEFAULT_MAX_RUNGS;

  const result: WatchdogSweepResult = {
    scanned: 0,
    armed: 0,
    breached: 0,
    redispatched: 0,
    unreachable: 0,
    reroutes: 0,
    staleCleared: 0,
    transitions: 0,
    humanExcluded: 0,
    errors: [],
  };

  let tickets: WatchdogTicket[];
  try {
    tickets = await opts.listTickets();
  } catch (err) {
    result.errors.push(err);
    return result;
  }

  for (const t of tickets) {
    result.scanned += 1;
    try {
      // AC3 — never nudge human-assigned or Matt-blocked (`needs-human`) work.
      // Excluded tickets are not armed at all.
      if (t.humanAssigned || (t.labels ?? []).includes("needs-human")) {
        result.humanExcluded += 1;
        continue;
      }

      const stateDef = loadWorkflowStateDef(opts.workflowDefPath, t.workflow, t.state);
      const overrideMs = parseDurationToMs(stateDef?.first_action_deadline);
      const deadlineMs = overrideMs ?? defaultDeadlineMs;
      const rawDeliveredAtMs = t.dispatchDeliveredAtMs;

      const existing = getFirstActionLadder(t.ticket);
      // A ladder only carries over for the SAME dispatch (same RAW delivery time).
      // A fresh dispatch — re-entry, revision round-trip, or a state change
      // re-stamping entered_state_at — re-arms a clean ladder; rungs and an
      // "unreachable" verdict from a prior dispatch must not swallow it.
      // Identity is compared on the RAW delivered-at (persisted as deliveredAtMs)
      // because armedAt may be restart-clamped away from it. Back-compat: ladders
      // written before deliveredAtMs existed used armedAt === delivered-at.
      const sameDispatch =
        existing != null &&
        (existing.deliveredAtMs != null
          ? existing.deliveredAtMs === rawDeliveredAtMs
          : Date.parse(existing.armedAt) === rawDeliveredAtMs);

      // AI-2091 §4/§6: on a cold/first or fresh arm, clamp the armed time forward
      // to `now` when the delivery is older than the restart-safety horizon — a
      // stale, pre-restart delivered-at must not breach on the first sweep. The
      // same-dispatch case keeps its already-armed (possibly clamped) time so the
      // deadline is stable across sweeps.
      const armedAtMs = sameDispatch
        ? Date.parse(existing.armedAt)
        : now - rawDeliveredAtMs > MAX_ARM_LOOKBACK_MS
          ? now
          : rawDeliveredAtMs;
      const deadlineAtMs = armedAtMs + deadlineMs;

      const priorRungs = t.rungsFired ?? (sameDispatch ? existing.rungsFired : 0);
      const history: LadderHistoryEntry[] = sameDispatch ? [...existing.history] : [];

      let rungsFired = priorRungs;
      let unreachable = sameDispatch ? existing.unreachable : false;
      result.armed += 1;

      const actedInTime =
        t.firstOwnerActionAtMs != null && t.firstOwnerActionAtMs <= deadlineAtMs;
      const breached = !actedInTime && now >= deadlineAtMs;

      // ── Reason-code-aware escalation (INF-84) ──────────────────────────
      // Check the stallReason before acting. This lets the watchdog escalate
      // differently based on the *actual cause* of the stall instead of treating
      // every breach identically.
      const stallReason = t.stallReason?.reason;

      // ACTIVELY_PROCESSING — the agent IS working on this ticket, just slowly.
      // Never escalate: the resolver already confirmed the agent is active.
      // This eliminates false-alarm "stalls" (AC5).
      const isActivelyProcessing = stallReason === StallReasonCode.ACTIVELY_PROCESSING;

      if (breached) {
        result.breached += 1;

        // If the resolver says the agent is actively working, skip entirely
        // even if the deadline technically breached.
        if (isActivelyProcessing) {
          continue;
        }

        // A breach on a stale mirror row (ticket already done / deleted /
        // demoted in Linear) is not a stall — heal-and-drop, never alert.
        if (opts.crossCheck) {
          let verdict: CrossCheckVerdict = "unknown";
          try {
            verdict = await opts.crossCheck(t);
          } catch {
            verdict = "unknown"; // fail open to normal ladder behavior
          }
          if (verdict === "stale") {
            deleteFirstActionLadder(t.ticket);
            result.staleCleared += 1;
            continue;
          }
        }

        if (unreachable) {
          // Ladder already exhausted for this dispatch — the rung-2 alert
          // fired once; stay silent instead of re-alerting every sweep.
          continue;
        }

        if (priorRungs >= maxRungs) {
          // Rung 2 — ladder exhausted: mark unreachable + alert ops, carrying
          // ticket / state / delegate / history for the on-call human.
          unreachable = true;
          history.push({ rung: "unreachable", at: new Date(now).toISOString() });
          result.unreachable += 1;

          opts.notify?.({
            severity: "critical",
            source: "first-action-watchdog",
            title: `Delegate ${t.delegate} unreachable on ${t.ticket} (${t.state})`,
            ticket: t.ticket,
            state: t.state,
            delegate: t.delegate,
            rungsFired: priorRungs,
            history: history.map((h) => ({ ...h })),
          });

          if (opts.escalateUnreachable) {
            await opts.escalateUnreachable({
              ticket: t.ticket,
              state: t.state,
              agent: t.delegate,
              history: history.map((h) => ({ ...h })),
            });
          }

          // Rung 3 — optional re-route to a fallback body, respecting capability
          // policy; never for singleton/exclusive roles without a fallback.
          const role = stateDef?.owner_role;
          const target = role
            ? resolveRerouteTarget(opts.capabilityPolicy, role, t.delegate)
            : null;
          if (target && role && opts.reroute) {
            history.push({
              rung: "reroute",
              at: new Date(now).toISOString(),
              detail: `${t.delegate}→${target}`,
            });
            await opts.reroute({
              ticket: t.ticket,
              fromAgent: t.delegate,
              toAgent: target,
              role,
            });
            result.reroutes += 1;
          }
        } else {
          // Rung 1 — automatic re-dispatch (genuine fresh wake).
          // Reason-code-aware escalation: some stall reasons should skip rung-1
          // redispatch (re-waking a dead session is pointless) and go directly
          // to the appropriate higher rung.
          if (stallReason === StallReasonCode.SESSION_DEAD) {
            // SESSION_DEAD: skip redispatch → go directly to unreachable (rung 2).
            unreachable = true;
            history.push({ rung: "unreachable", at: new Date(now).toISOString() });
            result.unreachable += 1;

            opts.notify?.({
              severity: "critical",
              source: "first-action-watchdog",
              title: `Delegate ${t.delegate} unreachable (SESSION_DEAD) on ${t.ticket} (${t.state})`,
              ticket: t.ticket,
              state: t.state,
              delegate: t.delegate,
              rungsFired: priorRungs,
              history: history.map((h) => ({ ...h })),
            });

            if (opts.escalateUnreachable) {
              await opts.escalateUnreachable({
                ticket: t.ticket,
                state: t.state,
                agent: t.delegate,
                history: history.map((h) => ({ ...h })),
              });
            }

            // Set rungsFired = maxRungs so the ladders marks exhausted.
            rungsFired = maxRungs;
          } else if (stallReason === StallReasonCode.MODEL_DEGRADED) {
            // MODEL_DEGRADED: skip redispatch → go directly to reroute (rung 3).
            // Resolve the role: prefer explicit owner_role from workflow def,
            // then fall back to any role the delegate fills that has an
            // alternate body in the capability policy.
            const role = resolveModelDegradedRole(stateDef?.owner_role, t.delegate, opts.capabilityPolicy);
            const target = role
              ? resolveRerouteTarget(opts.capabilityPolicy, role, t.delegate)
              : null;
            if (target && role && opts.reroute) {
              history.push({
                rung: "reroute",
                at: new Date(now).toISOString(),
                detail: `${t.delegate}→${target} (MODEL_DEGRADED)`,
              });
              await opts.reroute({
                ticket: t.ticket,
                fromAgent: t.delegate,
                toAgent: target,
                role,
              });
              result.reroutes += 1;
              rungsFired = maxRungs;
            } else {
              // No reroute target available — fall through to normal redispatch
              history.push({ rung: "redispatch", at: new Date(now).toISOString() });
              if (opts.redispatch) {
                await opts.redispatch({ ticket: t.ticket, state: t.state, agent: t.delegate });
              }
              rungsFired = priorRungs + 1;
              result.redispatched += 1;
            }
          } else {
            // Normal escalation: rung 1 — automatic re-dispatch.
            history.push({ rung: "redispatch", at: new Date(now).toISOString() });
            if (opts.redispatch) {
              await opts.redispatch({ ticket: t.ticket, state: t.state, agent: t.delegate });
            }
            rungsFired = priorRungs + 1;
            result.redispatched += 1;
          }
        }
      }

      const ladder: FirstActionLadder = {
        ticket: t.ticket,
        state: t.state,
        delegate: t.delegate,
        armedAt: new Date(armedAtMs).toISOString(),
        deliveredAtMs: rawDeliveredAtMs,
        deadlineAt: new Date(deadlineAtMs).toISOString(),
        rungsFired,
        unreachable,
        history,
      };
      upsertFirstActionLadder(ladder);
    } catch (err) {
      result.errors.push(err);
    }
  }

  return result;
}

// ── Cron registration (bootstrap wiring) ──────────────────────────────────────

/**
 * Register the first-action watchdog as a periodic cron. Called from the
 * production entry point (index.ts) so the watchdog is armed at server bootstrap
 * — not merely importable dead code. Adds a `first-action-watchdog` registry
 * entry (feeds /health.crons) and marks the watchdog scheduled for liveness.
 */
export function registerFirstActionWatchdogCron(
  opts: FirstActionWatchdogOptions,
): ReturnType<typeof setInterval> {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  registerCron(CRON_NAME, `every ${formatIntervalMs(cadenceMs)}`);
  markFirstActionWatchdogScheduled();

  const timer = setInterval(() => {
    runFirstActionWatchdogSweep(opts).then(() => {
      markCronRun(CRON_NAME);
    }).catch((err) => {
      console.error(`[${CRON_NAME}] sweep failed:`, err);
    });
  }, cadenceMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
