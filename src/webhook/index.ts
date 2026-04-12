import crypto from "crypto";
import { Router, Request, Response } from "express";
import { verifyLinearSignature } from "./signature";
import { normalizeLinearEvent } from "./normalize";
import { LinearEvent } from "./schema";
import { EventStore } from "../store/event-store";
import { routeEvent } from "../router";
import { createSessionAndEmitThought } from "../agent-session";
import { getOpenclawAgentName } from "../agents";
import { createLogger, componentLogger } from "../logger";

const log = componentLogger(createLogger(), "webhook");

export { LinearEvent } from "./schema";
export { verifyLinearSignature } from "./signature";
export { normalizeLinearEvent } from "./normalize";

/**
 * Creates the Express router for the Linear webhook endpoint.
 *
 * The router expects that the parent Express app has been configured to
 * preserve the raw body buffer on `req.rawBody` via `express.raw()` for this
 * route — signature validation requires the exact bytes as received.
 *
 * Environment variables consumed:
 *   LINEAR_WEBHOOK_SECRET  — HMAC secret from the Linear webhook dashboard
 */
export function createWebhookRouter(eventStore?: EventStore): Router {
  const router = Router();

  router.post(
    "/linear",
    async (req: Request, res: Response): Promise<void> => {
      const secret = process.env.LINEAR_WEBHOOK_SECRET;

      // ── 1. Debug: log relevant headers ──────────────────────────────────
      log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);

      // ── 2. Get raw body ────────────────────────────────────────────────────
      const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;

      // ── 3. Signature validation (skip if no secret configured) ────────────
      if (secret) {
        const signature = req.headers["x-linear-signature"] ?? req.headers["linear-signature"];
        if (!signature || typeof signature !== "string") {
          res.status(400).json({
            error: "Missing signature header",
          });
          return;
        }

        if (!rawBody) {
          res.status(400).json({ error: "Empty or unreadable request body" });
          return;
        }

        const signatureValid = verifyLinearSignature(rawBody, signature as string, secret);
        if (!signatureValid) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      } else {
        log.warn("No LINEAR_WEBHOOK_SECRET set — skipping signature validation");
      }

      // ── 4. Parse JSON payload ─────────────────────────────────────────────
      let payload: unknown;
      try {
        const body = rawBody ?? Buffer.from(JSON.stringify(req.body));
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Malformed JSON payload" });
        return;
      }

      // ── 6. Normalize event ────────────────────────────────────────────────
      let event: LinearEvent;
      try {
        event = normalizeLinearEvent(payload);
      } catch (err) {
        res.status(400).json({
          error: "Invalid payload structure",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // ── 7. Deduplication ──────────────────────────────────────────────────
      const deliveryId =
        (req.headers["x-linear-delivery"] as string | undefined) ??
        crypto.createHash("sha256").update(rawBody ?? Buffer.from(JSON.stringify(payload))).digest("hex");

      if (eventStore?.isDuplicate(deliveryId)) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // ── 8. Acknowledge immediately ────────────────────────────────────────
      res.status(200).json({ ok: true });

      // Record event for dedup & restart recovery
      eventStore?.recordEvent(deliveryId, payload as object);

      // ── 9. Route to agent ─────────────────────────────────────────────────
      const route = routeEvent(event);
      if (!route) {
        log.info(`No agent target for event type=${event.type} action=${"action" in event ? event.action : "?"}`);
        return;
      }

      const agentName = route.agentId;
      log.info(`Routed event to ${agentName} [${route.sessionKey}]`);

      // ── 10. Create agent session + emit thought ───────────────────────────
      const data = event.data as Record<string, unknown> | null;
      const issueId = data?.id as string | undefined;

      if (issueId && event.type === "Issue") {
        createSessionAndEmitThought(issueId, agentName, {
          identifier: data?.identifier as string | undefined,
          title: data?.title as string | undefined,
          description: data?.description as string | undefined,
        }).catch((err) => {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      // Deliver to OpenClaw agent
      try {
        const { exec } = require("child_process");
        const { promisify } = require("util");
        const execAsync = promisify(exec);
        const nodeBin = "/home/fancymatt/.nvm/versions/node/v22.22.1/bin/node";
        const openclawScript = "/home/fancymatt/.nvm/versions/node/v22.22.1/bin/openclaw";
        // Extract issue identifier from various event shapes
        const data = (route.event.data ?? {}) as Record<string, unknown>;
        const sessionData = data.agentSession as Record<string, unknown> | undefined;
        const issueData = (data.issue ?? sessionData?.issue ?? data) as Record<string, unknown>;
        const identifier = String(issueData?.identifier ?? route.sessionKey.replace("linear-", ""));
        const title = String(issueData?.title ?? "");
        const message = `[NEW TASK] You were mentioned or assigned on ${identifier}: ${title}. Fetch the issue details and take appropriate action.`;
        const sessionId = route.sessionKey;

        const { stdout, stderr } = await execAsync(
          `${nodeBin} ${openclawScript} agent --agent ${JSON.stringify(agentName)} --session-id ${JSON.stringify(sessionId)} --message ${JSON.stringify(message)}`,
          { timeout: 60_000 }
        );
        log.info(`OpenClaw delivery to ${agentName}: ${(stdout || stderr || "completed").trim().slice(0, 200)}`);
      } catch (err) {
        log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return router;
}
