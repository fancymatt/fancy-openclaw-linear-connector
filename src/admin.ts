import express, { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { getAgents, getAccessToken, type AgentConfig } from "./agents.js";
import type { AgentQueue } from "./queue/index.js";
import type { PendingWorkBag, BagEntry } from "./bag/index.js";
import type { SessionTracker } from "./bag/index.js";
import type { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";
import type { OperationalEventStore, OperationalEventOutcome } from "./store/operational-event-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import type { ObservationStore, ReasonCode } from "./store/observation-store.js";
import { aggregateDigest, formatDigestSummary } from "./bag/stale-session-forensics.js";
import { tryNormalizeSessionKey } from "./session-key.js";
import { setStateAtomic, loadWorkflowRegistry } from "./workflow-gate.js";
import { parseSlaToMs } from "./barrier.js";
import { computeDispatchHealth } from "./dispatch-health.js";
import type { DispatchAckEntry } from "./bag/dispatch-ack-tracker.js";
import { recaptureAc } from "./ac-record-store.js";
import { getStatus as getConfigHealthStatus } from "./config-health.js";
import { getRegistryPolicyStatus } from "./registry-policy.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./bag/wake-up.js";
import { getAlertBus } from "./alerts/alert-bus.js";
import type { AlertSeverity } from "./alerts/alert-store.js";
import {
  mintSessionToken,
  verifySessionToken,
  sessionTokenFromRequest,
  setSessionCookie,
  clearSessionCookie,
  LoginRateLimiter,
} from "./admin-session.js";
import { mountStreamRoute } from "./admin-stream.js";

interface AdminDeps {
  agentQueue: AgentQueue;
  bag: PendingWorkBag;
  sessionTracker: SessionTracker;
  operationalEventStore?: OperationalEventStore;
  observationStore?: ObservationStore;
  ackTracker?: DispatchAckTracker;
  deploymentName: string;
  /** AI-1799: enrolled-tickets mirror for the /api/board endpoint. */
  enrolledTicketsStore?: EnrolledTicketsStore;
  /** If provided, set-state will re-dispatch to the new state's owner role (AI-1607). */
  wakeConfigForAgent?: (agentId: string) => WakeUpConfig;
  /** Override the SPA asset directory (tests). */
  webDistDir?: string;
}

type Severity = "green" | "yellow" | "red" | "gray";

interface AttentionItem {
  severity: Exclude<Severity, "green">;
  title: string;
  message: string;
  href?: string;
}

function bool(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : Boolean(value);
}

function ageLabel(value?: string | number | null): string {
  if (!value) return "No timestamp";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown age";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Render a last event as prose from an enrolled-ticket row. */
function renderEventProse(row: { last_event_kind: string | null; delegate: string | null; last_event_at: string | null }): string {
  const kind = row.last_event_kind ?? 'enrolled';
  const who = row.delegate ?? 'system';
  const when = row.last_event_at ? ageLabel(row.last_event_at) : 'recently';
  const verbs: Record<string, string> = {
    enroll: 'enrolled',
    accept: 'accepted the ticket',
    tests_ready: 'marked tests ready',
    'tests-ready': 'marked tests ready',
    submit: 'submitted for review',
    approve: 'approved',
    'request-changes': 'requested changes',
    deploy: 'deployed',
    'host-deployed': 'host-deployed',
    validated: 'validated and closed',
    'ac-fail': 'AC validation failed',
    complete: 'completed',
    demoted: 'demoted from workflow',
    reconciled: 'state reconciled',
  };
  const verb = verbs[kind] ?? kind;
  return `${capitalize(who)} ${verb}, ${when}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function slugId(value: unknown): string {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

function agentAnchor(agentName: string): string {
  return `agent-${slugId(agentName)}`;
}

function oauthAnchor(agentName: string): string {
  return `oauth-${slugId(agentName)}`;
}

function taskAnchor(sessionKey: string): string {
  return `task-${slugId(sessionKey)}`;
}

function eventTitle(event: LinearEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return `${event.type} ${event.action}`;
  const issue = data.issue as { identifier?: string; title?: string } | undefined;
  const identifier = typeof data.identifier === "string" ? data.identifier : issue?.identifier;
  const title = typeof data.title === "string" ? data.title : issue?.title;
  return [identifier, title].filter(Boolean).join(" — ") || `${event.type} ${event.action}`;
}

function eventUrl(event: LinearEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  return typeof data?.url === "string" ? data.url : undefined;
}

function safeAgent(agent: AgentConfig, queueStat?: { active: boolean; queueDepth: number }, pendingCount = 0, activeSessionKey?: string | null) {
  const credentialComplete = bool(agent.clientId) && bool(agent.clientSecret) && bool(agent.accessToken) && bool(agent.refreshToken);
  const oauthState = credentialComplete ? "configured" : "setup needed";
  const severity: Severity = !bool(agent.linearUserId) || !credentialComplete
    ? "red"
    : pendingCount > 0 || queueStat?.active || (queueStat?.queueDepth ?? 0) > 0
      ? "yellow"
      : "green";

  return {
    name: agent.name,
    openclawAgent: agent.openclawAgent ?? agent.name,
    linearUserId: agent.linearUserId ? `…${agent.linearUserId.slice(-8)}` : "Not mapped",
    host: agent.host ?? "local",
    identityMapped: bool(agent.linearUserId),
    credentialState: oauthState,
    oauthConfigured: credentialComplete,
    activity: activeSessionKey ? "Active session" : pendingCount > 0 ? "Pending work" : queueStat?.active ? "Queue active" : "Idle",
    pendingCount,
    active: queueStat?.active ?? false,
    queueDepth: queueStat?.queueDepth ?? 0,
    activeSessionKey,
    lastSuccess: "No success telemetry yet",
    lastError: credentialComplete ? "No error telemetry yet" : "OAuth credentials incomplete",
    nextExpectedTask: pendingCount > 0 ? "Pick up pending Linear work" : queueStat?.queueDepth ? "Drain queued task" : "Wait for Linear delegation/comment",
    severity,
    diagnostics: {
      hasClientId: bool(agent.clientId),
      hasClientSecret: bool(agent.clientSecret),
      hasAccessToken: bool(agent.accessToken),
      hasRefreshToken: bool(agent.refreshToken),
      hasSecretsPath: bool(agent.secretsPath),
      openclawAgent: agent.openclawAgent ?? agent.name,
      host: agent.host ?? "local",
    },
  };
}

function safeTaskFromRoute(route: RouteResult, state: "active" | "pending" | "queued" | "failed" | "completed", updatedAt?: string) {
  const url = eventUrl(route.event);
  return {
    owner: route.agentId,
    agent: route.agentId,
    state,
    severity: state === "failed" ? "red" : state === "pending" || state === "queued" ? "yellow" : state === "completed" ? "green" : "gray",
    sessionKey: route.sessionKey,
    priority: route.priority,
    related: eventTitle(route.event),
    relatedUrl: url,
    eventType: route.event.type,
    action: route.event.action,
    lifecycle: route.routingReason ? `Routed by ${route.routingReason}` : "Routed by connector",
    age: ageLabel(route.event.createdAt),
    updated: updatedAt ?? route.event.createdAt,
    safeError: state === "failed" ? "Delivery failed. Check connector logs and target agent availability." : undefined,
    diagnostics: {
      routingReason: route.routingReason ?? "unknown",
      coalescedCount: route.coalescedCount ?? 0,
      eventCreatedAt: route.event.createdAt,
      actorName: route.event.actor?.name ?? "Unknown actor",
      eventType: route.event.type,
      action: route.event.action,
    },
  };
}

function safeTaskFromBag(entry: BagEntry) {
  return {
    owner: entry.agentId,
    agent: entry.agentId,
    state: "pending",
    severity: "yellow",
    sessionKey: entry.ticketId,
    priority: 0,
    related: entry.ticketId,
    relatedUrl: undefined,
    eventType: entry.eventType || "Linear event",
    action: "pending",
    lifecycle: "Waiting for agent pickup from pending work bag",
    age: ageLabel(entry.createdAt),
    updated: entry.updatedAt,
    safeError: undefined,
    diagnostics: {
      eventType: entry.eventType,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
  };
}

function buildDashboard(deps: AdminDeps) {
  const agents = getAgents();
  const queueStats = deps.agentQueue.getStats();
  const pendingStats = deps.bag.getAgentStats();
  const activeAgents = deps.sessionTracker.getActiveAgents();
  const agentRows = agents.map((agent) => {
    const openclawAgent = agent.openclawAgent ?? agent.name;
    const row = safeAgent(
      agent,
      queueStats.find((s) => s.agentId === agent.name || s.agentId === openclawAgent),
      pendingStats.find((s) => s.agentId === agent.name || s.agentId === openclawAgent)?.pendingCount ?? 0,
      deps.sessionTracker.getActiveSessionKey(agent.name) ?? deps.sessionTracker.getActiveSessionKey(openclawAgent),
    );
    const snapshot = deps.operationalEventStore?.snapshot({ agent: openclawAgent, limit: 25 });
    return {
      ...row,
      lastSuccess: snapshot?.lastSuccess ? `${snapshot.lastSuccess.outcome} ${ageLabel(snapshot.lastSuccess.occurredAt)}` : row.lastSuccess,
      lastError: snapshot?.lastError ? `${snapshot.lastError.outcome}: ${snapshot.lastError.errorSummary ?? ageLabel(snapshot.lastError.occurredAt)}` : row.lastError,
    };
  });

  const agentIds = (agent: AgentConfig) => [...new Set([agent.name, agent.openclawAgent ?? agent.name])];
  const pendingTasks = agents.flatMap((agent) => agentIds(agent).flatMap((id) => deps.bag.getPendingTickets(id).map(safeTaskFromBag)));
  const queueTasks = agents.flatMap((agent) => agentIds(agent).flatMap((id) => {
    const active = deps.agentQueue.getActive(id);
    return [
      ...(active ? [safeTaskFromRoute(active, "active")] : []),
      ...deps.agentQueue.getQueued(id).map((route) => safeTaskFromRoute(route, "queued")),
    ];
  }));
  const tasks = [...pendingTasks, ...queueTasks];

  const attention: AttentionItem[] = [];
  if (agents.length === 0) {
    attention.push({ severity: "red", title: "No agents configured", message: "Add OAuth agent mappings before webhook delivery can route work.", href: "/admin/settings" });
  }
  for (const agent of agentRows) {
    if (!agent.identityMapped || !agent.oauthConfigured) {
      attention.push({ severity: "red", title: `${agent.name} setup incomplete`, message: "Identity mapping or OAuth credentials are missing. Secrets are hidden; use the onboarding flow to repair setup.", href: `/admin/settings#${oauthAnchor(agent.name)}` });
    } else if (agent.pendingCount > 0 || agent.queueDepth > 0) {
      const specificTask = tasks.find((task) => task.agent === agent.name || task.owner === agent.name || task.agent === agent.openclawAgent || task.owner === agent.openclawAgent);
      attention.push({ severity: "yellow", title: `${agent.name} has work waiting`, message: `${agent.pendingCount + agent.queueDepth} pending/queued item(s) need agent pickup or session completion.`, href: specificTask ? `/admin/tasks#${taskAnchor(specificTask.sessionKey)}` : `/admin/agents#${agentAnchor(agent.name)}` });
    }
  }

  const bagStats = deps.bag.getStats();
  return {
    generatedAt: new Date().toISOString(),
    deployment: deps.deploymentName,
    attention,
    status: {
      service: "fancy-openclaw-linear-connector",
      severity: attention.some((i) => i.severity === "red") ? "red" : attention.length ? "yellow" : "green",
      agentsConfigured: agents.length,
      activeSessions: activeAgents.length,
      pendingBagSize: bagStats.bagSize,
      eventsReceived: bagStats.eventsReceived,
      signalsSent: bagStats.signalsSent,
    },
    agents: agentRows,
    tasks,
    events: deps.operationalEventStore?.query({ limit: 50 }) ?? [],
    settings: {
      effectiveConfig: {
        deployment: deps.deploymentName,
        port: process.env.PORT ?? "3000",
        dataDir: process.env.DATA_DIR ?? "./data",
        webhookSecretConfigured: bool(process.env.LINEAR_WEBHOOK_SECRET),
        sessionEndSecretConfigured: bool(process.env.SESSION_END_SECRET),
        metricsSecretConfigured: bool(process.env.METRICS_SECRET ?? process.env.SESSION_END_SECRET),
        hooksUrlConfigured: bool(process.env.OPENCLAW_HOOKS_URL),
        hooksTokenConfigured: bool(process.env.OPENCLAW_HOOKS_TOKEN),
        hooksModel: process.env.OPENCLAW_HOOKS_MODEL ?? "default",
        hooksThinking: process.env.OPENCLAW_HOOKS_THINKING ?? "default",
      },
      workspaceTeamMappings: agents.map((agent) => ({
        agent: agent.name,
        linearUserId: agent.linearUserId ? `…${agent.linearUserId.slice(-8)}` : "Not mapped",
        openclawAgent: agent.openclawAgent ?? agent.name,
        host: agent.host ?? "local",
      })),
      agentMappings: agentRows.map((agent) => ({
        name: agent.name,
        openclawAgent: agent.openclawAgent,
        identityMapped: agent.identityMapped,
        credentialState: agent.credentialState,
      })),
      oauthSetup: agentRows.map((agent) => ({
        agent: agent.name,
        state: agent.credentialState,
        safeNote: agent.oauthConfigured ? "Tokens present; values hidden." : "Run OAuth onboarding; token values are never displayed here.",
      })),
      restartRequiredFlags: [
        { name: "Environment changes", required: true, note: "Changes to env vars require service restart." },
        { name: "agents.json changes", required: false, note: "Watched and hot-reloaded when possible." },
      ],
    },
  };
}

function timingSafeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function secretFromBasicAuthorization(authorization: string): string | null {
  const encoded = authorization.slice("Basic ".length).trim();
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
}

function adminSecretFromRequest(req: Request): string | null {
  const header = req.headers["x-admin-secret"];
  if (typeof header === "string") return header;
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  if (authorization?.startsWith("Basic ")) return secretFromBasicAuthorization(authorization);
  return null;
}

/** True when the request carries valid admin credentials (header secret or session cookie). */
function isAuthenticated(req: Request, expected: string): boolean {
  const secret = adminSecretFromRequest(req);
  if (secret && timingSafeEquals(secret, expected)) return true;
  const token = sessionTokenFromRequest(req);
  return token !== null && verifySessionToken(token, expected);
}

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_SECRET is not configured", message: "Set ADMIN_SECRET before using the admin console." });
    return;
  }
  if (!isAuthenticated(req, expected)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Linear Connector Admin", charset="UTF-8"');
    res.status(401).json({ error: "Unauthorized", message: "Sign in with the admin password, or send x-admin-secret / Bearer auth." });
    return;
  }
  next();
}

