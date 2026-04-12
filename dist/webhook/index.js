"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLinearEvent = exports.verifyLinearSignature = void 0;
exports.createWebhookRouter = createWebhookRouter;
const crypto_1 = __importDefault(require("crypto"));
const express_1 = require("express");
const signature_1 = require("./signature");
const normalize_1 = require("./normalize");
const router_1 = require("../router");
const agent_session_1 = require("../agent-session");
const logger_1 = require("../logger");
const log = (0, logger_1.componentLogger)((0, logger_1.createLogger)(), "webhook");
var signature_2 = require("./signature");
Object.defineProperty(exports, "verifyLinearSignature", { enumerable: true, get: function () { return signature_2.verifyLinearSignature; } });
var normalize_2 = require("./normalize");
Object.defineProperty(exports, "normalizeLinearEvent", { enumerable: true, get: function () { return normalize_2.normalizeLinearEvent; } });
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
function createWebhookRouter(eventStore) {
    const router = (0, express_1.Router)();
    router.post("/linear", (req, res) => {
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
        const rawBody = req.rawBody;
        if (!rawBody) {
            res.status(400).json({ error: "Empty or unreadable request body" });
            return;
        }
        // ── 4. HMAC signature validation ──────────────────────────────────────
        const signatureValid = (0, signature_1.verifyLinearSignature)(rawBody, signature, secret);
        if (!signatureValid) {
            res.status(401).json({ error: "Invalid signature" });
            return;
        }
        // ── 5. Parse JSON payload ─────────────────────────────────────────────
        let payload;
        try {
            payload = JSON.parse(rawBody.toString("utf8"));
        }
        catch {
            res.status(400).json({ error: "Malformed JSON payload" });
            return;
        }
        // ── 6. Normalize event ────────────────────────────────────────────────
        let event;
        try {
            event = (0, normalize_1.normalizeLinearEvent)(payload);
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
            crypto_1.default.createHash("sha256").update(rawBody).digest("hex");
        if (eventStore?.isDuplicate(deliveryId)) {
            res.status(200).json({ ok: true, duplicate: true });
            return;
        }
        // ── 8. Acknowledge immediately ────────────────────────────────────────
        res.status(200).json({ ok: true });
        // Record event for dedup & restart recovery
        eventStore?.recordEvent(deliveryId, payload);
        // ── 9. Route to agent ─────────────────────────────────────────────────
        const route = (0, router_1.routeEvent)(event);
        if (!route) {
            log.info(`No agent target for event type=${event.type} action=${"action" in event ? event.action : "?"}`);
            return;
        }
        const agentName = route.agentId;
        log.info(`Routed event to ${agentName} [${route.sessionKey}]`);
        // ── 10. Create agent session + emit thought ───────────────────────────
        const data = event.data;
        const issueId = data?.id;
        if (issueId && event.type === "Issue") {
            (0, agent_session_1.createSessionAndEmitThought)(issueId, agentName, {
                identifier: data?.identifier,
                title: data?.title,
                description: data?.description,
            }).catch((err) => {
                log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        // TODO: deliver to OpenClaw gateway via HttpOpenClawDeliveryAdapter
        log.info(`Event processing complete for ${agentName}`);
    });
    return router;
}
//# sourceMappingURL=index.js.map