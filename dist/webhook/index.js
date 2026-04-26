import crypto from "crypto";
import { Router } from "express";
import { verifyLinearSignatureMulti, parseWebhookSecrets } from "./signature.js";
import { normalizeLinearEvent } from "./normalize.js";
import { routeEvent } from "../router.js";
import { createSessionAndEmitThought } from "../agent-session.js";
import { deliverToAgent } from "../delivery/index.js";
import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(), "webhook");
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
export function createWebhookRouter(eventStore, nudgeStore, agentQueue) {
    const router = Router();
    if (NUDGE_DEDUP_WINDOW_MS > 0) {
        log.info(`Nudge dedup enabled: ${NUDGE_DEDUP_WINDOW_MS}ms window`);
    }
    router.get("/", (_req, res) => {
        res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
    });
    router.post("/", async (req, res) => {
        const secrets = parseWebhookSecrets();
        // ── 1. Debug: log relevant headers ──────────────────────────────────
        log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);
        log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
        log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);
        // ── 2. Get raw body ────────────────────────────────────────────────────
        const rawBody = req.rawBody;
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
            const signatureValid = verifyLinearSignatureMulti(rawBody, signature, secrets);
            log.info(`Signature validation result: ${signatureValid ? "valid" : "invalid"}`);
            if (!signatureValid) {
                res.status(401).json({ error: "Invalid signature" });
                return;
            }
        }
        else {
            log.warn("No LINEAR_WEBHOOK_SECRETS or LINEAR_WEBHOOK_SECRET set — skipping signature validation");
        }
        // ── 4. Parse JSON payload ─────────────────────────────────────────────
        let payload;
        try {
            const body = rawBody ?? Buffer.from(JSON.stringify(req.body));
            payload = JSON.parse(body.toString("utf8"));
            log.info("JSON parsed successfully");
        }
        catch {
            res.status(400).json({ error: "Malformed JSON payload" });
            return;
        }
        // ── 6. Normalize event ────────────────────────────────────────────────
        let event;
        try {
            event = normalizeLinearEvent(payload);
            log.info(`Event normalized: type=${event.type}`);
        }
        catch (err) {
            res.status(400).json({
                error: "Invalid payload structure",
                detail: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        // ── 7. Deduplication ──────────────────────────────────────────────────
        const deliveryId = req.headers["x-linear-delivery"] ??
            crypto.createHash("sha256").update(rawBody ?? Buffer.from(JSON.stringify(payload))).digest("hex");
        if (eventStore?.isDuplicate(deliveryId)) {
            log.info(`Checking duplicate for delivery: ${deliveryId}`);
            res.status(200).json({ ok: true, duplicate: true });
            return;
        }
        // ── 8. Acknowledge immediately ────────────────────────────────────────
        res.status(200).json({ ok: true });
        // Record event for dedup & restart recovery
        eventStore?.recordEvent(deliveryId, payload);
        // ── 9. Route to agent ─────────────────────────────────────────────────
        log.info(`Normalized event: type=${event.type} hasData=${"data" in event} dataKeys=${event.data ? Object.keys(event.data).join(',') : 'none'}`);
        // AgentSessionEvent — create session for Linear UI widget
        if (event.type === "AgentSessionEvent") {
            // Create a Linear agent session to show "Agent working" widget
            // This is separate from OpenClaw agent routing
            const data = event.data ?? {};
            const sessionData = data.agentSession ?? {};
            const issueData = sessionData.issue ?? {};
            const issueId = issueData.id;
            if (!issueId) {
                log.warn("AgentSessionEvent has no issue data - skipping session creation");
                return;
            }
            // Extract agent name from event data (for session creation)
            const agentName = sessionData.user?.name || "unknown";
            let agentSessionId = null;
            try {
                const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
                    identifier: issueData.identifier,
                    title: issueData.title,
                    description: issueData.description,
                });
                agentSessionId = sessionResult.sessionId;
            }
            catch (err) {
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
        let coalescedCount = 0;
        if (NUDGE_DEDUP_WINDOW_MS > 0 && nudgeStore) {
            const info = nudgeStore.getCoalesceInfo(route.agentId, ticketId, NUDGE_DEDUP_WINDOW_MS);
            if (info.suppressed) {
                log.info(`Nudge dedup: coalescing delivery for ${route.agentId} [${ticketId}] — within ${NUDGE_DEDUP_WINDOW_MS}ms window`);
                nudgeStore.recordCoalesced(route.agentId, ticketId, event.type, "action" in event ? event.action : undefined);
                return;
            }
            // Window expired — drain coalesced count before delivering
            coalescedCount = nudgeStore.drainCoalescedCount(route.agentId, ticketId);
            nudgeStore.recordNudge(route.agentId, ticketId);
            if (coalescedCount > 0) {
                log.info(`Nudge dedup: delivering for ${route.agentId} [${ticketId}] with ${coalescedCount} coalesced event(s)`);
                route.coalescedCount = coalescedCount;
            }
        }
        const agentName = route.agentId;
        log.info(`Routed event to ${agentName} [${route.sessionKey}]`);
        // ── 10. Create agent session + emit thought ───────────────────────────
        const data = event.data;
        const issueId = data?.id;
        let agentSessionId = null;
        if (issueId && event.type === "Issue") {
            try {
                const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
                    identifier: data?.identifier,
                    title: data?.title,
                    description: data?.description,
                });
                agentSessionId = sessionResult.sessionId;
            }
            catch (err) {
                log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // ── 10b. Agent queue with ticket-level coalescing ──────────────────
        // Serialize per-agent: only one active delivery at a time.
        // Same-ticket queued events are coalesced (replaced) not stacked.
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
            // action === "deliver" — proceed to delivery below
            log.info(`Agent queue: delivering immediately for ${route.agentId} [${ticketId}]`);
        }
        // Deliver to OpenClaw agent via delivery module
        const deliveryConfig = {
            nodeBin: process.execPath,
            hooksUrl: process.env.OPENCLAW_HOOKS_URL,
            hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
            hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
            hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
        };
        try {
            await deliverToAgent(route, deliveryConfig);
        }
        catch (err) {
            log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            // Drain the entire queue for this agent: complete the active task,
            // promote+deliver next, repeat until the queue is empty. The drain
            // runs in finally so a delivery throw can't leak the active row.
            if (agentQueue) {
                let next = agentQueue.complete(route.agentId);
                while (next) {
                    log.info(`Agent queue: promoting next task for ${route.agentId} [${next.sessionKey}]`);
                    try {
                        await deliverToAgent(next, deliveryConfig);
                    }
                    catch (err) {
                        log.error(`Agent queue: failed to deliver promoted task for ${route.agentId}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                    next = agentQueue.complete(route.agentId);
                }
            }
        }
    });
    return router;
}
//# sourceMappingURL=index.js.map