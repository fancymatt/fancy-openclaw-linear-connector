import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook/index.js";
import { startTokenRefresh } from "./token-refresh.js";
import { getAgents, watchAgentsFile } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { handleOAuthCallback } from "./oauth-callback.js";
import { EventStore } from "./store/event-store.js";
import { NudgeStore } from "./store/nudge-store.js";
import { AgentQueue } from "./queue/index.js";
import { deliverToAgent } from "./delivery/index.js";
import { createTokenSyncRouter } from "./token-sync.js";

const log = componentLogger(createLogger(), "server");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME ?? "fancymatt";

export function createApp() {
  const app = express();

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

  // Token sync endpoint for remote agent hosts
  app.use(createTokenSyncRouter());

  // Webhook routes — pass the event store from the dedup module

  const eventStore = new EventStore();
  const nudgeStore = new NudgeStore();
  const agentQueue = new AgentQueue();
  app.use("/", createWebhookRouter(eventStore, nudgeStore, agentQueue));

  return { app, agentQueue };
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
