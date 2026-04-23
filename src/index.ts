import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook";
import { startTokenRefresh } from "./token-refresh";
import { getAgents } from "./agents";
import { createLogger, componentLogger } from "./logger";

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

  // Webhook routes — pass the event store from the dedup module
  const { EventStore } = require("./store/event-store");
  const eventStore = new EventStore();
  app.use("/", createWebhookRouter(eventStore));

  return app;
}

// Only start listening when this file is the entry point, not when imported by tests
if (require.main === module) {
  const agents = getAgents();
  log.info(`Starting connector with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);

  // Start token refresh for all configured agents
  if (agents.length > 0) {
    startTokenRefresh();
  }

  const app = createApp();
  app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector listening on port ${PORT}`);
  });
}
