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
import { PendingWorkBag, SessionTracker, DispatchAckTracker, DispatchWatchdog, NoActivityDetector, StuckDelegateDetector, resignalPendingTickets, replayPendingBag, ManagingPoller } from "./bag/index.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./bag/wake-up.js";
import { normalizeSessionKey } from "./session-key.js";
import { applyEngagementStatus } from "./engagement-status.js";
import { createAdminRouter } from "./admin.js";
import { buildSnapshot, writeSnapshot, appendDigestEntry, fetchLinearTicketState, recoverTicket, STALE_CLASS_NAMES, type StaleSnapshot, type ForensicsConfig } from "./bag/stale-session-forensics.js";
import { registerDistillationCron } from "./cron/p4-metrics-distillation.js";
import { registerRescueSweepCron } from "./cron/rescue-sweep-cron.js";
import { registerG20CanaryCron } from "./cron/g20-canary-runner.js";
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
    } else if (recovery.rePoke) {
      // AI-1578 (AC2): C4 first stall — recoverTicket retained the delegate and
      // changed no state. Re-wake the SAME delegate to resume + run its verb,
      // rather than letting the ticket sit orphaned.
      const ticketId = snapshot.metadata.ticketId;
      const sessionKey = normalizeSessionKey(ticketId);
      const rePokeMsg =
        `Your session for ${ticketId.replace(/^linear-/, "")} stalled before producing output. ` +
        `Resume now and run the pending transition verb to hand off. Do NOT reply HEARTBEAT_OK.`;
      log.info(`Stale C4 re-poke: re-waking ${stale.agentId} for ${ticketId}`);
      const delivered = await deliverMessageToAgent(stale.agentId, sessionKey, rePokeMsg, wakeConfigForAgent(stale.agentId));
      operationalEventStore.append({
        outcome: delivered.dispatched ? "stale-c4-repoke" : "stale-c4-repoke-failed",
        agent: stale.agentId,
        key: sessionKey,
        sessionKey,
        deliveryMode: "stale-c4-repoke",
        attemptCount: 1,
        errorSummary: delivered.dispatched ? null : "C4 re-poke delivery failed",
      });
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

  /**
   * AI-1510: drive the non-authoritative engagement-status overlay (To Do →
   * Thinking → Doing) using the delegate agent's vaulted token. Fire-and-forget;
   * fail-open inside the helper so a status flip never blocks dispatch/session-end.
   */
  function flipEngagementStatus(agentId: string, ticketId: string, semantic: "thinking" | "doing" | "todo"): void {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    void applyEngagementStatus(ticketId, semantic, token);
    const outcomeMap = { thinking: "engagement-thinking", doing: "engagement-doing", todo: "engagement-todo" } as const;
    try {
      operationalEventStore.append({
        outcome: outcomeMap[semantic],
        agent: agentId,
        key: normalizeSessionKey(ticketId),
        type: "engagement",
      });
    } catch {
      // fire-and-forget: never block on observability
    }
  }

  const watchdog = new DispatchWatchdog(
    { bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig, wakeConfigForAgent, resignalOptions },
  );
  watchdog.start();

  const noActivityDetector = new NoActivityDetector(
    { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig, wakeConfigForAgent, resignalOptions, postLinearComment },
  );
  noActivityDetector.start();

  // ── Stuck-delegate detector (AI-1578 / AI-1451) ──────────────────────
  // Re-prompts delegates who posted a completion comment but never ran the
  // transition verb — the connector-native signal for "work landed but the
  // verb is missing" (the connector has no GitHub/PR awareness, so the
  // delegate's own completion comment is the observable "I'm done" signal).
  // Retains the delegate and re-pokes rather than orphaning. Per-agent wake
  // routing (wakeConfigForAgent) so containerized dev agents resolve their
  // own hooks endpoint.
  const stuckDelegateDetector = new StuckDelegateDetector({
    sessionTracker,
    bag,
    operationalEventStore,
    deliveryConfig: wakeConfig,
    sendWake: async (agentOpenclawName, ticketId, prompt) => {
      const result = await deliverMessageToAgent(
        agentOpenclawName,
        normalizeSessionKey(ticketId),
        prompt,
        wakeConfigForAgent(agentOpenclawName),
      );
      return result.dispatched;
    },
  });
  stuckDelegateDetector.start();

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

  // ── AC1 (AI-1560): Pull-pickup engagement endpoints ──────────────────────
  // Agents that claim work via `linear queue --next` (self-pull) never go
  // through the connector's dispatch path, so the Thinking/Doing hooks never
  // fire. These endpoints let the agent signal the same lifecycle as a
  // connector-dispatched ticket.
  //
  // POST /pull-ack   — agent read/claimed the ticket → Thinking
  // POST /pull-ack-activity — agent authored first activity → Doing

  function parsePullBody(req: express.Request, res: express.Response): { agentId: string; ticketId: string } | null {
    let body: { agentId?: string; ticketId?: string } | null;
    try {
      body = parseJsonBody(req);
    } catch {
      res.status(400).json({ error: "Malformed JSON" });
      return null;
    }
    if (!body?.agentId || !body?.ticketId) {
      res.status(400).json({ error: "agentId and ticketId are required" });
      return null;
    }
    return { agentId: body.agentId, ticketId: body.ticketId };
  }

  app.post("/pull-ack", (req: express.Request, res: express.Response) => {
    const secret = process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-session-end-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    const parsed = parsePullBody(req, res);
    if (!parsed) return;
    const { agentId, ticketId } = parsed;
    ackTracker.recordDispatch(agentId, ticketId);
    flipEngagementStatus(agentId, ticketId, "thinking");
    res.json({ ok: true });
  });

  app.post("/pull-ack-activity", (req: express.Request, res: express.Response) => {
    const secret = process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-session-end-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    const parsed = parsePullBody(req, res);
    if (!parsed) return;
    const { agentId, ticketId } = parsed;
    ackTracker.acknowledge(agentId, ticketId);
    flipEngagementStatus(agentId, ticketId, "doing");
    res.json({ ok: true });
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
    (agentId, ticketId) => {
      ackTracker.recordDispatch(agentId, ticketId);
      // AI-1510: agent has read the ticket via the connector → Thinking.
      flipEngagementStatus(agentId, ticketId, "thinking");
    },
    (agentId, ticketId) => {
      const acknowledged = ackTracker.acknowledge(agentId, ticketId);
      if (acknowledged > 0) {
        noActivityDetector.clearWarned(agentId, ticketId);
      }
      // AI-1510: agent authored Linear activity → actively working → Doing.
      flipEngagementStatus(agentId, ticketId, "doing");
    },
    // AI-1538: register a pending dispatch expectation at delivery-commit so a
    // swallowed delivery self-heals via the watchdog.
    (agentId, ticketId) => ackTracker.ensurePending(agentId, ticketId),
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
    // AI-1510: capture the agent's active ticket keys BEFORE endSession clears
    // them, so we can reset native status → To Do for each ticket the agent is
    // releasing. (This handler ends ALL of the agent's sessions.)
    const endedKeys = sessionTracker.getActiveSessionKeys(agentId);
    const queuedTickets = sessionTracker.endSession(agentId);
    // Reset engagement status to To Do for each released ticket — but only if no
    // successor (post-handoff delegate) already holds it. Handoff dispatches the
    // successor's startSession synchronously, so this guard is reliable.
    for (const key of endedKeys) {
      if (!sessionTracker.isTicketActiveForAnyAgent(key, agentId)) {
        flipEngagementStatus(agentId, key, "todo");
      }
    }
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
        await resignalPendingTickets(agentId, allPending, bag, sessionTracker, wakeConfigForAgent(agentId), { markActive: true });
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

  return { app, agentQueue, bag, sessionTracker, operationalEventStore, observationStore, wakeConfig, wakeConfigForAgent, resignalOptions, ackTracker, watchdog, noActivityDetector, managingPoller, managingStateStore };
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

  const { app, agentQueue, bag, sessionTracker, operationalEventStore, observationStore, wakeConfig, wakeConfigForAgent, resignalOptions, ackTracker, watchdog, noActivityDetector } = createApp();

  // P4-3: periodic distillation of reject metrics into skill-workshop proposals
  registerDistillationCron(observationStore);
  // AI-1566: periodic rescue sweep — detect and repair dormant/malformed wf:* tickets
  registerRescueSweepCron();

  // G-20: scheduled gate-silently-off canary (AI-1552, §5.1)
  registerG20CanaryCron();

  const server = app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector [${DEPLOYMENT_NAME}] listening on port ${PORT} (pid=${process.pid})`);
    // Recover any backlog left behind by prior process state (v1.0 queue).
    drainBacklog(agentQueue).catch((err) => {
      log.error(`Startup drain failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Replay persisted pending-bag work left behind by a prior process restart.
    replayPendingBag(bag, sessionTracker, wakeConfig, operationalEventStore, {
      ...resignalOptions,
      wakeConfigForAgent,
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
