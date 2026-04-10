"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLinearEvent = exports.verifyLinearSignature = void 0;
exports.createWebhookRouter = createWebhookRouter;
const express_1 = require("express");
const signature_1 = require("./signature");
const normalize_1 = require("./normalize");
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
function createWebhookRouter() {
    const router = (0, express_1.Router)();
    /**
     * POST /webhooks/linear
     *
     * Receives and validates Linear webhook events.
     *
     * Responses:
     *   200 OK             — event accepted and queued
     *   400 Bad Request    — missing signature header or malformed payload
     *   401 Unauthorized   — signature validation failed
     *   500 Internal Error — unexpected server error
     */
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
            console.error("[webhook] LINEAR_WEBHOOK_SECRET is not set — rejecting all requests");
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
        // ── 7. Acknowledge immediately ────────────────────────────────────────
        // Linear expects a 200 within a few seconds. We ack first, process async.
        res.status(200).json({ ok: true });
        // Emit for downstream consumers (routing, queue, etc.)
        // In a full implementation this would publish to an event bus.
        // For now we log at info level so the event is observable.
        console.info(`[webhook] received event type=${event.type} action=${"action" in event ? event.action : "?"}`);
    });
    return router;
}
//# sourceMappingURL=index.js.map