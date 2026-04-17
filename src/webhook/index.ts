import crypto from "crypto";
import { Router, Request, Response } from "express";
import { verifyLinearSignature } from "./signature";
import { normalizeLinearEvent } from "./normalize";
import { LinearEvent } from "./schema";
import { EventStore } from "../store/event-store";
import { routeEvent } from "../router";
import { createSessionAndEmitThought, emitResponse } from "../agent-session";
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
      log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
      log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);

      // ── 2. Get raw body ────────────────────────────────────────────────────
      const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
      log.info(`Raw body length: ${rawBody?.length || 0} bytes`);

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
      log.info(`Signature validation result: ${signatureValid ? "valid" : "invalid"}`);
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
      log.info("JSON parsed successfully");
      } catch {
        res.status(400).json({ error: "Malformed JSON payload" });
        return;
      }

      // ── 6. Normalize event ────────────────────────────────────────────────
      let event: LinearEvent;
      try {
        event = normalizeLinearEvent(payload);
      log.info(`Event normalized: type=${event.type}`);
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
      log.info(`Checking duplicate for delivery: ${deliveryId}`);
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // ── 8. Acknowledge immediately ────────────────────────────────────────
      res.status(200).json({ ok: true });

      // Record event for dedup & restart recovery
      eventStore?.recordEvent(deliveryId, payload as object);

      // ── 9. Route to agent ─────────────────────────────────────────────────
      log.info(`Normalized event: type=${event.type} hasData=${"data" in event} dataKeys=${event.data ? Object.keys(event.data as object).join(',') : 'none'}`);

      // AgentSessionEvent — create session for Linear UI widget
      if (event.type === "AgentSessionEvent") {
        // Create a Linear agent session to show "Agent working" widget
        // This is separate from OpenClaw agent routing
        const data = (event.data as Record<string, unknown> | undefined) ?? {};
        const sessionData = (data.agentSession as Record<string, unknown> | undefined) ?? {};
        const issueData = (sessionData.issue as Record<string, unknown> | undefined) ?? {};
        const issueId = issueData.id as string | undefined;
        if (!issueId) {
          log.warn("AgentSessionEvent has no issue data - skipping session creation");
          return;
        }
        // Extract agent name from event data (for session creation)
        const agentName = (sessionData.user as { name?: string } | undefined)?.name || "unknown";
        let agentSessionId: string | null = null;
        try {
          const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
            identifier: issueData.identifier as string | undefined,
            title: issueData.title as string | undefined,
            description: issueData.description as string | undefined,
          });
          agentSessionId = sessionResult.sessionId;
        } catch (err) {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

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
      let agentSessionId: string | null = null;

      if (issueId && event.type === "Issue") {
        try {
          const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
            identifier: data?.identifier as string | undefined,
            title: data?.title as string | undefined,
            description: data?.description as string | undefined,
          });
          agentSessionId = sessionResult.sessionId;
        } catch (err) {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        }
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

        // Build routing-reason-specific message
        const reason = route.routingReason ?? "assignee";
        let reasonText: string;
        switch (reason) {
          case "delegate":
            reasonText = `You were delegated ${identifier}: ${title}.\n\nThe assignee field may show someone else (the workflow owner), but YOU are the delegate — this task is yours to action.`;
            break;
          case "assignee":
            reasonText = `You were assigned to ${identifier}: ${title}.`;
            break;
          case "mention":
          case "body-mention":
            reasonText = `You were mentioned on ${identifier}: ${title}.`;
            break;
          default:
            reasonText = `You were mentioned or assigned on ${identifier}: ${title}.`;
        }
        const message = `[NEW TASK] ${reasonText}\n\nIMPORTANT: Fetch the FULL issue details INCLUDING comment history. The task brief may be in the description OR in the comments.\n\nRun these commands:\n  linear issue ${identifier}\n  linear comments ${identifier}\n\nReview both the description AND comments for your task brief before taking action.`;
        const sessionId = route.sessionKey;

        // Fire-and-forget delivery — send message to agent's Telegram session
        // Use message send instead of agent to avoid creating isolated sessions
        const deliveryCmd = `${nodeBin} ${openclawScript} message send --channel telegram --target -1003712293789 --message ${JSON.stringify(message)}`;
        const child = require("child_process").spawn(nodeBin, [
          openclawScript, "message", "send",
          "--channel", "telegram",
          "--target", "-1003712293789",
          "--message", message,
        ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        child.unref();
        log.info(`Delivery spawned for ${agentName} [${sessionId}]`);
        // Note: Linear agent session stays open until agent responds via comment.
        // We don't close it here because we're just delivering a message,
        // not starting an agent process that will run and exit.
      } catch (err) {
        log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return router;
}
