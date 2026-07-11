/**
 * AI-1566 — Connector rescue sweep: detect + repair dormant/malformed wf:* tickets.
 *
 * Safety net that periodically enumerates all wf:* tickets and rescues any that
 * have slipped into a broken shape — no delegate, no state label, or drifted
 * ownership. Detection uses labels + delegate only (NOT native Linear status),
 * so it survives the Bug B native-status breakage.
 *
 * Classification rules (mutually exclusive, evaluated in order):
 *   terminal  — state:done or state:escape (ignored)
 *   malformed — has wf:* but no state:* label
 *   dormant   — non-terminal, has state:*, but delegate is null/absent
 *   drifted   — non-terminal, has state:*, but delegate body does not fill the
 *               state's owner_role (per capability policy)
 *   healthy   — everything lines up
 *
 * Design: AI-1566 description.
 */

import fs from "node:fs";
import yaml from "js-yaml";
import { createLogger, componentLogger } from "./logger.js";
import { defaultCapabilityPolicyPath } from "./instance-config.js";
import { getLinearUserIdForAgent } from "./agents.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "rescue-sweep");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ─────────────────────────────────────────────────────────────────

export type TicketClassification =
  | "healthy"
  | "dormant"
  | "malformed"
  | "drifted"
  | "terminal";

export interface SweepTicket {
  /** Linear internal UUID */
  id: string;
  /** Human-readable identifier, e.g. "AI-1566" */
  identifier: string;
  /** Label names on the ticket */
  labels: string[];
  /** Linear user UUID of the current delegate, or null if unset */
  delegateId: string | null;
  /** Display name of the current delegate (optional, for logging) */
  delegateName?: string | null;
}

export interface RescueAction {
  ticketId: string;
  identifier: string;
  classification: Exclude<TicketClassification, "healthy" | "terminal">;
  /** Human-readable description of what was done */
  action: string;
  outcome: "rescued" | "failed" | "ambiguous";
}

export interface RescueSweepResult {
  scanned: number;
  rescued: number;
  byClassification: Partial<Record<TicketClassification, number>>;
  rescues: RescueAction[];
  errors: string[];
}

export interface RescueSweepOptions {
  /** Linear auth token (Bearer ...) */
  authToken: string;
  /** Workflow registry: map of wf-id → WorkflowDef. Defaults to empty Map. */
  workflowRegistry?: Map<string, WorkflowDef>;
  /** Capability policy path override for tests */
  capabilityPolicyPath?: string;
  /** Operational event store for emitting rescue events (optional; skipped if absent) */
  operationalEventStore?: { record(event: { outcome: string; type?: string; detail?: unknown }): unknown };
  /** Report issue identifier (e.g. "AI-1234") to post summary comment to */
  reportIssueIdentifier?: string;
  /**
   * Resolver: given a label name (e.g. "state:intake"), returns the Linear UUID for that
   * label, or null if not found. When omitted, the sweep fetches team labels at startup
   * to build this mapping automatically. Inject in tests for isolation.
   */
  labelNameToId?: (name: string) => string | null;
  /**
   * Current time in ms since epoch. Defaults to Date.now(). Override in tests to freeze time
   * for grace-window assertions.
   */
  nowMs?: number;
  /**
   * Resolver: given a capability-policy body id (a short agent name, e.g. "cra"), return the
   * Linear user UUID for that body, or null if it cannot be resolved. Defaults to
   * `getLinearUserIdForAgent` from agents.ts. Inject in tests for isolation.
   *
   * AI-1981: the sweep compares candidates against `ticket.delegateId` (a Linear UUID) and
   * passes them straight to `setDelegate` (which requires a UUID). The capability policy keys
   * bodies by short name, so without this translation every role-constrained ticket looks
   * "drifted" and every corrective `setDelegate` is rejected with `delegateId must be a UUID`.
   */
  bodyIdToLinearUserId?: (bodyId: string) => string | null;
}

// ── Internal types ─────────────────────────────────────────────────────────

type WorkflowDef = {
  id?: string;
  entry_state?: string;
  states: Array<{ id: string; owner_role?: string }>;
};

interface PolicyBody {
  id: string;
  fills_roles: string[];
}

interface CapabilityPolicy {
  bodies?: PolicyBody[];
}

