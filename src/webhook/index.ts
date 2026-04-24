import crypto from "crypto";
import { Router, Request, Response } from "express";
import { verifyLinearSignature } from "./signature";
import { normalizeLinearEvent } from "./normalize";
import { LinearEvent } from "./schema";
import { EventStore } from "../store/event-store";
import { NudgeStore } from "../store/nudge-store";

/** 15-minute suppression window for bulk-delegation noise reduction (AI-348). */
const NUDGE_SUPPRESSION_MS = 15 * 60 * 1000;
const nudgeStore = new NudgeStore();
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

  router.get("/", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
  });

  router.post(
    "/",
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

        // Build routing-reason-specific message.
        // Mentions: full [NEW TASK] push — someone is talking to you directly.
        // Delegate/assignee: lightweight nudge with 15-min suppression (AI-348).
        // Bulk delegations collapse into one nudge; agent pulls queue at own cadence.
        const reason = route.routingReason ?? "assignee";
        let message: string;

        if (reason === "mention" || reason === "body-mention") {
          // Mentions always fire the short, accurate message without delegation boilerplate.
          message = `[NEW TASK] You were mentioned on ${identifier}: ${title}.\n\nRun \`linear observeIssue ${identifier}\` to read the full context.`;
        } else {
          // Delegate/assignee: lightweight nudge with suppression.
          if (nudgeStore.isSuppressed(agentName, identifier, NUDGE_SUPPRESSION_MS)) {
            log.info(`Nudge suppressed for ${agentName} — within 15-min window. ${identifier} silently queued.`);
            return;
          }
          nudgeStore.recordNudge(agentName, identifier);
          const actionText = reason === "delegate"
            ? `You were delegated ${identifier}`
            : `You were assigned ${identifier}`;
          message = `[NEW TASK] ${actionText}. Run \`linear considerWork ${identifier}\` to pick it up.`;
        }
        const sessionId = route.sessionKey;

        // Fire-and-forget delivery.
        // Isolated mode (opt-in): POST to /hooks/agent — creates a fresh ephemeral agent turn.
        // Default mode: spawn openclaw agent CLI — routes to the agent's main session.
        // Enable isolated mode by setting OPENCLAW_HOOKS_URL + OPENCLAW_HOOKS_TOKEN in .env.
        const hooksUrl = process.env.OPENCLAW_HOOKS_URL;
        const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN;

        const DELIVERY_TIMEOUT_MS = 30_000;
        const RETRY_DELAY_MS = 5_000;
        const MAX_RETRIES = 1;

        if (hooksUrl && hooksToken) {
          // Isolated session mode — fetch with timeout + single retry
          let delivered = false;
          for (let attempt = 0; attempt <= MAX_RETRIES && !delivered; attempt++) {
            if (attempt > 0) {
              log.info(`Retrying isolated delivery for ${agentName} [${sessionId}] (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${RETRY_DELAY_MS}ms`);
              await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
              const response = await fetch(hooksUrl, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${hooksToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ agentId: agentName, sessionKey: sessionId, message, thinking: process.env.OPENCLAW_HOOKS_THINKING || undefined, model: process.env.OPENCLAW_HOOKS_MODEL || undefined }),
                signal: controller.signal,
              });
              clearTimeout(timer);
              if (!response.ok) {
                throw new Error(`hooks responded with ${response.status}`);
              }
              const json = await response.json() as { runId?: string };
              log.info(`Isolated delivery dispatched for ${agentName} [${sessionId}]: runId=${json.runId ?? "ok"}`);
              delivered = true;
            } catch (err) {
              log.error(`Isolated delivery attempt ${attempt + 1} failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (!delivered) {
            log.error(`All delivery attempts exhausted for ${agentName} [${sessionId}]`);
          }
        } else {
          // Default mode: route to agent's main session via CLI
          // --channel telegram: required when multiple channels are configured;
          // without an explicit channel OpenClaw fails-closed with "Channel is required" error.
          const spawn = require("child_process").spawn;
          let delivered = false;
          for (let attempt = 0; attempt <= MAX_RETRIES && !delivered; attempt++) {
            if (attempt > 0) {
              log.info(`Retrying CLI delivery for ${agentName} [${sessionId}] (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${RETRY_DELAY_MS}ms`);
              await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
            try {
              delivered = await new Promise<boolean>((resolve) => {
                const child = spawn(nodeBin, [
                  openclawScript, "agent",
                  "--agent", agentName,
                  "--message", message,
                  "--channel", "telegram",
                  "--deliver",
                ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
                child.unref();
                const timer = setTimeout(() => {
                  log.warn(`CLI delivery timed out after ${DELIVERY_TIMEOUT_MS}ms for ${agentName} — killing child`);
                  child.kill("SIGKILL");
                  resolve(false);
                }, DELIVERY_TIMEOUT_MS);
                child.on("exit", (code: number | null) => {
                  clearTimeout(timer);
                  if (code === 0) {
                    resolve(true);
                  } else {
                    log.error(`CLI delivery exited with code ${code} for ${agentName}`);
                    resolve(false);
                  }
                });
                child.on("error", (err: Error) => {
                  clearTimeout(timer);
                  log.error(`CLI delivery spawn error for ${agentName}: ${err.message}`);
                  resolve(false);
                });
              });
            } catch (err) {
              log.error(`CLI delivery attempt ${attempt + 1} threw for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (delivered) {
            log.info(`Delivery spawned for ${agentName} [${sessionId}]`);
          } else {
            log.error(`All CLI delivery attempts exhausted for ${agentName} [${sessionId}]`);
          }
        }
      } catch (err) {
        log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return router;
}
