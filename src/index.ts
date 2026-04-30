import 'dotenv/config';
import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook/index.js";
import { startTokenRefresh } from "./token-refresh.js";
import { getAgents, watchAgentsFile } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { handleOAuthCallback } from "./oauth-callback.js";
import { normalizeSessionKey } from "./session-key.js";
import { EventStore } from "./store/event-store.js";
import { NudgeStore } from "./store/nudge-store.js";
import { AgentQueue } from "./queue/index.js";
import { deliverToAgent, DeliveryThrottle } from "./delivery/index.js";
import { PendingWorkBag, SessionTracker } from "./bag/index.js";
import { sendWakeUpSignal } from "./bag/wake-up.js";
import crypto from "crypto";

const log = componentLogger(createLogger(), "server");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
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

export interface CreateAppOptions {
  /** Override PendingWorkBag database path (for testing). */
  bagDbPath?: string;
}

export function createApp(options?: CreateAppOptions) {
  const app = express();
  app.set("trust proxy", true);

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
  const agentQueue = new AgentQueue();
  const bag = new PendingWorkBag(options?.bagDbPath);
  const sessionTracker = new SessionTracker();
  const throttle = new DeliveryThrottle();
  app.use("/", createWebhookRouter(eventStore, nudgeStore, agentQueue, bag, sessionTracker, throttle));

  // ── v1.1: Session-end callback endpoint ──────────────────────────────
  // The gateway (via plugin) calls this when an agent's session ends.
  // The connector then checks the bag and sends another wake-up if needed.
  // Auth: x-session-end-secret header must match SESSION_END_SECRET env.
  app.post("/session-end", (req: express.Request, res: express.Response) => {
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
    const pendingTickets = sessionTracker.endSession(agentId);
    if (pendingTickets && pendingTickets.length > 0) {
      // Re-signal: agent has work waiting
      const wakeConfig = {
        nodeBin: process.execPath,
        hooksUrl: process.env.OPENCLAW_HOOKS_URL,
        hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
        hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
        hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
      };
      // Clear bag BEFORE sending signal (race fix: don't start session until signal succeeds)
      bag.clearAgent(agentId);
      bag.recordSignal();
      // Normalize the re-signal key to exactly `linear-<TEAM>-<NUMBER>`.
      const resignalKey = normalizeSessionKey(pendingTickets[0]);
      sendWakeUpSignal(agentId, pendingTickets, wakeConfig)
        .then(() => {
          // Only mark session as active AFTER successful signal
          sessionTracker.startSession(agentId, resignalKey);
        })
        .catch((err) => {
          log.error(`Re-signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
          // Don't start session on failure — agent will be re-signaled on next webhook
        });
      res.json({ ok: true, pendingTickets: pendingTickets.length });
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
    res.json({
      bag: bag.getStats(),
      agentStats: bag.getAgentStats(),
      activeSessions: sessionTracker.getActiveAgents(),
    });
  });

  return { app, agentQueue, bag, sessionTracker };
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

  const { app, agentQueue } = createApp();
  const server = app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector [${DEPLOYMENT_NAME}] listening on port ${PORT} (pid=${process.pid})`);
    // Recover any backlog left behind by prior process state.
    drainBacklog(agentQueue).catch((err) => {
      log.error(`Startup drain failed: ${err instanceof Error ? err.message : String(err)}`);
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
