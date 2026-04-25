import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook";
import { startTokenRefresh } from "./token-refresh";
import { getAgents, watchAgentsFile } from "./agents";
import { createLogger, componentLogger } from "./logger";
import { handleOAuthCallback } from "./oauth-callback";

const log = componentLogger(createLogger(), "server");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

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
      agents: agents.length,
      agentNames: agents.map((a) => a.name),
    });
  });

  // OAuth callback — handles Linear app authorization flow
  app.get("/callback", handleOAuthCallback);

  // Webhook routes — pass the event store from the dedup module
  const { EventStore } = require("./store/event-store");
  const { NudgeStore } = require("./store/nudge-store");
  const eventStore = new EventStore();
  const nudgeStore = new NudgeStore();
  app.use("/", createWebhookRouter(eventStore, nudgeStore));

  return app;
}

// Only start listening when this file is the entry point, not when imported by tests
if (require.main === module) {
  const agents = getAgents();
  log.info(`Starting connector with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);

  // Watch agents.json for external changes — no restart needed to add agents
  watchAgentsFile();

  // Start token refresh for all configured agents
  if (agents.length > 0) {
    startTokenRefresh();
  }

  const app = createApp();
  const server = app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector listening on port ${PORT} (pid=${process.pid})`);
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
