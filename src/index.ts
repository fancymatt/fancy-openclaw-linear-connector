import 'dotenv/config';
import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook/index.js";
import { handleProxyRequest } from "./proxy.js";
import { startTokenRefresh } from "./token-refresh.js";
import { getAgents, watchAgentsFile } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { handleOAuthCallback } from "./oauth-callback.js";
import { EventStore } from "./store/event-store.js";
import { NudgeStore } from "./store/nudge-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { ObservationStore } from "./store/observation-store.js";
import { ManagingStateStore } from "./store/managing-state-store.js";
import { AgentQueue } from "./queue/index.js";
import { deliverToAgent, deliverMessageToAgent, DeliveryThrottle } from "./delivery/index.js";
import { PendingWorkBag, SessionTracker, DispatchAckTracker, DispatchWatchdog, NoActivityDetector, resignalPendingTickets, replayPendingBag, ManagingPoller } from "./bag/index.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./bag/wake-up.js";
import { normalizeSessionKey } from "./session-key.js";
import { createAdminRouter } from "./admin.js";
import { buildSnapshot, writeSnapshot, appendDigestEntry, fetchLinearTicketState, recoverTicket, STALE_CLASS_NAMES, type StaleSnapshot, type ForensicsConfig } from "./bag/stale-session-forensics.js";
import { getAccessToken, getAgent } from "./agents.js";
import type { StaleSessionDetail } from "./bag/session-tracker.js";
import crypto from "crypto";
import path from "path";

const log = componentLogger(createLogger(), "server");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3100;
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME ?? "fancymatt";

/**
 * Constant-time secret comparison to prevent timing attacks.
 */
function verifySecret(header: string, secret: string): boolean {
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) {
    // Still compare to keep constant time — compare against self then fail
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
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

function requireAdminSecret(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ success: false, error: "ADMIN_SECRET is not configured" });
    return false;
  }
  const actual = adminSecretFromRequest(req);
  if (!actual || !verifySecret(actual, expected)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function parseJsonBody<T extends object>(req: Request): T | null {
  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8")) as T;
  }
  if (typeof req.body === "object" && req.body !== null) {
    return req.body as T;
  }
  return null;
}

export interface CreateAppOptions {
  /** Override PendingWorkBag database path (for testing). */
  bagDbPath?: string;
  /** Override AgentQueue database path (for testing). */
  agentQueueDbPath?: string;
  /** Override OperationalEventStore database path (for testing). */
  operationalEventsDbPath?: string;
  /** Override ObservationStore database path (for testing). */
  observationsDbPath?: string;
  /** Override ManagingStateStore database path (for testing). */
  managingStateDbPath?: string;
}