interface FetchedTicket extends SweepTicket {
  labelNodes: Array<{ id: string; name: string }>;
  teamId: string;
  /** ISO-8601 timestamp of last modification, used for the rescueMalformed grace window. */
  updatedAt?: string;
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Classify a single ticket from its labels and current delegate.
 *
 * @param labels            Label names on the ticket
 * @param delegateId        Current delegate Linear user ID, or null
 * @param workflowDef       The WorkflowDef for this ticket's wf:* workflow (already resolved)
 * @param roleBodiesForRole Resolver: given a role id, returns the valid delegate identifiers
 *                          for that role — Linear user UUIDs in production (see
 *                          buildRoleResolver), compared directly against `delegateId`.
 */
export function classifyTicket(
  labels: string[],
  delegateId: string | null,
  workflowDef: { entry_state?: string; states: Array<{ id: string; owner_role?: string }> },
  roleBodiesForRole: (roleId: string) => string[],
): TicketClassification {
  const stateLabel = labels.find((l) => l.startsWith("state:"));
  const stateId = stateLabel?.slice("state:".length);

  // Terminal: done or escape — checked first, regardless of delegate
  if (stateId === "done" || stateId === "escape") return "terminal";

  // Malformed: has wf:* but no state:* label
  if (!stateLabel) return "malformed";

  // Dormant: has state:* but no delegate
  if (!delegateId) return "dormant";

  // Check if the delegate fills the state's owner_role
  const stateDef = workflowDef.states.find((s) => s.id === stateId);
  if (!stateDef?.owner_role) return "healthy"; // no role constraint → healthy by default

  const validBodies = roleBodiesForRole(stateDef.owner_role);
  if (validBodies.includes(delegateId)) return "healthy";

  return "drifted";
}

// ── Capability policy loading ──────────────────────────────────────────────

function loadCapabilityPolicy(policyPath: string): CapabilityPolicy | null {
  try {
    const raw = fs.readFileSync(policyPath, "utf8");
    return yaml.load(raw) as CapabilityPolicy;
  } catch {
    return null;
  }
}

/**
 * Build a resolver mapping a role id to the Linear user UUIDs of the bodies that fill it.
 *
 * AI-1981: the capability policy keys bodies by short name (e.g. "cra"), but the sweep
 * compares against `ticket.delegateId` (a Linear UUID) and feeds candidates to `setDelegate`
 * (which requires a UUID). So each body id is translated to its Linear user UUID here — once,
 * at build time — rather than leaking short names into the classifier comparison or the
 * mutation. A body that cannot be resolved falls back to its raw id (so a single unmapped body
 * does not silently shrink a role and mis-classify its correctly-delegated siblings) and is
 * WARN-logged, since delegate mutations for it will fail until the mapping is fixed.
 */
function buildRoleResolver(
  policy: CapabilityPolicy | null,
  bodyIdToLinearUserId: (bodyId: string) => string | null,
): (roleId: string) => string[] {
  if (!policy?.bodies) return () => [];
  const bodies = policy.bodies;

  // Resolve body id → Linear user UUID once. Warn on any unmapped body.
  const resolved = new Map<string, string>();
  for (const b of bodies) {
    const uuid = bodyIdToLinearUserId(b.id);
    if (!uuid) {
      log.warn(
        `rescue-sweep: no Linear user id for body "${b.id}"; falling back to raw id — ` +
          `delegate mutations for this body will fail until it is mapped in agents config`,
      );
    }
    resolved.set(b.id, uuid ?? b.id);
  }

  return (roleId: string) =>
    bodies.filter((b) => b.fills_roles?.includes(roleId)).map((b) => resolved.get(b.id)!);
}

// ── Linear API helpers ─────────────────────────────────────────────────────

async function fetchWfTickets(authToken: string): Promise<FetchedTicket[]> {
  const query = `
    query WorkflowIssues {
      issues(filter: { labels: { some: { name: { startsWith: "wf:" } } } }) {
        nodes {
          id
          identifier
          updatedAt
          state { name }
          labels { nodes { id name } }
          delegate { id name }
          team { id }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query }),
    });
    type IssueNode = {
      id: string;
      identifier: string;
      updatedAt?: string;
      labels: { nodes: Array<{ id: string; name: string }> };
      delegate: { id: string; name: string } | null;
      team: { id: string } | null;
    };
    type Resp = { data?: { issues?: { nodes: IssueNode[] } } };
    const data = (await res.json()) as Resp;
    return (data.data?.issues?.nodes ?? []).map((n) => ({
      id: n.id,
      identifier: n.identifier,
      updatedAt: n.updatedAt,
      labels: n.labels.nodes.map((l) => l.name),
      labelNodes: n.labels.nodes,
      delegateId: n.delegate?.id ?? null,
      delegateName: n.delegate?.name ?? null,
      teamId: n.team?.id ?? "",
    }));
  } catch (err) {
    log.error(`fetchWfTickets failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchTeamLabelMap(teamId: string, authToken: string): Promise<Map<string, string>> {
  const query = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { id name } }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { teamId } }),
    });
    type Resp = { data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } } };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.team?.labels?.nodes ?? [];
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.name, n.id);
    return map;
  } catch (err) {
    log.error(`fetchTeamLabelMap failed for team ${teamId}: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

async function setDelegate(ticketId: string, delegateId: string, authToken: string): Promise<boolean> {
  const mutation = `
    mutation UpdateDelegate($id: String!, $delegateId: String) {
      issueUpdate(id: $id, input: { delegateId: $delegateId }) { success }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { id: ticketId, delegateId } }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } }; errors?: Array<{ message: string }> };
    const data = (await res.json()) as Resp;
    // GraphQL errors come back HTTP 200 with an `errors` array and no data — log them so the
    // per-ticket failure reason (e.g. "delegateId must be a UUID") is visible in journald.
    if (data.errors?.length) {
      log.error(`setDelegate failed for ${ticketId} (delegateId=${delegateId}): ${data.errors.map((e) => e.message).join("; ")}`);
    }
    return data.data?.issueUpdate?.success ?? false;
  } catch (err) {
    log.error(`setDelegate failed for ${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function applyLabelIds(ticketId: string, labelIds: string[], authToken: string): Promise<boolean> {
  const mutation = `
    mutation UpdateLabels($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { id: ticketId, labelIds } }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } }; errors?: Array<{ message: string }> };
    const data = (await res.json()) as Resp;
    if (data.errors?.length) {
      log.error(`applyLabelIds failed for ${ticketId}: ${data.errors.map((e) => e.message).join("; ")}`);
    }
    return data.data?.issueUpdate?.success ?? false;
  } catch (err) {
    log.error(`applyLabelIds failed for ${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Main sweep ─────────────────────────────────────────────────────────────

/**
 * Run a full rescue sweep against Linear.
 *
 * Enumerates all wf:* tickets, classifies each, and rescues broken ones.
 * Terminal tickets are silently skipped. Healthy tickets are never touched.
 * Idempotent: a ticket already in the correct shape is classified healthy
 * and left alone. Within a single sweep, a rescued ticket is not re-processed.
 */
export async function runRescueSweep(options: RescueSweepOptions): Promise<RescueSweepResult> {
  const {
    authToken,
    workflowRegistry = new Map<string, WorkflowDef>(),
    capabilityPolicyPath,
    operationalEventStore,
    labelNameToId: injectedLabelNameToId,
    nowMs,
    bodyIdToLinearUserId = (id: string) => getLinearUserIdForAgent(id) ?? null,
  } = options;

  const graceMsRaw = parseInt(process.env.RESCUE_MALFORMED_GRACE_MS ?? "300000", 10);
  const graceMs = isNaN(graceMsRaw) ? 300000 : graceMsRaw;
  const effectiveNow = nowMs ?? Date.now();

  const errors: string[] = [];
  const rescues: RescueAction[] = [];
  const byClassification: Partial<Record<TicketClassification, number>> = {};
  const rescuedIds = new Set<string>(); // idempotency guard within this sweep

  // Nothing to do if no workflows are registered
  if (workflowRegistry.size === 0) {
    return { scanned: 0, rescued: 0, byClassification: {}, rescues: [], errors: [] };
  }

  // Load capability policy and build role resolver
  const resolvedPolicyPath =
    capabilityPolicyPath ??
    process.env.CAPABILITY_POLICY_PATH ??
    defaultCapabilityPolicyPath();
  const policy = loadCapabilityPolicy(resolvedPolicyPath);
  const roleBodiesForRole = buildRoleResolver(policy, bodyIdToLinearUserId);

  // Fetch all wf:* tickets
  let rawTickets: FetchedTicket[] = [];
  try {
    rawTickets = await fetchWfTickets(authToken);
  } catch (err) {
    errors.push(`fetchWfTickets error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Deduplicate by ID (idempotency: same ticket may appear multiple times from pagination)
  const seenIds = new Set<string>();
  const tickets: FetchedTicket[] = [];
  for (const t of rawTickets) {
    if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      tickets.push(t);
    }
  }

  // Build label name → UUID resolver. Use injected resolver if provided (tests); otherwise
  // fetch team labels once per unique team so rescueMalformed can pass real UUIDs to labelIds.
  let labelNameToId: (name: string) => string | null;
  if (injectedLabelNameToId) {
    labelNameToId = injectedLabelNameToId;
  } else {
    const labelMap = new Map<string, string>();
    const teamIds = [...new Set(tickets.map((t) => t.teamId).filter(Boolean))];
    for (const teamId of teamIds) {
      const teamMap = await fetchTeamLabelMap(teamId, authToken);
      for (const [name, id] of teamMap) labelMap.set(name, id);
    }
    labelNameToId = (name: string) => labelMap.get(name) ?? null;
  }

  for (const ticket of tickets) {
    // Resolve workflow def from the wf:* label
    const wfLabel = ticket.labels.find((l) => l.startsWith("wf:"));
    const wfId = wfLabel?.slice("wf:".length);

    if (!wfId || !workflowRegistry.has(wfId)) {
      const desc = wfLabel ?? "(no wf: label)";
      errors.push(`unknown workflow for ticket ${ticket.identifier}: ${desc}`);
      byClassification["malformed"] = (byClassification["malformed"] ?? 0) + 1;
      continue;
    }

    const wfDef = workflowRegistry.get(wfId)!;
    const classification = classifyTicket(ticket.labels, ticket.delegateId, wfDef, roleBodiesForRole);
    byClassification[classification] = (byClassification[classification] ?? 0) + 1;

    // Terminal and healthy tickets need no rescue
    if (classification === "terminal" || classification === "healthy") continue;

    // Within-sweep idempotency: skip if already rescued this run
    if (rescuedIds.has(ticket.id)) continue;

    let rescueAction: RescueAction;

    if (classification === "malformed") {
      // Grace window: skip tickets modified very recently — they may be mid-repair by a steward
      // who cleared the old state:* label but hasn't written the new one yet.
      if (ticket.updatedAt) {
        const ageMs = effectiveNow - new Date(ticket.updatedAt).getTime();
        if (ageMs < graceMs) {
          log.info(
            `rescueMalformed: deferring ${ticket.identifier} — modified ${Math.floor(ageMs / 1000)}s ago, within grace window (${graceMs}ms); will retry on next sweep`,
          );
          continue;
        }
      }
      rescueAction = await rescueMalformed(ticket, wfDef, roleBodiesForRole, labelNameToId, authToken);
    } else if (classification === "dormant") {
      rescueAction = await rescueDormant(ticket, wfDef, roleBodiesForRole, authToken);
    } else {
      // drifted
      rescueAction = await rescueDrifted(ticket, wfDef, roleBodiesForRole, authToken);
    }

    rescues.push(rescueAction);

    if (rescueAction.outcome === "rescued") {
      rescuedIds.add(ticket.id);
    }

    // Emit operational event for all outcomes — failed rescues are pillar-1 violations
    if (rescueAction.outcome === "rescued" || rescueAction.outcome === "ambiguous" || rescueAction.outcome === "failed") {
      operationalEventStore?.record({
        outcome: `rescue:${rescueAction.outcome}`,
        type: "rescue",
        detail: {
          ticketId: ticket.id,
          identifier: ticket.identifier,
          classification,
          action: rescueAction.action,
        },
      });
    }
  }

  return {
    scanned: tickets.length,
    rescued: rescues.filter((r) => r.outcome === "rescued").length,
    byClassification,
    rescues,
    errors,
  };
}

