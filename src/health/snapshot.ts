/**
 * INF-322 / INF-356 — Aggregate health snapshot endpoint.
 *
 * Provides GET /health/snapshot returning per-task health entries for all
 * tracked tasks (pickup/completion gates), backed by live Linear issue input,
 * liveness-channel observations, contract evaluation, failure classification,
 * and remediation policy output.
 *
 * Liveness is surfaced at /health as healthSnapshot.active === true, proving
 * the route is wired at bootstrap without waiting for a health event.
 */

import { Router, Request, Response } from "express";
import { getAgents } from "../agents.js";
import { LINEAR_API_URL } from "../linear-helpers.js";
import type { LivenessChannelEndpoint, LivenessSnapshot } from "../liveness-channel/index.js";
import { ContractEngine } from "./index.js";
import { classifyFailure, type FailureClass as ClassifiedFailureClass } from "./failure-classifier.js";
import type { HealthVerdict, LivenessSignal } from "./health-types.js";
import { executeRemediation } from "../remediation/remediation-actor.js";
import { getRemediationHistory, recordRemediation } from "../remediation/remediation-state.js";
import type { FailureClass as RemediationFailureClass } from "../remediation/remediation-types.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type Gate = "pickup" | "completion";

export interface ExpectedSignal {
  type: string;
  deadline: string; // ISO timestamp
}

export interface ActualObserved {
  signal: string | null;
  at: string | null; // ISO timestamp
}

export type HealthStatus =
  | "healthy"
  | "healthy-suppressed"
  | "unhealthy"
  | "HEALTHY"
  | "HEALTHY_SUPPRESSED"
  | "UNHEALTHY";

export interface Remediation {
  action: string | null;
  status: string | null;
  class?: string | null;
}

export interface HealthSnapshotTask {
  ticket_id?: string;
  title?: string;
  workflow?: string | null;
  delegate?: string | null;
  gate: Gate;
  expectedSignal: ExpectedSignal;
  actualObserved: ActualObserved;
  actual?: Record<string, unknown>;
  health: HealthStatus;
  healthDetail?: string;
  failureClass: string | null;
  failure_class?: string | null;
  remediation: Remediation;
}

export interface HealthSnapshotResponse {
  tasks: HealthSnapshotTask[];
  generatedAt: string; // ISO timestamp
  status?: "healthy" | "degraded" | "empty" | "pipeline-error";
  trackedTaskCount?: number | null;
  error?: string | null;
  pipeline?: {
    producing: boolean;
    source: "linear-live";
    error: string | null;
  };
}

export interface HealthSnapshotLiveness {
  active: boolean;
}

// ── In-memory state ─────────────────────────────────────────────────────────

let active = false;

/** Mark the snapshot endpoint as wired (called at bootstrap). */
export function registerSnapshot(): void {
  active = true;
}

export function getSnapshotLiveness(): HealthSnapshotLiveness {
  return { active };
}

/** Reset for test isolation. */
export function resetSnapshotState(): void {
  active = false;
}

// ── Route factory ───────────────────────────────────────────────────────────

interface LinearIssueNode {
  id: string;
  identifier: string;
  title?: string;
  updatedAt?: string;
  state?: { name?: string | null; type?: string | null } | null;
  delegate?: { id?: string | null; name?: string | null } | null;
  assignee?: { id?: string | null; name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null }> } | null;
}

