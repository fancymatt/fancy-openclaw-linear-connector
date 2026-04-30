import crypto from "crypto";
import { Router } from "express";
import { verifyLinearSignatureMulti, parseWebhookSecrets } from "./signature.js";
import { normalizeLinearEvent } from "./normalize.js";
import { routeEvent } from "../router.js";
import { createSessionAndEmitThought } from "../agent-session.js";
import { deliverToAgent } from "../delivery/index.js";
import { normalizeSessionKey } from "../session-key.js";
import { resignalPendingTickets } from "../bag/index.js";
import { createLogger, componentLogger } from "../logger.js";
import { isTerminalIssueEvent, issueIdentifierFromEvent } from "../linear-actionable.js";
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
export function createWebhookRouter(eventStore, nudgeStore, agentQueue, bag, sessionTracker, throttle) {
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
        if (isTerminalIssueEvent(event)) {
            const identifier = issueIdentifierFromEvent(event);
            if (identifier) {
                const sessionKey = normalizeSessionKey(identifier);
                const removedBag = bag?.removeTicketForAllAgents(sessionKey) ?? 0;
                const removedQueued = sessionTracker?.removePendingTicket(sessionKey) ?? 0;
                log.info(`Terminal issue event for ${sessionKey}: pruned ${removedBag} pending bag entr${removedBag === 1 ? "y" : "ies"}` +
                    ` and ${removedQueued} queued signal${removedQueued === 1 ? "" : "s"}; skipping agent dispatch`);
            }
            else {
                log.info("Terminal issue event without identifier; skipping agent dispatch");
            }
            return;
        }
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
        // ── v1.1: Pull-based wake-up via PendingWorkBag ─────────────────────
        // Add to bag (deduped by ticket ID). Send wake-up signal only if
        // agent has no active session. Bursts collapse to 1 signal.
        if (bag && sessionTracker) {
            const normalizedTicketId = normalizeSessionKey(ticketId);
            bag.add(agentName, normalizedTicketId, event.type);
            const wakeConfig = {
                nodeBin: process.execPath,
                hooksUrl: process.env.OPENCLAW_HOOKS_URL,
                hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
                hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
                hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
                timeoutMs: process.env.NODE_ENV === "test" ? 50 : undefined,
                maxRetries: process.env.NODE_ENV === "test" ? 0 : undefined,
            };
            if (sessionTracker.isActive(agentName)) {
                const activeSessionKey = sessionTracker.getActiveSessionKey(agentName);
                if (activeSessionKey === normalizedTicketId) {
                    // Same ticket, same active OpenClaw session: append immediately.
                    // Waiting for /session-end here strands conversational same-ticket updates.
                    log.info(`Bag: active same-ticket session for ${agentName} [${normalizedTicketId}], delivering immediately`);
                    try {
                        if (throttle) {
                            log.info(`Dispatch throttle: waiting for ${agentName} (same-ticket active)`);
                            await throttle.wait(route.agentId);
                            throttle.record(route.agentId);
                        }
                        await deliverToAgent(route, wakeConfig);
                        bag.removeTicket(agentName, normalizedTicketId);
                    }
                    catch (err) {
                        log.error(`Same-ticket active delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
                        sessionTracker.queueSignal(agentName, [normalizedTicketId]);
                    }
                    return;
                }
                // Agent is busy on a different ticket — queue signal for session-end/stale drain.
                sessionTracker.queueSignal(agentName, [normalizedTicketId]);
                log.info(`Bag: added ${normalizedTicketId} for ${agentName}, queuing signal (different active session: ${activeSessionKey ?? "unknown"})`);
                return;
            }
            // No active session — send one wake-up per pending ticket so each Linear
            // issue gets its own canonical per-ticket OpenClaw session key.
            const pending = bag.getPendingTickets(agentName);
            const pendingIds = pending.map((e) => e.ticketId);
            log.info(`Bag: sending wake-up signal(s) to ${agentName} with ${pendingIds.length} ticket(s)`);
            await resignalPendingTickets(agentName, pendingIds, bag, sessionTracker, wakeConfig, { markActive: true });
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
        }
        catch (err) {
            log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
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