// ── Rescue helpers ─────────────────────────────────────────────────────────

async function rescueMalformed(
  ticket: FetchedTicket,
  wfDef: WorkflowDef,
  roleBodiesForRole: (roleId: string) => string[],
  labelNameToId: (name: string) => string | null,
  authToken: string,
): Promise<RescueAction> {
  const entryState = wfDef.entry_state ?? wfDef.states[0]?.id ?? "intake";
  const entryStateDef = wfDef.states.find((s) => s.id === entryState);
  const ownerRole = entryStateDef?.owner_role;
  const candidates = ownerRole ? roleBodiesForRole(ownerRole) : [];

  // Resolve the state label to its Linear UUID (required — labelIds must be UUIDs, not names)
  const stateLabelName = `state:${entryState}`;
  const stateLabelUuid = labelNameToId(stateLabelName);
  if (!stateLabelUuid) {
    log.error(`rescueMalformed: could not resolve UUID for label ${stateLabelName} on ticket ${ticket.identifier}`);
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "malformed",
      action: `bootstrap: could not resolve UUID for label ${stateLabelName}`,
      outcome: "failed",
    };
  }

  const existingIds = ticket.labelNodes.map((n) => n.id);
  const labelOk = await applyLabelIds(ticket.id, [...existingIds, stateLabelUuid], authToken);

  let outcome: "rescued" | "failed" | "ambiguous";
  let actionDesc: string;

  if (candidates.length === 1) {
    const delegateOk = await setDelegate(ticket.id, candidates[0], authToken);
    outcome = labelOk && delegateOk ? "rescued" : "failed";
    actionDesc = `bootstrap: applied state:${entryState} (entry state) label and delegated to ${candidates[0]}`;
  } else if (candidates.length > 1) {
    // Label applied, but delegate is ambiguous
    outcome = "ambiguous";
    actionDesc = `bootstrap: applied state:${entryState} (entry state) label; delegate ambiguous (${candidates.length} candidates for ${ownerRole})`;
  } else {
    // No candidates — label applied, no delegate
    outcome = labelOk ? "rescued" : "failed";
    actionDesc = `bootstrap: applied state:${entryState} (entry state) label; no delegate candidates for role ${ownerRole ?? "(unknown)"}`;
  }

  return {
    ticketId: ticket.id,
    identifier: ticket.identifier,
    classification: "malformed",
    action: actionDesc,
    outcome,
  };
}

