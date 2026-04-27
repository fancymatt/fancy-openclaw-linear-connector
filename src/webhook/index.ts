import crypto from "crypto";
import { Router, Request, Response } from "express";
import { verifyLinearSignatureMulti, parseWebhookSecrets } from "./signature.js";
import { normalizeLinearEvent } from "./normalize.js";
import type { LinearEvent } from "./schema.js";
import { EventStore } from "../store/event-store.js";
import { NudgeStore } from "../store/nudge-store.js";
import { routeEvent } from "../router.js";
import { createSessionAndEmitThought, emitResponse } from "../agent-session.js";
import { deliverToAgent, DeliveryThrottle } from "../delivery/index.js";
import { AgentQueue } from "../queue/index.js";
import { PendingWorkBag, SessionTracker } from "../bag/index.js";
import { sendWakeUpSignal, type WakeUpConfig } from "../bag/wake-up.js";
import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(), "webhook");

export type { LinearEvent } from "./schema.js";
export { verifyLinearSignature } from "./signature.js";
export { normalizeLinearEvent } from "./normalize.js";

/**
 * Creates the Express router for the Linear webhook endpoint.
 *
 * The router expects that the parent Express app has been configured to
 * preserve the raw body buffer on `req.rawBody` via `express.raw()` for this
 * route — signature validation requires the exact bytes as received.
 *
 * Environment variables consumed:
 *   LINEAR_WEBHOOK_SECRETS — comma-separated list of HMAC secrets (new, supports private teams)
 *   LINEAR_WEBHOOK_SECRET  — single HMAC secret (legacy, backward compatible)
 */
const NUDGE_DEDUP_WINDOW_MS = parseInt(process.env.NUDGE_DEDUP_WINDOW_MS ?? "120000", 10);

export function createWebhookRouter(
  eventStore?: EventStore,
  nudgeStore?: NudgeStore,
  agentQueue?: AgentQueue,
  bag?: PendingWorkBag,
  sessionTracker?: SessionTracker,
  throttle?: DeliveryThrottle,
): Router {
  const router = Router();

  if (NUDGE_DEDUP_WINDOW_MS > 0) {
    log.info(`Nudge dedup enabled: ${NUDGE_DEDUP_WINDOW_MS}ms window`);
  }

  router.get("/", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
  });

  router.post(
    "/",
    async (req: Request, res: Response): Promise<void> => {
      const secrets = parseWebhookSecrets();

      // ── 1. Debug: log relevant headers ──────────────────────────────────
      log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);
      log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
      log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);

      // ── 2. Get raw body ────────────────────────────────────────────────────
      const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
      log.info(`Raw body length: ${rawBody?.length || 0} bytes`);

      // ── 3. Signature validation (skip if no secret configured) ────────────
      if (secrets.length > 0) {
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

        const signatureValid = verifyLinearSignatureMulti(rawBody, signature as string, secrets);
      log.info(`Signature validation result: ${signatureValid ? "valid" : "invalid"}`);
        if (!signatureValid) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      } else {
        log.warn("No LINEAR_WEBHOOK_SECRETS or LINEAR_WEBHOOK_SECRET set — skipping signature validation");
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

      // ── 9a. Nudge deduplication + coalescing ─────────────────────────────
      // Suppress rapid-fire duplicate events for the same agent+ticket.
      const ticketId = route.sessionKey;
      if (NUDGE_DEDUP_WINDOW_MS > 0 && nudgeStore) {
        const info = nudgeStore.getCoalesceInfo(route.agentId, ticketId, NUDGE_DEDUP_WINDOW_MS);
        if (info.suppressed) {
          log.info(`Nudge dedup: coalescing delivery for ${route.agentId} [${ticketId}] — within ${NUDGE_DEDUP_WINDOW_MS}ms window`);
          nudgeStore.recordCoalesced(route.agentId, ticketId, event.type, "action" in event ? event.action : undefined);
          return;
        }
        // Window expired — drain coalesced count before delivering
        const coalescedCount = nudgeStore.drainCoalescedCount(route.agentId, ticketId);
        nudgeStore.recordNudge(route.agentId, ticketId);
        if (coalescedCount > 0) {
          log.info(`Nudge dedup: delivering for ${route.agentId} [${ticketId}] with ${coalescedCount} coalesced event(s)`);
          route.coalescedCount = coalescedCount;
        }
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

      // ── v1.1: Pull-based wake-up via PendingWorkBag ─────────────────────
      // Add to bag (deduped by ticket ID). Send wake-up signal only if
      // agent has no active session. Bursts collapse to 1 signal.
      if (bag && sessionTracker) {
        bag.add(agentName, ticketId, event.type);
        const pending = bag.getPendingTickets(agentName);
        const pendingIds = pending.map((e) => e.ticketId);

        if (sessionTracker.isActive(agentName)) {
          // Agent is busy — queue signal for session-end
          sessionTracker.queueSignal(agentName, [ticketId]);
          log.info(`Bag: added ${ticketId} for ${agentName}, queuing signal (session active)`);
          return;
        }

        // No active session — send wake-up signal
        log.info(`Bag: sending wake-up signal to ${agentName} with ${pendingIds.length} ticket(s)`);
        sessionTracker.startSession(agentName, `wake-up-${Date.now()}`);
        bag.recordSignal();

        const wakeConfig: WakeUpConfig = {
          nodeBin: process.execPath,
          hooksUrl: process.env.OPENCLAW_HOOKS_URL,
          hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
          hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
          hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
        };
        try {
          await sendWakeUpSignal(agentName, pendingIds, wakeConfig);
        } catch (err) {
          log.error(`Wake-up signal failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
          sessionTracker.endSession(agentName);
        }
        return;
      }

      // ── v1.0 fallback: Agent queue with ticket-level coalescing ─────────
      if (agentQueue) {
        const queueResult = agentQueue.enqueueOrCoalesce(route);
        if (queueResult.action === "active-busy") {
          log.info(`Agent queue: ${route.agentId} already has active task for [${ticketId}] — skipping`);
          return;
        }
        if (queueResult.action === "coalesced") {
          log.info(`Agent queue: coalesced queued event for ${route.agentId} [${ticketId}]`);
          return;
        }
        if (queueResult.action === "queued") {
          log.info(`Agent queue: queued event for ${route.agentId} [${ticketId}] (active task for different ticket)`);
          return;
        }
        log.info(`Agent queue: delivering immediately for ${route.agentId} [${ticketId}]`);
      }

      const deliveryConfig = {
        nodeBin: process.execPath,
        hooksUrl: process.env.OPENCLAW_HOOKS_URL,
        hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
        hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
        hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
      };
      try {
        if (throttle) {
          log.info(`Dispatch throttle: waiting for ${agentName}`);
          await throttle.wait(route.agentId);
          throttle.record(route.agentId);
        }
        await deliverToAgent(route, deliveryConfig);
      } catch (err) {
        log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (agentQueue) {
          let next = agentQueue.complete(route.agentId);
          while (next) {
            log.info(`Agent queue: promoting next task for ${route.agentId} [${next.sessionKey}]`);
            try {
              if (throttle) {
                log.info(`Dispatch throttle: waiting for ${route.agentId} (drain)`);
                await throttle.wait(route.agentId);
                throttle.record(route.agentId);
              }
              await deliverToAgent(next, deliveryConfig);
            } catch (err) {
              log.error(`Agent queue: failed to deliver promoted task for ${route.agentId}: ${err instanceof Error ? err.message : String(err)}`);
            }
            next = agentQueue.complete(route.agentId);
          }
        }
      }
    },
  );

  return router;
}
