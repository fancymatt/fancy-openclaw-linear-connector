import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook/index.js";
import { startTokenRefresh } from "./token-refresh.js";
import { getAgents, watchAgentsFile } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { handleOAuthCallback } from "./oauth-callback.js";
import { EventStore } from "./store/event-store.js";
import { NudgeStore } from "./store/nudge-store.js";
import { AgentQueue } from "./queue/index.js";

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

  // Webhook routes — pass the event store from the dedup module
  const eventStore = new EventStore();
  const nudgeStore = new NudgeStore();
  const agentQueue = new AgentQueue();
  app.use("/", createWebhookRouter(eventStore, nudgeStore, agentQueue));

  return app;
}

// Only start listening when this file is the entry point, not when imported by tests
const isEntryPoint = process.argv[1]?.endsWith('index.js');
if (isEntryPoint) {
  const agents = getAgents();
  log.info(`Starting connector [${DEPLOYMENT_NAME}] with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);

  // Watch agents.json for external changes — no restart needed to add agents
  watchAgentsFile();

  // Start token refresh for all configured agents
  if (agents.length > 0) {
    startTokenRefresh();
  }

  const app = createApp();
  const server = app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector [${DEPLOYMENT_NAME}] listening on port ${PORT} (pid=${process.pid})`);
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
