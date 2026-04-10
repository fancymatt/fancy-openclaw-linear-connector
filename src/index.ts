import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export function createApp() {
  const app = express();

  // Raw body capture for webhook signature validation.
  // Must be registered before any JSON body parser so we get the exact bytes.
  app.use(
    "/webhooks",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    }
  );

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
  });

  // Webhook routes
  app.use("/webhooks", createWebhookRouter());

  return app;
}

// Only start listening when this file is the entry point, not when imported by tests
if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(
      `[server] fancy-openclaw-linear-connector listening on port ${PORT}`
    );
  });
}