interface CreateHealthSnapshotRouterOptions {
  livenessEndpoint?: Pick<LivenessChannelEndpoint, "snapshotForTicket">;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const TRACKED_ISSUES_QUERY = `
  query ConnectorHealthTrackedIssues($after: String) {
    issues(first: 100, after: $after) {
      nodes {
        id
        identifier
        title
        updatedAt
        state { name type }
        delegate { id name }
        assignee { id name }
        labels { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function linearAuthorization(): string | null {
  const token = process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? null;
  if (!token) return null;
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function agentNameByLinearId(): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of getAgents()) {
    if (agent.linearUserId) map.set(agent.linearUserId, agent.openclawAgent ?? agent.name);
  }
  return map;
}

function trackedAgentIds(): Set<string> {
  return new Set(getAgents().map((agent) => agent.linearUserId).filter(Boolean));
}

async function fetchTrackedIssues(fetchFn: typeof fetch): Promise<LinearIssueNode[]> {
  const authorization = linearAuthorization();
  if (!authorization) {
    if (process.env.NODE_ENV === "test") return [];
    throw new Error("Linear auth token unavailable");
  }

  const trackedIds = trackedAgentIds();
  const issues: LinearIssueNode[] = [];
  let after: string | null = null;
  do {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({ query: TRACKED_ISSUES_QUERY, variables: { after } }),
    });
    if (!res.ok) {
      throw new Error(`Linear GraphQL HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: { issues?: { nodes?: LinearIssueNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
      errors?: unknown;
    };
    if (json.errors) {
      throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    const page = json.data?.issues;
    for (const issue of page?.nodes ?? []) {
      const ownerId = issue.delegate?.id ?? issue.assignee?.id ?? null;
      if (trackedIds.size === 0 || (ownerId && trackedIds.has(ownerId))) {
        issues.push(issue);
      }
    }
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor ?? null : null;
  } while (after);
  return issues;
}

function workflowFromIssue(issue: LinearIssueNode): string | null {
  const label = issue.labels?.nodes?.find((node) => node.name?.startsWith("wf:"))?.name;
  return label ? label.slice("wf:".length) : null;
}

function deadlineIso(gateEnteredAt: number, deadlineMs: number): string {
  return new Date(gateEnteredAt + deadlineMs).toISOString();
}

function dispatchTimestamp(snapshot: LivenessSnapshot): number | null {
  const raw = snapshot.dispatch.ackedAt ?? snapshot.dispatch.createdAt;
  return raw ? Date.parse(raw) : null;
}

function signalsFromSnapshot(snapshot: LivenessSnapshot, gateEnteredAt: number): LivenessSignal[] {
  const signals: LivenessSignal[] = [];
  const dispatchAt = dispatchTimestamp(snapshot);
  if (snapshot.dispatch.acknowledged) {
    signals.push({
      type: "dispatch-ack",
      timestamp: dispatchAt ?? gateEnteredAt,
      detail: snapshot.dispatch.ack ? { ...snapshot.dispatch.ack } : undefined,
    });
  }
  if (snapshot.sessionHealth.healthy && snapshot.turnLiveness.active) {
    signals.push({
      type: "session-health",
      timestamp: gateEnteredAt,
      detail: { signalType: "Thinking", healthy: true },
    });
    signals.push({
      type: "turn-liveness",
      timestamp: gateEnteredAt,
      detail: { active: true },
    });
  }
  return signals;
}

function publicHealth(status: HealthVerdict["status"]): HealthStatus {
  if (status === "healthy") return "healthy";
  if (status.startsWith("healthy-suppressed")) return "healthy-suppressed";
  return "unhealthy";
}

function uiHealth(status: HealthStatus): "HEALTHY" | "HEALTHY_SUPPRESSED" | "UNHEALTHY" {
  if (status === "healthy") return "HEALTHY";
  if (status === "healthy-suppressed") return "HEALTHY_SUPPRESSED";
  return "UNHEALTHY";
}

function toRemediationFailureClass(
  failureClass: ClassifiedFailureClass,
): RemediationFailureClass {
  if (failureClass.startsWith("healthy-suppressed-")) {
    return { type: "healthy-suppressed", subtype: failureClass.slice("healthy-suppressed-".length) };
  }
  if (failureClass === "verb-not-sent") {
    return { type: "verb-not-sent", hasSideEffectEvidence: false };
  }
  return { type: failureClass } as RemediationFailureClass;
}

async function remediationFor(
  issue: LinearIssueNode,
  agentId: string,
  snapshot: LivenessSnapshot,
  failureClass: ClassifiedFailureClass | null,
  isFailure: boolean,
  now: () => Date,
): Promise<Remediation> {
  if (!failureClass || !isFailure) {
    return { action: null, class: null, status: "not-needed" };
  }
  const history = getRemediationHistory(issue.identifier);
  const result = await executeRemediation(toRemediationFailureClass(failureClass), {
    ticketId: issue.identifier,
    agentId,
    sessionKey: snapshot.dispatch.sessionKey ?? issue.identifier,
    attemptCount: history.length,
    maxRetries: 3,
    now,
  });
  recordRemediation(result);
  return {
    action: result.action.kind,
    class: result.actionClass,
    status: result.outcome,
  };
}

function actualFromSnapshot(snapshot: LivenessSnapshot): Record<string, unknown> {
  return {
    dispatch: {
      hasRecord: snapshot.dispatch.hasRecord,
      sent: snapshot.dispatch.sent,
      acknowledged: snapshot.dispatch.acknowledged,
      status: snapshot.dispatch.status,
      dispatchId: snapshot.dispatch.dispatchId,
      agentId: snapshot.dispatch.agentId,
      sessionKey: snapshot.dispatch.sessionKey,
    },
    dispatch_ack: snapshot.dispatch.ack,
    session: snapshot.sessionHealth,
    turn: snapshot.turnLiveness,
  };
}

function withTicketSessionHealth(snapshot: LivenessSnapshot): LivenessSnapshot {
  const activeKeys = snapshot.sessionHealth.activeSessionKeys ?? [];
  const expectedSessionKey = snapshot.dispatch.sessionKey ?? snapshot.turnLiveness.sessionKey ?? snapshot.ticketId;
  const healthyForTicket =
    snapshot.turnLiveness.active ||
    snapshot.turnLiveness.hasInFlightTurn ||
    snapshot.turnLiveness.hasRunningSubagent ||
    activeKeys.includes(expectedSessionKey);

  return {
    ...snapshot,
    sessionHealth: healthyForTicket
      ? { ...snapshot.sessionHealth, healthy: true }
      : {
          healthy: false,
          reason: "no active runtime session",
          activeSessionKeys: snapshot.sessionHealth.activeSessionKeys,
        },
  };
}

async function taskFromIssue(
  issue: LinearIssueNode,
  options: Required<Pick<CreateHealthSnapshotRouterOptions, "now">> & Pick<CreateHealthSnapshotRouterOptions, "livenessEndpoint">,
  engine: ContractEngine,
  agentMap: Map<string, string>,
): Promise<HealthSnapshotTask> {
  const agentId = agentMap.get(issue.delegate?.id ?? issue.assignee?.id ?? "") ?? issue.delegate?.name ?? issue.assignee?.name ?? "unknown";
  const rawSnapshot = options.livenessEndpoint?.snapshotForTicket(issue.identifier) ?? {
    ticketId: issue.identifier,
    timestamp: options.now().toISOString(),
    dispatch: { sent: false, acknowledged: false, hasRecord: false, ack: null },
    sessionHealth: { healthy: false, reason: "liveness endpoint unavailable" },
    turnLiveness: { active: false, hasInFlightTurn: false, hasRunningSubagent: false, sessionKey: issue.identifier },
  };
  const snapshot = withTicketSessionHealth(rawSnapshot);
  const gateEnteredAt = Date.parse(issue.updatedAt ?? "") || Date.parse(snapshot.timestamp);
  const signals = signalsFromSnapshot(snapshot, gateEnteredAt);
  const result = engine.evaluate("dispatched", {
    gateEnteredAt,
    signals,
    hasActiveTurn: snapshot.turnLiveness.active,
    queueDepth: snapshot.dispatch.ack?.status === "queued" ? snapshot.dispatch.ack.queue_depth ?? 1 : 0,
  });
  const publicStatus = publicHealth(result.verdict.status);
  const failure = result.verdict.breached ? classifyFailure(result.verdict, snapshot) : null;
  const failureClass = failure?.isFailure ? failure.failureClass : null;
  const remediation = await remediationFor(issue, agentId, snapshot, failureClass, Boolean(failure?.isFailure), options.now);

  const actual = actualFromSnapshot(snapshot);
  return {
    ticket_id: issue.identifier,
    title: issue.title,
    workflow: workflowFromIssue(issue),
    delegate: agentId,
    gate: "pickup",
    expectedSignal: {
      type: result.verdict.expectedSignal,
      deadline: deadlineIso(gateEnteredAt, result.verdict.deadlineMs),
    },
    actualObserved: {
      signal: signals[0]?.type ?? null,
      at: signals[0] ? new Date(signals[0].timestamp).toISOString() : null,
    },
    actual,
    health: uiHealth(publicStatus),
    healthDetail: result.verdict.detail,
    failureClass,
    failure_class: failureClass,
    remediation,
  };
}

export function createHealthSnapshotRouter(options: CreateHealthSnapshotRouterOptions = {}): Router {
  const router = Router();
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const engine = new ContractEngine();

  /**
   * GET /health/snapshot
   *
   * Returns the aggregate health snapshot of all tracked tasks. Each entry
   * describes one gate (pickup or completion) with its expected signal,
   * actual observation, derived health status, failure classification, and
   * active remediation.
   *
   * When no tasks are tracked (healthy/empty state), returns an empty array.
   */
  router.get("/snapshot", async (_req: Request, res: Response) => {
    const generatedAt = now().toISOString();
    try {
      const issues = await fetchTrackedIssues(fetchFn);
      const agentMap = agentNameByLinearId();
      const tasks = await Promise.all(
        issues.map((issue) => taskFromIssue(issue, { livenessEndpoint: options.livenessEndpoint, now }, engine, agentMap)),
      );
      const hasUnhealthy = tasks.some((task) => task.health === "UNHEALTHY");
      const response: HealthSnapshotResponse = {
        generatedAt,
        status: issues.length === 0 ? "empty" : hasUnhealthy ? "degraded" : "healthy",
        trackedTaskCount: issues.length,
        pipeline: { producing: true, source: "linear-live", error: null },
        tasks,
      };
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: HealthSnapshotResponse = {
        generatedAt,
        status: "pipeline-error",
        trackedTaskCount: null,
        error: message,
        pipeline: { producing: false, source: "linear-live", error: message },
        tasks: [],
      };
      res.status(503).json(response);
    }
  });

  return router;
}