export function createApp(options?: CreateAppOptions) {
  const app = express();
  app.set("trust proxy", true);

  // Create stores early — needed before route registration.
  const observationStore = new ObservationStore(options?.observationsDbPath);

  // Raw body capture for webhook signature validation.
  app.use(
    "/",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    },
  );

  // GraphQL proxy — v0 transparent pass-through (Phase 0B, design.md §4.6).
  // Intercepts every Linear CLI call from Nakazawa agents; forwards unchanged
  // for now. Future phases add per-step instruction injection and command
  // validation. ILL fleet runs the main branch and is unaffected.
  app.post("/proxy/graphql", (req, res) => handleProxyRequest(req, res, { observationStore }));

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    const agents = getAgents();
    res.json({
      status: "ok",
      service: "fancy-openclaw-linear-connector",
      deployment: DEPLOYMENT_NAME,
      agents: agents.length,
      agentNames: agents.map((a) => a.name),
    });
  });

  // OAuth callback — handles Linear app authorization flow
  // Both paths supported: /callback (legacy) and /oauth/callback (registered with Linear)
  app.get("/callback", handleOAuthCallback);
  app.get("/oauth/callback", handleOAuthCallback);

  // Webhook routes — pass the event store from the dedup module

  const eventStore = new EventStore();
  const nudgeStore = new NudgeStore();
  const operationalEventStore = new OperationalEventStore(options?.operationalEventsDbPath);
  const agentQueue = new AgentQueue(options?.agentQueueDbPath);
  const bag = new PendingWorkBag(options?.bagDbPath);
  const wakeConfig = {
    nodeBin: process.execPath,
    hooksUrl: process.env.OPENCLAW_HOOKS_URL,
    hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
    hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
    hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
    timeoutMs: process.env.NODE_ENV === "test" ? 50 : undefined,
    maxRetries: process.env.NODE_ENV === "test" ? 0 : undefined,
  };
  const wakeConfigForAgent = (agentIdLookup: string): WakeUpConfig => {
    const cfg = getAgent(agentIdLookup);
    return {
      ...wakeConfig,
      hooksUrl: cfg?.hooksUrl ?? wakeConfig.hooksUrl,
      hooksToken: cfg?.hooksToken ?? wakeConfig.hooksToken,
    };
  };
  const resignalOptions = {
    sendWakeUp: (agentId: string, ticketIds: string[]) =>
      sendWakeUpSignal(agentId, ticketIds, wakeConfigForAgent(agentId)),
  };
  const forensicsConfig: ForensicsConfig = {
    diagnosticsDir: process.env.STALE_SESSION_DIAGNOSTICS_DIR,
    openclawHome: process.env.OPENCLAW_HOME,
    loopThreshold: process.env.STALE_LOOP_THRESHOLD ? parseInt(process.env.STALE_LOOP_THRESHOLD, 10) : undefined,
    humanAssigneeLinearId: process.env.STALE_HUMAN_ASSIGNEE_LINEAR_ID,
  };

  /**
   * Process a single stale session: capture forensics, classify, recover ticket.
   */
  async function processStaleSession(stale: StaleSessionDetail): Promise<void> {
    log.warn(
      `Stale session: ${stale.agentId} [${stale.sessionKey}] ` +
      `(started ${Math.round((Date.now() - stale.startedAt) / 60_000)}min ago, timeout ${Math.round(stale.timeoutMs / 60_000)}min)`
    );

    // 1. Build forensic snapshot
    const snapshot = buildSnapshot(stale, forensicsConfig);

    // 2. Fetch current Linear ticket state for comparison
    const linearState = await fetchLinearTicketState(stale.sessionKey, stale.agentId);
    if (linearState) {
      snapshot.linearTicket.stateAtTimeout = linearState.state?.name ?? null;
      snapshot.linearTicket.commentCountAtTimeout = linearState.comments?.nodes?.length ?? 0;
    }

    // 3. Write snapshot to disk
    const diagPath = writeSnapshot(snapshot, forensicsConfig);
    snapshot.diagnosticPath = diagPath;

    // 4. Append to digest JSONL
    appendDigestEntry(snapshot, forensicsConfig);

    // 5. Log classification
    log.warn(
      `Stale session classified: ${stale.agentId} [${stale.sessionKey}] → ${snapshot.classification} (${STALE_CLASS_NAMES[snapshot.classification]})`
    );

    operationalEventStore.append({
      outcome: "stale-resignaled",
      agent: stale.agentId,
      key: stale.sessionKey,
      sessionKey: stale.sessionKey,
      deliveryMode: "stale-session-drain",
      attemptCount: stale.pendingTickets.length,
      detail: {
        classification: snapshot.classification,
        diagnosticPath: diagPath,
        toolCallCount: snapshot.toolCallSummary.totalCalls,
        stopReason: snapshot.lastAssistantMessage?.stopReason,
        errorCount: snapshot.errors.length,
      },
    });

    // 6. Recover the Linear ticket
    const recovery = await recoverTicket(snapshot, stale.agentId, forensicsConfig);
    if (!recovery.success) {
      log.error(`Recovery failed for ${stale.sessionKey}: ${recovery.detail}`);
    }

    // 7. Re-signal pending tickets (if any)
    if (stale.pendingTickets.length > 0) {
      log.info(`Stale session drain: re-signaling ${stale.agentId} for ${stale.pendingTickets.length} ticket(s)`);
      const sent = await resignalPendingTickets(stale.agentId, stale.pendingTickets, bag, sessionTracker, wakeConfigForAgent(stale.agentId), { markActive: true, ...resignalOptions });
      operationalEventStore.append({
        outcome: "stale-resignaled",
        agent: stale.agentId,
        key: stale.pendingTickets[0] ?? null,
        sessionKey: stale.pendingTickets[0] ?? null,
        deliveryMode: "stale-session-resignal",
        attemptCount: stale.pendingTickets.length,
        detail: { requested: stale.pendingTickets.length, sent },
      });
    }
  }

  const sessionTracker = new SessionTracker(undefined, async (staleSessions) => {
    for (const stale of staleSessions) {
      try {
        await processStaleSession(stale);
      } catch (err) {
        log.error(`Stale session processing failed for ${stale.agentId} [${stale.sessionKey}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  const throttle = new DeliveryThrottle();

  // ── v1.2: Dispatch acknowledgment tracking + early no-activity detection ──
  const ackTracker = new DispatchAckTracker(
    options?.bagDbPath ? path.join(path.dirname(options.bagDbPath), "dispatch-acks.db") : undefined,
  );

  /**
   * Post a comment on a Linear ticket via the GraphQL API.
   * Used by NoActivityDetector to notify when dispatches fail silently.
   */
  async function postLinearComment(agentId: string, ticketId: string, message: string): Promise<boolean> {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    if (!token) {
      log.warn(`No Linear token for comment post on ${ticketId}`);
      return false;
    }
    const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    const identifier = ticketId.replace(/^linear-/, "");
    try {
      // Fetch issue ID
      const issueRes = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader },
        body: JSON.stringify({
          query: `query($id: String!) { issue(id: $id) { id } }`,
          variables: { id: identifier },
        }),
      });
      const issueBody = (await issueRes.json()) as { data?: { issue?: { id: string } | null } };
      const issueId = issueBody.data?.issue?.id;
      if (!issueId) return false;
      // Post comment
      const commentRes = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader },
        body: JSON.stringify({
          query: `mutation($issueId: ID!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`,
          variables: { issueId, body: message },
        }),
      });
      return commentRes.ok;
    } catch (err) {
      log.error(`Linear comment failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  const watchdog = new DispatchWatchdog(
    { bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig, resignalOptions },
  );
  watchdog.start();

  const noActivityDetector = new NoActivityDetector(
    { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig, resignalOptions, postLinearComment },
  );
  noActivityDetector.start();

  // ── Managing-state stewardship poller ────────────────────────────────
  // Wakes agents on a cadence to review Managing-state tickets (parent /
  // externally-blocked work the agent has claimed responsibility for but
  // can't push forward right now). Per-ticket interval is set via a
  // `Managing-interval: <duration>` marker in the issue description;
  // default is 30 minutes.
  const managingStateStore = new ManagingStateStore(options?.managingStateDbPath);
  const managingPoller = new ManagingPoller({
    store: managingStateStore,
    operationalEventStore,
    deliveryConfig: wakeConfig,
  });
  managingPoller.start();

  // Operator nudge endpoint — sends a short instruction into an already-active
  // agent session. Phase 1 is local/Nakazawa only; no cross-gateway routing.
  app.post("/nudge", async (req: express.Request, res: express.Response) => {
    if (!requireAdminSecret(req, res)) return;

    let body: { agent?: string; ticketId?: string; message?: string } | null;
    try {
      body = parseJsonBody(req);
    } catch {
      res.status(400).json({ success: false, error: "Malformed JSON" });
      return;
    }

    const requestedAgent = body?.agent?.trim();
    const ticketId = body?.ticketId?.trim();
    if (!requestedAgent || !ticketId) {
      res.status(400).json({ success: false, error: "agent and ticketId are required" });
      return;
    }

    const agentConfig = getAgents().find((agent) =>
      agent.name === requestedAgent || agent.openclawAgent === requestedAgent,
    );
    const candidates = [...new Set([
      requestedAgent,
      agentConfig?.name,
      agentConfig?.openclawAgent,
    ].filter((value): value is string => Boolean(value)))];
    const activeAgent = candidates.find((agentId) => sessionTracker.isActive(agentId));
    if (!activeAgent) {
      res.status(404).json({ success: false, error: "No active session found" });
      return;
    }

    const sessionId = sessionTracker.getActiveSessionKey(activeAgent);
    if (!sessionId) {
      res.status(404).json({ success: false, error: "No active session found" });
      return;
    }

    const normalizedTicketId = normalizeSessionKey(ticketId).replace(/^linear-/, "");
    const message = body?.message?.trim() ||
      `Recheck ${normalizedTicketId} and continue work. Run linear consider-work ${normalizedTicketId}.`;
    const delivered = await deliverMessageToAgent(activeAgent, sessionId, message, wakeConfig);
    operationalEventStore.append({
      outcome: delivered ? "delivered" : "delivery-failed",
      type: "operator-nudge",
      agent: activeAgent,
      key: normalizeSessionKey(ticketId),
      sessionKey: sessionId,
      deliveryMode: "operator-nudge",
      attemptCount: 1,
      errorSummary: delivered ? null : "Nudge delivery failed",
    });
    if (!delivered) {
      res.status(502).json({ success: false, error: "Nudge delivery failed" });
      return;
    }
    res.json({ success: true, sessionId, agent: activeAgent });
  });

  // v1 admin dashboard — read-only operational UI and safe JSON API.
  app.use("/admin", createAdminRouter({ agentQueue, bag, sessionTracker, operationalEventStore, observationStore, deploymentName: DEPLOYMENT_NAME }));

  app.use("/", createWebhookRouter(
    eventStore,
    nudgeStore,
    agentQueue,
    bag,
    sessionTracker,
    throttle,
    operationalEventStore,
    (agentId, ticketId) => ackTracker.recordDispatch(agentId, ticketId),
    (agentId, ticketId) => {
      const acknowledged = ackTracker.acknowledge(agentId, ticketId);
      if (acknowledged > 0) {
        noActivityDetector.clearWarned(agentId, ticketId);
      }
    },
  ));

  // ── v1.1: Session-end callback endpoint ──────────────────────────────
  // The gateway (via plugin) calls this when an agent's session ends.
  // The connector then checks the bag and sends another wake-up if needed.
  // Auth: x-session-end-secret header must match SESSION_END_SECRET env.
  app.post("/session-end", async (req: express.Request, res: express.Response) => {
    // Auth check — shared secret via constant-time compare
    const secret = process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-session-end-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    } else {
      log.warn("SESSION_END_SECRET not set — /session-end is unauthenticated (set env var for production)");
    }

    // Parse body — parent express.raw() middleware captures it as Buffer
    let body: { agentId?: string };
    try {
      if (Buffer.isBuffer(req.body)) {
        body = JSON.parse(req.body.toString("utf8"));
      } else if (typeof req.body === "object" && req.body !== null) {
        body = req.body;
      } else {
        res.status(400).json({ error: "Invalid body" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Malformed JSON" });
      return;
    }

    const { agentId } = body;
    if (!agentId) {
      res.status(400).json({ error: "agentId is required" });
      return;
    }
    log.info(`Session-end callback received for ${agentId}`);
    const queuedTickets = sessionTracker.endSession(agentId);
    // Re-arm any tickets that were deferred because the agent was at capacity.
    noActivityDetector.checkDeferredOnSessionEnd(agentId).catch((err) => {
      log.error(`checkDeferredOnSessionEnd failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Acknowledge dispatches for this agent — the session completed (even briefly).
    ackTracker.acknowledge(agentId);
    // Clear no-activity warnings for any sessions that just ended.
    const activeKeys = sessionTracker.getActiveSessionKeys(agentId); // Already ended, so empty — but clear anyway.
    noActivityDetector.clearWarned(agentId, "*");
    // Also drain any dispatched-but-unconfirmed bag entries for this agent.
    // These were dispatched on HTTP 200 but not confirmed as processed.
    const bagTickets = bag.getPendingTickets(agentId).map(e => e.ticketId);
    if (bagTickets.length > 0) bag.clearAgent(agentId);
    // Normalize queued tickets so dedup works correctly vs already-normalized bag IDs.
    const queuedNormalized = (queuedTickets ?? []).map(t => normalizeSessionKey(t));
    const allPending = [...new Set([...queuedNormalized, ...bagTickets])];
    operationalEventStore.append({
      outcome: "session-ended", agent: agentId, deliveryMode: "session-end-callback",
      detail: { queuedTickets: queuedTickets ?? [], bagTickets, allPending }
    });
    if (allPending.length > 0) {
      // Re-signal: agent has work waiting. Send one signal per ticket so each
      // issue is delivered into its own canonical per-ticket session key.
      try {
        await resignalPendingTickets(agentId, allPending, bag, sessionTracker, wakeConfig, { markActive: true });
      } catch (err) {
        log.error(`Session-end re-signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      res.json({ ok: true, pendingTickets: allPending.length });
    } else {
      res.json({ ok: true, pendingTickets: 0 });
    }
  });

  // ── v1.1: Metrics endpoint ───────────────────────────────────────────
  // Auth: x-metrics-secret header must match METRICS_SECRET env.
  // Falls back to SESSION_END_SECRET if METRICS_SECRET is not set.
  app.get("/metrics", (req: express.Request, res: express.Response) => {
    const secret = process.env.METRICS_SECRET ?? process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-metrics-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    } else {
      log.warn("METRICS_SECRET not set — /metrics is unauthenticated (set env var for production)");
    }
    const activeSessions = sessionTracker.getActiveAgents();
    res.json({
      bag: bag.getStats(),
      agentStats: bag.getAgentStats(),
      activeSessions,
      activeSessionDetails: activeSessions.map((agentId) => sessionTracker.getActiveSessionInfo(agentId)),
    });
  });

  return { app, agentQueue, bag, sessionTracker, operationalEventStore, wakeConfig, wakeConfigForAgent, resignalOptions, ackTracker, watchdog, noActivityDetector, managingPoller, managingStateStore };
}

/**
 * Recover queue backlog left behind by prior process state. For each agent
 * with active or queued items, walk the queue via complete() in a loop —
 * each call marks the active row completed and promotes the next queued.
 * Items are delivered as they're promoted. Errors per item are logged and
 * the drain continues so one bad item can't strand the rest.
 */
async function drainBacklog(agentQueue: AgentQueue): Promise<void> {
  const agents = agentQueue.agentsWithBacklog();
  if (agents.length === 0) {
    log.info("Startup drain: no backlog to recover.");
    return;
  }
  const deliveryConfig = {
    nodeBin: process.execPath,
    hooksUrl: process.env.OPENCLAW_HOOKS_URL,
    hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
    hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
    hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
  };
  log.info(`Startup drain: recovering backlog for ${agents.length} agent(s): ${agents.join(", ")}`);
  for (const agentId of agents) {
    let drained = 0;
    let next = agentQueue.complete(agentId);
    while (next) {
      log.info(`Startup drain: delivering recovered task for ${agentId} [${next.sessionKey}]`);
      try {
        await deliverToAgent(next, deliveryConfig);
      } catch (err) {
        log.error(`Startup drain: delivery failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      drained++;
      next = agentQueue.complete(agentId);
    }
    log.info(`Startup drain: ${agentId} drained ${drained} task(s).`);
  }
}

// Only start listening when this file is the entry point, not when imported by tests
const isEntryPoint = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isEntryPoint) {
  const agents = getAgents();
  log.info(`Starting connector [${DEPLOYMENT_NAME}] with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);

  // Watch agents.json for external changes — no restart needed to add agents
  watchAgentsFile();

  // Start token refresh for all configured agents
  if (agents.length > 0) {
    startTokenRefresh();
  }

  const { app, agentQueue, bag, sessionTracker, operationalEventStore, wakeConfig, resignalOptions, ackTracker, watchdog, noActivityDetector } = createApp();
  const server = app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector [${DEPLOYMENT_NAME}] listening on port ${PORT} (pid=${process.pid})`);
    // Recover any backlog left behind by prior process state (v1.0 queue).
    drainBacklog(agentQueue).catch((err) => {
      log.error(`Startup drain failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Replay persisted pending-bag work left behind by a prior process restart.
    replayPendingBag(bag, sessionTracker, wakeConfig, operationalEventStore, {
      ...resignalOptions,
      onDispatched: (agentId, ticketId) => ackTracker.recordDispatch(agentId, ticketId),
    }).catch((err) => {
      log.error(`Startup replay failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // Graceful shutdown — drain in-flight connections before exit
  function shutdown(signal: string) {
    log.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      log.info("Server closed. Exiting.");
      process.exit(0);
    });
    // Force exit after 8s if drain stalls (systemd SendSIGKILL fires at 10s)
    setTimeout(() => {
      log.warn("Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 8000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