async function rescueDormant(
  ticket: FetchedTicket,
  wfDef: WorkflowDef,
  roleBodiesForRole: (roleId: string) => string[],
  authToken: string,
): Promise<RescueAction> {
  const stateId = ticket.labels.find((l) => l.startsWith("state:"))?.slice("state:".length);
  const stateDef = stateId ? wfDef.states.find((s) => s.id === stateId) : undefined;
  const ownerRole = stateDef?.owner_role;
  const candidates = ownerRole ? roleBodiesForRole(ownerRole) : [];

  if (candidates.length === 1) {
    const ok = await setDelegate(ticket.id, candidates[0], authToken);
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "dormant",
      action: `delegated to ${candidates[0]} (fills ${ownerRole})`,
      outcome: ok ? "rescued" : "failed",
    };
  } else if (candidates.length > 1) {
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "dormant",
      action: `ambiguous delegation: ${candidates.length} bodies fill ${ownerRole}; manual review required`,
      outcome: "ambiguous",
    };
  } else {
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "dormant",
      action: `no delegate candidates found for role ${ownerRole ?? "(unknown)"}`,
      outcome: "failed",
    };
  }
}

async function rescueDrifted(
  ticket: FetchedTicket,
  wfDef: WorkflowDef,
  roleBodiesForRole: (roleId: string) => string[],
  authToken: string,
): Promise<RescueAction> {
  const stateId = ticket.labels.find((l) => l.startsWith("state:"))?.slice("state:".length);
  const stateDef = stateId ? wfDef.states.find((s) => s.id === stateId) : undefined;
  const ownerRole = stateDef?.owner_role;
  const candidates = ownerRole ? roleBodiesForRole(ownerRole) : [];

  if (candidates.length === 1) {
    const ok = await setDelegate(ticket.id, candidates[0], authToken);
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "drifted",
      action: `re-delegated to ${candidates[0]} (fills ${ownerRole}); was ${ticket.delegateId}`,
      outcome: ok ? "rescued" : "failed",
    };
  } else if (candidates.length > 1) {
    // Multiple candidates → ambiguous, do not auto-assign
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "drifted",
      action: `ambiguous: ${candidates.length} bodies fill ${ownerRole ?? "(unknown role)"}; manual review required`,
      outcome: "ambiguous",
    };
  } else {
    // No candidates → cannot resolve delegate
    return {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      classification: "drifted",
      action: `no delegate candidates found for role ${ownerRole ?? "(unknown)"}`,
      outcome: "failed",
    };
  }
}