function parseJsonBody(req: Request): Record<string, unknown> | null {
  try {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
    if (typeof req.body === "string") return JSON.parse(req.body) as Record<string, unknown>;
    if (typeof req.body === "object" && req.body !== null) return req.body as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function placeholderPage(title: string, message: string): string {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Linear Connector</title><style>
    :root{color-scheme:dark} body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#071018,#10151b);color:#eef4f8;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
    .card{width:min(560px,calc(100vw - 32px));background:rgba(17,24,33,.94);border:1px solid #263342;border-radius:18px;padding:24px}
    h1{margin:0 0 10px;font-size:22px}.muted{color:#9dafbe}
  </style></head><body><main class="card"><h1>${esc(title)}</h1><p class="muted">${esc(message)}</p></main></body></html>`;
}

function defaultWebDistDir(): string {
  // dist/admin.js → <repo>/web/dist ; src/admin.ts (ts-node) resolves the same.
  return fileURLToPath(new URL("../web/dist", import.meta.url));
}

export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();
  const loginLimiter = new LoginRateLimiter();
  const webDistDir = deps.webDistDir ?? process.env.ADMIN_WEB_DIST ?? defaultWebDistDir();
  const indexHtmlPath = path.join(webDistDir, "index.html");

  // ── Unauthenticated surface ──────────────────────────────────────────────
  // Static SPA assets contain no operational data; every /api route below
  // (except login/me) requires credentials.

  router.post("/api/login", (req: Request, res: Response) => {
    const expected = process.env.ADMIN_SECRET;
    if (!expected) {
      res.status(503).json({ ok: false, error: "ADMIN_SECRET is not configured" });
      return;
    }
    const key = req.ip ?? "unknown";
    if (loginLimiter.isBlocked(key)) {
      res.status(429).json({ ok: false, error: "Too many failed attempts. Try again in a few minutes." });
      return;
    }
    const body = parseJsonBody(req);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password || !timingSafeEquals(password, expected)) {
      loginLimiter.recordFailure(key);
      res.status(401).json({ ok: false, error: "Wrong password" });
      return;
    }
    loginLimiter.reset(key);
    setSessionCookie(res, mintSessionToken(expected));
    res.json({ ok: true });
  });

  router.get("/api/me", (req: Request, res: Response) => {
    const expected = process.env.ADMIN_SECRET;
    res.json({
      authenticated: Boolean(expected && isAuthenticated(req, expected)),
      secretConfigured: Boolean(expected),
    });
  });

  router.post("/api/logout", (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ── Authenticated API ────────────────────────────────────────────────────
  router.use("/api", adminAuth);
  mountStreamRoute(router);

  router.get("/api/dashboard", (_req: Request, res: Response) => {
    res.json(buildDashboard(deps));
  });
  // Structural health: config artifacts, loaded workflow defs, registry⇄policy
  // drift. The verification surface for cutovers (dir-mode, policy edits).
  router.get("/api/structure", async (_req: Request, res: Response) => {
    let workflows: Array<{ id: string; version: number | string | undefined; states: number }> = [];
    let workflowError: string | null = null;
    try {
      const registry = await loadWorkflowRegistry();
      workflows = [...registry.values()].map((def) => ({
        id: def.id,
        version: def.version,
        states: def.states?.length ?? 0,
      }));
    } catch (err) {
      workflowError = err instanceof Error ? err.message : String(err);
    }
    res.json({
      configHealth: getConfigHealthStatus(),
      workflows,
      workflowError,
      registryPolicy: getRegistryPolicyStatus(),
    });
  });
  // Full workflow definitions — read-only feed for the console's workflow
  // views and the future visual editor.
  router.get("/api/workflows", async (_req: Request, res: Response) => {
    try {
      const registry = await loadWorkflowRegistry();
      res.json({ workflows: [...registry.values()], error: null });
    } catch (err) {
      res.json({ workflows: [], error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Alert feed from alerts.db (docs/alert-bus.md) — what has been pushed,
  // folded, or stored silently.
  router.get("/api/alerts", (req: Request, res: Response) => {
    const store = getAlertBus().getStore();
    if (!store) {
      res.json({ alerts: [] });
      return;
    }
    const severityRaw = typeof req.query.severity === "string" ? req.query.severity : undefined;
    const severity: AlertSeverity | undefined =
      severityRaw === "info" || severityRaw === "warning" || severityRaw === "critical" ? severityRaw : undefined;
    const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json({
      alerts: store.query({
        severity,
        source: typeof req.query.source === "string" ? req.query.source : undefined,
        agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
        unackedOnly: req.query.unackedOnly === "true",
        since: typeof req.query.since === "string" ? req.query.since : undefined,
        limit: Number.isFinite(limitRaw ?? NaN) ? limitRaw : undefined,
      }),
    });
  });
  // Dead-letter view: dispatch/routing failures from alerts.db (AI-1772).
  // kind query param maps to the store's source column; unfiltered results are
  // scoped to dead-letter sources (dispatch + routing) only.
  router.get("/api/dead-letters", (req: Request, res: Response) => {
    const store = getAlertBus().getStore();
    if (!store) {
      res.json({ items: [] });
      return;
    }
    const DEAD_LETTER_SOURCES = ["dispatch", "routing"];
    const kindRaw = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const source = kindRaw && DEAD_LETTER_SOURCES.includes(kindRaw) ? kindRaw : undefined;
    const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const limit = Number.isFinite(limitRaw ?? NaN) ? Math.min(limitRaw!, 500) : 100;
    const rows = store.query({
      source: source ?? undefined,
      agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
      ticket: typeof req.query.ticket === "string" ? req.query.ticket : undefined,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      limit,
    });
    const deadLetterRows = source
      ? rows
      : rows.filter((r) => DEAD_LETTER_SOURCES.includes(r.source));
    res.json({
      items: deadLetterRows.map((r) => ({
        id: r.id,
        firstAt: r.firstAt,
        lastAt: r.lastAt,
        kind: r.source,
        title: r.title,
        agent: r.agent,
        ticket: r.ticket,
        dedupCount: r.count,
        detail: r.detail,
      })),
    });
  });
  // Fleet liveness matrix: registry rows + dispatch-ack state + policy drift,
  // one payload for the console's fleet page.
  router.get("/api/fleet", (_req: Request, res: Response) => {
    const dashboard = buildDashboard(deps);
    res.json({
      generatedAt: dashboard.generatedAt,
      agents: dashboard.agents,
      dispatches: deps.ackTracker?.listRecent(200) ?? [],
      registryPolicy: getRegistryPolicyStatus(),
      configHealth: getConfigHealthStatus(),
    });
  });
  // AI-1802: Per-agent capacity strip (slots used / cap, parked count).
  // Read-only feed for the console's fleet/board page. Only agents with
  // any live sessions or parked tickets appear (idle agents are filtered
  // out). Cap source: per-agent maxConcurrent from agents.json with
  // fallback to AGENT_DEFAULT_MAX_CONCURRENT (3) — NOT delivery/throttle.ts.
  router.get("/api/capacity", (_req: Request, res: Response) => {
    const DEFAULT_MAX_CONCURRENT = 3;
    const agents = getAgents();

    // Build cap lookup: every known name/openclawAgent alias → maxConcurrent.
    const capByAgentId = new Map<string, number>();
    for (const agent of agents) {
      const cap = agent.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
      capByAgentId.set(agent.name, cap);
      if (agent.openclawAgent) {
        capByAgentId.set(agent.openclawAgent, cap);
      }
    }

    // Collect all agent IDs that have live sessions or parked work.
    const liveAgents = deps.sessionTracker.getActiveAgents();
    const parkedAgents = deps.bag.getAgentStats().map((s) => s.agentId);
    const allIds = [...new Set([...liveAgents, ...parkedAgents])];

    const result = allIds
      .map((agentId) => {
        const slotsUsed = deps.sessionTracker.getActiveSessionKeys(agentId).length;
        const parkedCount = deps.bag.getPendingTickets(agentId).length;
        const cap = capByAgentId.get(agentId) ?? DEFAULT_MAX_CONCURRENT;
        return { agentId, slotsUsed, cap, parkedCount };
      })
      .filter((a) => a.slotsUsed > 0 || a.parkedCount > 0);

    res.json({ agents: result });
  });

  // AI-1799/1800: Board read API — enrolled-tickets mirror joined with
  // workflow defs (columns), SLA thresholds, prose rendering, and terminal
  // handling.
  /**
   * AI-1800: Lightweight workflow summary loader for the board display layer.
   * Reads YAML files directly for id + ordered states[] without the strict
   * native_state validation gate — the board is display-only and must render
   * ANY workflow def with zero per-workflow code (AC1).
   */
  async function loadBoardWorkflowSummaries(): Promise<Map<string, { id: string; states: string[]; slaMap: Map<string, number | null> }>> {
    const result = new Map<string, { id: string; states: string[]; slaMap: Map<string, number | null> }>();
    const dir = process.env.WORKFLOW_DEFS_DIR;
    // Try the strict registry first (production path).
    let registry: Map<string, unknown> | null = null;
    try {
      registry = await loadWorkflowRegistry();
    } catch {
      registry = null;
    }
    const registryIds = new Set<string>();
    if (registry && registry.size > 0) {
      for (const [wfId, defRaw] of registry) {
        const def = defRaw as { id: string; states: Array<{ id: string; sla?: string }> };
        const slaMap = new Map<string, number | null>();
        for (const s of def.states) {
          slaMap.set(s.id, s.sla ? parseSlaToMs(s.sla) : null);
        }
        result.set(wfId, { id: def.id, states: def.states.map((s) => s.id), slaMap });
        registryIds.add(wfId);
      }
    }
    // Also scan the defs directory for YAML files not in the registry (e.g.
    // synthetic test defs without native_state). Board display must not reject them.
    if (dir) {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        entries = [];
      }
      for (const f of entries.sort()) {
        if (!f.endsWith(".yaml")) continue;
        const full = path.join(dir, f);
        try {
          const raw = await fs.promises.readFile(full, "utf8");
          const def = yaml.load(raw) as { id?: string; states?: Array<{ id: string; sla?: string }> };
          if (!def || !def.id || !def.states || registryIds.has(def.id)) continue;
          const slaMap = new Map<string, number | null>();
          for (const s of def.states) {
            slaMap.set(s.id, s.sla ? parseSlaToMs(s.sla) : null);
          }
          result.set(def.id, { id: def.id, states: def.states.map((s) => s.id), slaMap });
        } catch {
          // Skip unreadable/non-YAML files.
        }
      }
    }
    return result;
  }

  router.get("/api/board", async (_req: Request, res: Response) => {
    if (!deps.enrolledTicketsStore) {
      res.json({ workflows: [], tickets: [] });
      return;
    }
    const summaryMap = await loadBoardWorkflowSummaries();
    const allTickets = deps.enrolledTicketsStore.getAll();
    const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Determine which workflows have enrolled tickets.
    const enrolledWorkflowIds = new Set(allTickets.map((t) => t.workflow).filter(Boolean));

    // Build the workflows array with state ordering.
    // If there are enrolled tickets, only include workflows that have them.
    // If there are NO enrolled tickets at all, include all definitions (board
    // discovery mode — the empty board still shows workflow structure).
    const workflows: Array<{ id: string; states: string[] }> = [];
    const slaCache = new Map<string, Map<string, number | null>>();
    for (const [wfId, summary] of summaryMap) {
      slaCache.set(wfId, summary.slaMap);
      if (enrolledWorkflowIds.size > 0) {
        // Filter: only workflows with at least one live (non-demoted, non-aged) ticket.
        const hasLive = allTickets.some((t) => {
          if (t.workflow !== wfId) return false;
          if (t.last_event_kind === 'demoted') return false;
          if (t.terminal === 1) {
            const termAt = t.last_event_at ?? t.entered_state_at;
            if (now - new Date(termAt).getTime() > TWENTY_FOUR_H_MS) return false;
          }
          return true;
        });
        if (!hasLive) continue;
      }
      workflows.push({ id: summary.id, states: summary.states });
    }

    // AI-1801: Pre-fetch ack tracker entries for dispatch-health projection.
    const ackEntriesByTicket = new Map<string, DispatchAckEntry | null>();
    if (deps.ackTracker) {
      const recentAcks = deps.ackTracker.listRecent(500);
      for (const ack of recentAcks) {
        ackEntriesByTicket.set(ack.ticketId, ack);
      }
    }

    // Build enriched ticket array.
    const tickets: Array<Record<string, unknown>> = [];
    for (const row of allTickets) {
      const events = deps.operationalEventStore?.query({ key: `linear-${row.ticket_id}`, limit: 50 }) ?? [];
      const wakeEvent = events.find((e) => e.wakeId);
      const muted = row.last_event_kind === 'demoted';
      const termAt = row.terminal === 1 ? (row.last_event_at ?? row.entered_state_at) : null;
      const terminal_duration_ms = termAt ? Math.max(0, now - new Date(termAt).getTime()) : undefined;
      const stateSlaMap = slaCache.get(row.workflow);
      const sla_ms = stateSlaMap?.get(row.state) ?? null;

      // Exclude terminal tickets older than 24h.
      if (row.terminal === 1 && terminal_duration_ms !== undefined && terminal_duration_ms > TWENTY_FOUR_H_MS) {
        continue;
      }

      // AI-1801: Compute dispatch-health badge from operational events + ack tracker.
      const normalizedTicketKey = `linear-${row.ticket_id}`;
      const ackEntry = ackEntriesByTicket.get(normalizedTicketKey) ?? null;
      const dispatch_health = computeDispatchHealth(events, ackEntry);

      tickets.push({
        ticket_id: row.ticket_id,
        workflow: row.workflow,
        state: row.state,
        delegate: row.delegate,
        entered_state_at: row.entered_state_at,
        enrolled_at: row.enrolled_at,
        last_event_kind: row.last_event_kind,
        last_event_at: row.last_event_at,
        terminal: row.terminal,
        latest_wake_id: wakeEvent?.wakeId ?? null,
        time_in_state_ms: Math.max(0, now - new Date(row.entered_state_at).getTime()),
        sla_ms,
        last_event_prose: renderEventProse(row),
        muted,
        terminal_duration_ms: row.terminal === 1 ? terminal_duration_ms : undefined,
        dispatch_health,
      });
    }
    res.json({ workflows, tickets });
  });

  // AI-1800 AC4: Dispatches sub-view — grouped by wake_id.
  router.get("/api/dispatches", (_req: Request, res: Response) => {
    if (!deps.operationalEventStore) {
      res.json({ label: "Dispatch cycles", cycles: [] });
      return;
    }
    const allEvents = deps.operationalEventStore.query({ limit: 500 });
    const byWakeId = new Map<string, { agent_id: string; dispatches: Array<{ ticket_id: string; dispatched_at: string; ack_status: string; attempt_count: number; canon_version?: string }> }>();

    for (const ev of allEvents) {
      if (!ev.wakeId) continue;
      const ticketId = ev.key?.startsWith("linear-") ? ev.key.slice(7) : ev.key ?? '';
      if (!byWakeId.has(ev.wakeId)) {
        byWakeId.set(ev.wakeId, { agent_id: ev.agent ?? '', dispatches: [] });
      }
      const group = byWakeId.get(ev.wakeId)!;
      if (!group.dispatches.some((d) => d.ticket_id === ticketId)) {
        // AI-1848: extract canon version stamped into the dispatch record detail.
        const detail = ev.detail as Record<string, unknown> | null;
        const canonVersion = typeof detail?.canonVersion === "string" ? detail.canonVersion : undefined;
        group.dispatches.push({
          ticket_id: ticketId,
          dispatched_at: ev.occurredAt,
          ack_status: 'pending',
          attempt_count: 1,
          ...(canonVersion ? { canon_version: canonVersion } : {}),
        });
      }
    }

    // Cross-reference with ackTracker for accurate ack_status/attempt_count.
    if (deps.ackTracker) {
      const acks = deps.ackTracker.listRecent(500);
      for (const group of byWakeId.values()) {
        for (const d of group.dispatches) {
          const match = acks.find((a) => a.ticketId === d.ticket_id && a.agentId === group.agent_id);
          if (match) {
            d.ack_status = match.ackStatus;
            d.attempt_count = match.attemptCount;
            d.dispatched_at = match.dispatchedAt;
          }
        }
      }
    }

    const cycles = Array.from(byWakeId.entries()).map(([wake_id, group]) => ({
      wake_id,
      agent_id: group.agent_id,
      dispatches: group.dispatches,
    }));

    res.json({ label: "Dispatch cycles", cycles });
  });

  // AI-1800 AC5: Per-ticket detail — state transitions with wake cycles.
  router.get("/api/board/ticket/:ticketId", (_req: Request, res: Response) => {
    const ticketId = String(_req.params.ticketId);
    if (!deps.enrolledTicketsStore) {
      res.status(404).json({ ticket_id: ticketId });
      return;
    }
    const row = deps.enrolledTicketsStore.getByTicketId(ticketId);
    if (!row) {
      res.status(404).json({ ticket_id: ticketId });
      return;
    }
    const events = deps.operationalEventStore?.query({ key: `linear-${ticketId}`, limit: 200 }) ?? [];

    // Build wake cycles from operational events that have a wakeId.
    const wakeCycles = events
      .filter((e) => e.wakeId)
      .map((e) => ({
        wake_id: e.wakeId!,
        plane: (e as unknown as { plane?: string }).plane ?? "agent",
        summary: `${e.outcome}${e.agent ? ` by ${e.agent}` : ""}, ${e.occurredAt}`,
      }));

    // Build state transitions. The mirror store records only the current state
    // (no full history), so we construct at least one transition for the
    // current state with any matching wake cycles attached.
    const stateTransitions: Array<{
      state: string;
      delegate: string | null;
      timestamp: string;
      event_kind: string;
      default_plane: "agent" | "connector";
      expandable_planes: string[];
      wake_cycles: Array<{ wake_id: string; plane: string; summary: string }>;
    }> = [{
      state: row.state,
      delegate: row.delegate,
      timestamp: row.entered_state_at,
      event_kind: row.last_event_kind ?? "enrolled",
      default_plane: "agent",
      expandable_planes: ["connector"],
      wake_cycles: wakeCycles,
    }];

    res.json({
      ticket_id: row.ticket_id,
      workflow: row.workflow,
      state: row.state,
      delegate: row.delegate,
      state_transitions: stateTransitions,
    });
  });
  router.get("/api/events", (req: Request, res: Response) => {
    if (!deps.operationalEventStore) {
      res.json({ events: [] });
      return;
    }
    const outcome = typeof req.query.outcome === "string" ? req.query.outcome as OperationalEventOutcome : undefined;
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json({ events: deps.operationalEventStore.query({
      agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
      key: typeof req.query.key === "string" ? req.query.key : undefined,
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      outcome,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      until: typeof req.query.until === "string" ? req.query.until : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    }) });
  });
  router.get("/api/tasks/:key/events", (req: Request, res: Response) => {
    res.json(deps.operationalEventStore?.snapshot({ key: req.params.key }) ?? { key: req.params.key, lifecycle: [] });
  });
  // AC5 (AI-1560): Per-ticket engagement event observability.
  router.get("/api/engagement/:ticketId", (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const normalizedKey = tryNormalizeSessionKey(ticketId);
    if (!normalizedKey || !deps.operationalEventStore) {
      res.status(404).json({ ticketId });
      return;
    }
    const events = deps.operationalEventStore.query({ key: normalizedKey, limit: 200 });
    const engagementEvent = events.find(
      (e) => e.outcome === "engagement-thinking" || e.outcome === "engagement-doing" || e.outcome === "engagement-todo",
    );
    if (!engagementEvent) {
      res.status(404).json({ ticketId });
      return;
    }
    res.json({
      ticketId,
      lastEvent: {
        semantic: engagementEvent.outcome.replace("engagement-", ""),
        agentId: engagementEvent.agent,
      },
    });
  });
  router.get("/api/stale-digest", (_req: Request, res: Response) => {
    const daysBack = typeof _req.query.days === "string" ? Number.parseInt(_req.query.days, 10) : 7;
    const summary = aggregateDigest(undefined, daysBack);
    res.json(summary);
  });
  router.get("/api/stale-digest/text", (_req: Request, res: Response) => {
    const daysBack = typeof _req.query.days === "string" ? Number.parseInt(_req.query.days, 10) : 7;
    const summary = aggregateDigest(undefined, daysBack);
    res.type("text/plain").send(formatDigestSummary(summary));
  });
  // Phase 4 / P4-1: Observation query and aggregation endpoints.
  router.get("/api/observations", (req: Request, res: Response) => {
    if (!deps.observationStore) {
      res.json({ observations: [] });
      return;
    }
    res.json({ observations: deps.observationStore.query({
      workflow: typeof req.query.workflow === "string" ? req.query.workflow : undefined,
      step: typeof req.query.step === "string" ? req.query.step : undefined,
      reasonCode: typeof req.query.reasonCode === "string" ? req.query.reasonCode as ReasonCode : undefined,
      ticket: typeof req.query.ticket === "string" ? req.query.ticket : undefined,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      until: typeof req.query.until === "string" ? req.query.until : undefined,
      limit: typeof req.query.limit === "string" ? (() => { const n = Number.parseInt(req.query.limit, 10); return Number.isFinite(n) && n > 0 ? n : undefined; })() : undefined,
    }) });
  });
  router.get("/api/observations/counts", (req: Request, res: Response) => {
    if (!deps.observationStore) {
      res.json({ counts: [] });
      return;
    }
    res.json({ counts: deps.observationStore.counts({
      workflow: typeof req.query.workflow === "string" ? req.query.workflow : undefined,
      step: typeof req.query.step === "string" ? req.query.step : undefined,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      until: typeof req.query.until === "string" ? req.query.until : undefined,
    }) });
  });
  // Phase 4 / P4-2: Metric aggregation endpoint.
  router.get("/api/observations/metrics", (req: Request, res: Response) => {
    if (!deps.observationStore) {
      res.json({ items: [], summary: { totalObservations: 0, uniqueWorkflows: 0, uniqueSteps: 0, stepsAboveThreshold: [] }, query: {} });
      return;
    }
    const thresholdParam = typeof req.query.threshold === "string" ? Number.parseInt(req.query.threshold, 10) : undefined;
    const threshold = Number.isFinite(thresholdParam ?? NaN) && (thresholdParam ?? 0) > 0 ? thresholdParam : undefined;
    res.json(deps.observationStore.metrics({
      workflow: typeof req.query.workflow === "string" ? req.query.workflow : undefined,
      step: typeof req.query.step === "string" ? req.query.step : undefined,
      reasonCode: typeof req.query.reasonCode === "string" ? req.query.reasonCode as ReasonCode : undefined,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      until: typeof req.query.until === "string" ? req.query.until : undefined,
      includeBody: req.query.includeBody === "true",
      threshold,
    }));
  });
  // AI-1546 / G-6: Steward/human-only atomic set-state.
  // All admin API routes are protected by adminAuth (ADMIN_SECRET or console session).
  // AC2: agents cannot call this — they have no ADMIN_SECRET.
  router.post("/api/set-state", async (req: Request, res: Response) => {
    const body = parseJsonBody(req);
    if (body === null && (Buffer.isBuffer(req.body) || typeof req.body === "string")) {
      res.status(400).json({ ok: false, error: "Malformed JSON body" });
      return;
    }
    const ticketId = typeof body?.ticketId === "string" ? body.ticketId.trim() : "";
    const targetState = typeof body?.targetState === "string" ? body.targetState.trim() : "";
    // delegate: string (agent body name) → set; null → clear; absent → leave untouched.
    const delegateRaw = body && "delegate" in body ? body.delegate : undefined;
    const delegate: string | null | undefined =
      delegateRaw === null ? null :
      typeof delegateRaw === "string" ? delegateRaw :
      undefined;

    if (!ticketId || !targetState) {
      res.status(400).json({ ok: false, error: "ticketId and targetState are required" });
      return;
    }

    // Resolve a Linear auth token — prefer first agent's OAuth token, fall back to env.
    const agents = getAgents();
    const authToken =
      (agents.length > 0 ? getAccessToken(agents[0].name) : undefined) ??
      process.env.LINEAR_OAUTH_TOKEN ??
      process.env.LINEAR_API_KEY;
    if (!authToken) {
      res.status(503).json({ ok: false, error: "no Linear auth token available" });
      return;
    }

    const sendWakeUp = deps.wakeConfigForAgent
      ? async (agentId: string, ticketIdentifier: string) => {
          const config = deps.wakeConfigForAgent!(agentId);
          await sendWakeUpSignal(agentId, [ticketIdentifier], config);
        }
      : undefined;

    const result = await setStateAtomic(ticketId, targetState, delegate, authToken, { sendWakeUp, operationalEventStore: deps.operationalEventStore });
    res.status(result.ok ? 200 : 422).json(result);
  });

  // POST /api/recapture-ac — steward-gated AC-of-record recapture (AI-1785).
  // Auth: adminAuth (ADMIN_SECRET or console session).  Authorization: the
  // steward gate inside recaptureAc() checks callerBodyId against
  // resolveBodiesForRole("steward").  No separate permission mechanism.
  router.post("/api/recapture-ac", async (req: Request, res: Response) => {
    const body = parseJsonBody(req);
    if (body === null && (Buffer.isBuffer(req.body) || typeof req.body === "string")) {
      res.status(400).json({ ok: false, error: "Malformed JSON body" });
      return;
    }
    const ticketId = typeof body?.ticketId === "string" ? body.ticketId.trim() : "";
    const callerBodyId = typeof body?.callerBodyId === "string" ? body.callerBodyId.trim() : "";
    const force = body?.force === true;

    if (!ticketId || !callerBodyId) {
      res.status(400).json({ ok: false, error: "ticketId and callerBodyId are required" });
      return;
    }

    // Resolve a Linear auth token — prefer first agent's OAuth token, fall back to env.
    const agents = getAgents();
    const authToken =
      (agents.length > 0 ? getAccessToken(agents[0].name) : undefined) ??
      process.env.LINEAR_OAUTH_TOKEN ??
      process.env.LINEAR_API_KEY;
    if (!authToken) {
      res.status(503).json({ ok: false, error: "no Linear auth token available" });
      return;
    }

    try {
      await recaptureAc(ticketId, authToken, callerBodyId, { force });
      res.status(200).json({ ok: true, ticketId, callerBodyId, force });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Authorization failures → 403; other recapture errors → 422.
      const isAuthError = msg.includes("not authorized");
      res.status(isAuthError ? 403 : 422).json({ ok: false, error: msg });
    }
  });

  // ── SPA (management console) ─────────────────────────────────────────────
  // Assets are public; all data flows through the authenticated API above.
  router.use(express.static(webDistDir, { index: false, fallthrough: true }));
  router.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
    if (fs.existsSync(indexHtmlPath)) {
      res.sendFile(indexHtmlPath);
      return;
    }
    res
      .status(503)
      .type("html")
      .send(placeholderPage(
        "Console UI not built",
        "The management console SPA is missing. Build it with: npm --prefix web install && npm --prefix web run build — the API under /admin/api/ is unaffected.",
      ));
  });
  return router;
}
