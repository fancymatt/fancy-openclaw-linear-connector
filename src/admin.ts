import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { getAgents, type AgentConfig } from "./agents.js";
import type { AgentQueue } from "./queue/index.js";
import type { PendingWorkBag, BagEntry } from "./bag/index.js";
import type { SessionTracker } from "./bag/index.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";
import type { OperationalEventStore, OperationalEventOutcome } from "./store/operational-event-store.js";

interface AdminDeps {
  agentQueue: AgentQueue;
  bag: PendingWorkBag;
  sessionTracker: SessionTracker;
  operationalEventStore?: OperationalEventStore;
  deploymentName: string;
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

function wantsHtml(req: Request): boolean {
  return !req.path.startsWith("/api/") && req.accepts(["html", "json"]) === "html";
}

function renderAuthFailurePage(status: number, title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Linear Connector Admin</title><style>
    :root { color-scheme: dark; --bg:#0b0f14; --panel:#111821; --line:#263342; --text:#eef4f8; --muted:#9dafbe; --red:#ff837d; --yellow:#f2c96d; }
    *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#071018,#10151b);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.card{width:min(560px,calc(100vw - 32px));background:rgba(17,24,33,.94);border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.3)}.eyebrow{color:${status === 503 ? "var(--yellow)" : "var(--red)"};font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:12px}h1{margin:8px 0 10px;font-size:24px}.muted{color:var(--muted)}code{background:#0b1118;border:1px solid var(--line);border-radius:7px;padding:2px 5px}
  </style></head><body><main class="card"><div class="eyebrow">Admin access</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="muted">The dashboard is read-only and hides token values. Browser navigation supports HTTP Basic auth using <code>ADMIN_SECRET</code> as the password; API clients may use <code>x-admin-secret</code> or Bearer auth.</p></main></body></html>`;
}

function sendAdminAuthFailure(req: Request, res: Response, status: number, title: string, message: string): void {
  if (wantsHtml(req)) {
    if (status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="Linear Connector Admin", charset="UTF-8"');
    res.status(status).type("html").send(renderAuthFailurePage(status, title, message));
    return;
  }
  if (status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="Linear Connector Admin", charset="UTF-8"');
  res.status(status).json({ error: title, message });
}

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    sendAdminAuthFailure(req, res, 503, "ADMIN_SECRET is not configured", "Set ADMIN_SECRET before using the admin dashboard.");
    return;
  }
  const actual = adminSecretFromRequest(req);
  if (!actual || !timingSafeEquals(actual, expected)) {
    sendAdminAuthFailure(req, res, 401, "Unauthorized", "Enter the admin password to view the Linear connector dashboard.");
    return;
  }
  next();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({

    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char] ?? char));
}

function chip(severity: Severity, label: string): string {
  return `<span class="chip ${severity}">${escapeHtml(label)}</span>`;
}

function attentionHtml(dashboard: ReturnType<typeof buildDashboard>): string {
  const stateClass = dashboard.attention.length ? "attention" : "attention-ok";
  return `<section class="card span-12 ${stateClass}"><h2>Attention Needed</h2>${dashboard.attention.length
    ? dashboard.attention.map((item) => `<div class="stack item">${chip(item.severity, item.severity === "red" ? "Action required" : "Needs attention")}<div class="row-title">${escapeHtml(item.title)}</div><div class="muted">${escapeHtml(item.message)} ${item.href ? `<a href="${escapeHtml(item.href)}">Open destination</a>` : ""}</div></div>`).join("")
    : `<div class="empty">No attention needed. Connector is running and no tasks are blocked.</div>`}</section>`;
}

function statusStripHtml(status: ReturnType<typeof buildDashboard>["status"]): string {
  return `<div class="strip">${chip(status.severity as Severity, status.severity === "green" ? "Healthy" : status.severity === "yellow" ? "Degraded" : "Action required")}${chip("gray", `${status.agentsConfigured} agents`)}${chip(status.activeSessions ? "yellow" : "gray", `${status.activeSessions} active sessions`)}${chip(status.pendingBagSize ? "yellow" : "green", `${status.pendingBagSize} pending`)}${chip("gray", `${status.eventsReceived} events`)}${chip("gray", `${status.signalsSent} signals`)}</div>`;
}

function diagnostics(value: unknown): string {
  return `<details><summary>Raw diagnostics</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}

function agentTableHtml(rows: ReturnType<typeof buildDashboard>["agents"]): string {
  if (rows.length === 0) return `<div class="empty">No agents configured.</div>`;
  return `<table><thead><tr><th>Agent</th><th>State</th><th>Pending</th><th>Next expected task</th></tr></thead><tbody>${rows.map((agent) => `<tr id="${agentAnchor(agent.name)}"><td><div class="row-title">${escapeHtml(agent.name)}</div><div class="muted">${escapeHtml(agent.openclawAgent)} · ${escapeHtml(agent.linearUserId)}</div></td><td>${chip(agent.severity, agent.activity)}<div class="muted">${escapeHtml(agent.credentialState)}</div></td><td>${escapeHtml(agent.pendingCount)} pending<br><span class="muted">${escapeHtml(agent.queueDepth)} queued</span></td><td>${escapeHtml(agent.nextExpectedTask)}<div class="muted">Last success: ${escapeHtml(agent.lastSuccess)}</div><div class="muted">Last error: ${escapeHtml(agent.lastError)}</div>${diagnostics(agent.diagnostics)}</td></tr>`).join("")}</tbody></table>`;
}

function taskTableHtml(rows: ReturnType<typeof buildDashboard>["tasks"]): string {
  if (rows.length === 0) return `<div class="empty">No work in this state.</div>`;
  return `<table><thead><tr><th>Task</th><th>Owner / Agent</th><th>State</th><th>Detail panel</th></tr></thead><tbody>${rows.map((task) => `<tr id="${taskAnchor(task.sessionKey)}"><td><div class="row-title">${task.relatedUrl ? `<a href="${escapeHtml(task.relatedUrl)}">${escapeHtml(task.related)}</a>` : escapeHtml(task.related)}</div><div class="muted">${escapeHtml(task.eventType)} · ${escapeHtml(task.sessionKey)} · ${escapeHtml(task.age)} · updated ${escapeHtml(ageLabel(task.updated))}</div></td><td>${escapeHtml(task.owner)}</td><td>${chip(task.severity as Severity, task.state)}${task.safeError ? `<div class="muted">${escapeHtml(task.safeError)}</div>` : ""}</td><td><details class="detail-panel"><summary>Open task detail</summary><div class="detail-grid"><div><strong>Related</strong><br>${task.relatedUrl ? `<a href="${escapeHtml(task.relatedUrl)}">${escapeHtml(task.related)}</a>` : escapeHtml(task.related)}</div><div><strong>Event / session</strong><br>${escapeHtml(task.eventType)} · ${escapeHtml(task.sessionKey)}</div><div><strong>Lifecycle</strong><br>${escapeHtml(task.lifecycle)}</div>${task.safeError ? `<div><strong>Safe error</strong><br>${escapeHtml(task.safeError)}</div>` : ""}</div>${diagnostics(task.diagnostics)}</details></td></tr>`).join("")}</tbody></table>`;
}

function renderOverview(dashboard: ReturnType<typeof buildDashboard>): string {
  return `<div class="grid">${attentionHtml(dashboard)}<section class="card span-12"><h2>System Status</h2>${statusStripHtml(dashboard.status)}</section><section class="card span-6"><h2>Agent Status</h2>${agentTableHtml(dashboard.agents.slice(0, 8))}</section><section class="card span-6"><h2>Work in Motion</h2>${taskTableHtml(dashboard.tasks.slice(0, 8))}</section></div>`;
}

function renderAgentsPage(dashboard: ReturnType<typeof buildDashboard>): string {
  return `<div class="grid">${attentionHtml(dashboard)}<section class="card span-12"><h2>Agents</h2><p class="muted">Identity mapping, credential/OAuth state, activity, pending count, last known status, and next expected task. Tokens and secrets are intentionally hidden.</p>${agentTableHtml(dashboard.agents)}</section></div>`;
}

function renderTasksPage(dashboard: ReturnType<typeof buildDashboard>): string {
  const tabs = ["active", "pending", "stale", "failed", "completed"];
  const tables = tabs.map((tab) => {
    const rows = dashboard.tasks.filter((task) => tab === "stale" ? task.state === "pending" && /d ago|h ago/.test(task.age) : task.state === tab);
    return `<section class="card span-12"><h2>${tab[0].toUpperCase()}${tab.slice(1)}</h2>${taskTableHtml(rows)}</section>`;
  }).join("");
  return `<div class="grid">${attentionHtml(dashboard)}<section class="card span-12"><h2>Tasks</h2><div class="tabs">${tabs.map((tab) => chip(tab === "failed" ? "red" : tab === "completed" ? "green" : tab === "stale" ? "yellow" : "gray", tab)).join("")}</div><p class="muted">Rows include owner/agent, state, age/updated, related issue/comment/event/session, lifecycle context, safe errors, and collapsed diagnostics.</p></section>${tables}</div>`;
}

function settingsTable(rows: Record<string, unknown>): string {
  return `<table><tbody>${Object.entries(rows).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>`;
}

function renderSettingsPage(dashboard: ReturnType<typeof buildDashboard>): string {
  const settings = dashboard.settings;
  return `<div class="grid">${attentionHtml(dashboard)}<section class="card span-6"><h2>Read-only Effective Config</h2>${settingsTable(settings.effectiveConfig)}</section><section class="card span-6"><h2>OAuth / Setup State</h2>${settings.oauthSetup.map((item) => `<div id="${oauthAnchor(item.agent)}" class="stack item">${chip(item.state === "configured" ? "green" : "red", item.state)}<div>${escapeHtml(item.agent)}</div><div class="muted">${escapeHtml(item.safeNote)}</div></div>`).join("") || `<div class="empty">No OAuth setup data.</div>`}</section><section class="card span-12"><h2>Linear Workspace / Team Mappings</h2>${settings.workspaceTeamMappings.length ? `<table><tbody>${settings.workspaceTeamMappings.map((mapping) => `<tr><td>${escapeHtml(mapping.agent)}</td><td>${escapeHtml(mapping.linearUserId)}</td><td>${escapeHtml(mapping.openclawAgent)}</td><td>${escapeHtml(mapping.host)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No mappings configured.</div>`}</section><section class="card span-12"><h2>Agent Mapping Table</h2>${settings.agentMappings.length ? `<table><tbody>${settings.agentMappings.map((mapping) => `<tr><td>${escapeHtml(mapping.name)}</td><td>${escapeHtml(mapping.openclawAgent)}</td><td>${escapeHtml(mapping.identityMapped ? "mapped" : "not mapped")}</td><td>${escapeHtml(mapping.credentialState)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No mappings configured.</div>`}</section><section class="card span-12"><h2>Restart-required Flags</h2>${settings.restartRequiredFlags.map((flag) => `<div class="item">${chip(flag.required ? "yellow" : "green", flag.required ? "Restart required" : "Hot reload")} <strong>${escapeHtml(flag.name)}</strong> <span class="muted">${escapeHtml(flag.note)}</span></div>`).join("")}</section></div>`;
}

function renderShell(initialPage: string, dashboard: ReturnType<typeof buildDashboard>): string {
  const nav = [
    ["overview", "/admin/", "Overview"],
    ["agents", "/admin/agents", "Agents"],
    ["tasks", "/admin/tasks", "Tasks"],
    ["settings", "/admin/settings", "Settings"],
  ].map(([key, href, label]) => `<a class="${key === initialPage ? "active" : ""}" href="${href}">${label}</a>`).join("");
  const body = initialPage === "agents" ? renderAgentsPage(dashboard)
    : initialPage === "tasks" ? renderTasksPage(dashboard)
      : initialPage === "settings" ? renderSettingsPage(dashboard)
        : renderOverview(dashboard);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Linear Connector Admin</title><style>
    :root { color-scheme: dark; --bg:#0b0f14; --panel:#111821; --line:#263342; --text:#eef4f8; --muted:#9dafbe; --green:#74d99f; --yellow:#f2c96d; --red:#ff837d; --gray:#a4afba; --blue:#8fc7ff; }
    *{box-sizing:border-box} body{margin:0;background:linear-gradient(180deg,#071018,#10151b);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif} a{color:var(--blue)} .wrap{max-width:1180px;margin:0 auto;padding:28px 20px 48px} header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:22px} h1{margin:0;font-size:24px;letter-spacing:-.02em}.sub{color:var(--muted);margin-top:4px} nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 20px} nav a{color:var(--text);text-decoration:none;padding:9px 13px;border:1px solid var(--line);border-radius:999px;background:#0f151d} nav a.active{background:#203044;border-color:#3d5570}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{background:rgba(17,24,33,.92);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 14px 40px rgba(0,0,0,.25)}.span-12{grid-column:span 12}.span-6{grid-column:span 6}h2{margin:0 0 12px;font-size:17px}.attention{border-color:#68413f;background:linear-gradient(180deg,rgba(255,131,125,.10),rgba(17,24,33,.94))}.attention-ok{border-color:#315b43;background:linear-gradient(180deg,rgba(116,217,159,.08),rgba(17,24,33,.94))}.empty{color:var(--muted);padding:14px;border:1px dashed var(--line);border-radius:12px;background:#0e151d}.attention-ok .empty{border-color:#315b43;background:#0f1b18;color:#bfd9ca}.strip,.tabs{display:flex;gap:10px;flex-wrap:wrap}.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid;font-size:12px;font-weight:650}.green{color:var(--green);border-color:#315b43;background:#102019}.yellow{color:var(--yellow);border-color:#67562d;background:#241d0f}.red{color:var(--red);border-color:#72413f;background:#271514}.gray{color:var(--gray);border-color:#4a525b;background:#1a2028}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:target,.item:target{outline:2px solid var(--blue);outline-offset:3px;background:rgba(143,199,255,.07)}th{color:var(--muted);font-size:12px;font-weight:650}.row-title{font-weight:700}.muted{color:var(--muted)}.stack{display:flex;flex-direction:column;gap:8px}.item{margin:10px 0}.detail-panel{padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:#0d141c}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}details{margin-top:8px}summary{color:var(--muted);cursor:pointer}pre{overflow:auto;padding:10px;border-radius:10px;background:#080d12;border:1px solid var(--line);color:#c8d6e2}@media(max-width:820px){.span-6{grid-column:span 12}header{flex-direction:column}.detail-grid{grid-template-columns:1fr}}
  </style></head><body><div class="wrap"><header><div><h1>Linear Connector Admin</h1><div class="sub">Control-room view for routing health, agent setup, and work in motion.</div></div><div class="muted">Updated ${escapeHtml(new Date(dashboard.generatedAt).toLocaleString())}</div></header><nav>${nav}</nav><main>${body}</main></div></body></html>`;
}

export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();
  router.use(adminAuth);
  router.get("/api/dashboard", (_req: Request, res: Response) => {
    res.json(buildDashboard(deps));
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
  router.get(["/", "/agents", "/tasks", "/settings"], (req: Request, res: Response) => {
    const segment = req.path.split("/").filter(Boolean)[0];
    const initialPage = ["agents", "tasks", "settings"].includes(segment) ? segment : "overview";
    res.type("html").send(renderShell(initialPage, buildDashboard(deps)));
  });
  return router;
}
