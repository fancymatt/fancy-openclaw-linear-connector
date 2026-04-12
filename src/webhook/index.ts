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
    (req: Request, res: Response): void => {
      const secret = process.env.LINEAR_WEBHOOK_SECRET;

      // ── 1. Signature header presence ──────────────────────────────────────
      const signature = req.headers["x-linear-signature"];
      if (!signature || typeof signature !== "string") {
        res.status(400).json({
          error: "Missing x-linear-signature header",
        });
        return;
      }

      // ── 2. Secret configured ──────────────────────────────────────────────
      if (!secret) {
        log.error("LINEAR_WEBHOOK_SECRET is not set — rejecting all requests");
        res.status(500).json({ error: "Server misconfiguration" });
        return;
      }

      // ── 3. Raw body available ─────────────────────────────────────────────
      const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        res.status(400).json({ error: "Empty or unreadable request body" });
        return;
      }

      // ── 4. HMAC signature validation ──────────────────────────────────────
      const signatureValid = verifyLinearSignature(rawBody, signature, secret);
      if (!signatureValid) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      // ── 5. Parse JSON payload ─────────────────────────────────────────────
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
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
        crypto.createHash("sha256").update(rawBody).digest("hex");

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

      // TODO: deliver to OpenClaw gateway via HttpOpenClawDeliveryAdapter
      log.info(`Event processing complete for ${agentName}`);
    },
  );

  return router;
}
