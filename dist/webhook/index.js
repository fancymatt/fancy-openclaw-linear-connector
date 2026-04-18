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
const nudge_store_1 = require("../store/nudge-store");
/** 15-minute suppression window for bulk-delegation noise reduction (AI-348). */
const NUDGE_SUPPRESSION_MS = 15 * 60 * 1000;
const nudgeStore = new nudge_store_1.NudgeStore();
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
    router.post("/linear", async (req, res) => {
        const secret = process.env.LINEAR_WEBHOOK_SECRET;
        // ── 1. Debug: log relevant headers ──────────────────────────────────
        log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);
        log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
        log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);
        // ── 2. Get raw body ────────────────────────────────────────────────────
        const rawBody = req.rawBody;
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
            const signatureValid = (0, signature_1.verifyLinearSignature)(rawBody, signature, secret);
            log.info(`Signature validation result: ${signatureValid ? "valid" : "invalid"}`);
            if (!signatureValid) {
                res.status(401).json({ error: "Invalid signature" });
                return;
            }
        }
        else {
            log.warn("No LINEAR_WEBHOOK_SECRET set — skipping signature validation");
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
            event = (0, normalize_1.normalizeLinearEvent)(payload);
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
            crypto_1.default.createHash("sha256").update(rawBody ?? Buffer.from(JSON.stringify(payload))).digest("hex");
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
                const sessionResult = await (0, agent_session_1.createSessionAndEmitThought)(issueId, agentName, {
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
        let agentSessionId = null;
        if (issueId && event.type === "Issue") {
            try {
                const sessionResult = await (0, agent_session_1.createSessionAndEmitThought)(issueId, agentName, {
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
        // Deliver to OpenClaw agent
        try {
            const { exec } = require("child_process");
            const { promisify } = require("util");
            const execAsync = promisify(exec);
            const nodeBin = "/home/fancymatt/.nvm/versions/node/v22.22.1/bin/node";
            const openclawScript = "/home/fancymatt/.nvm/versions/node/v22.22.1/bin/openclaw";
            // Extract issue identifier from various event shapes
            const data = (route.event.data ?? {});
            const sessionData = data.agentSession;
            const issueData = (data.issue ?? sessionData?.issue ?? data);
            const identifier = String(issueData?.identifier ?? route.sessionKey.replace("linear-", ""));
            const title = String(issueData?.title ?? "");
            // Build routing-reason-specific message.
            // Mentions: full [NEW TASK] push — someone is talking to you directly.
            // Delegate/assignee: lightweight nudge with 15-min suppression (AI-348).
            // Bulk delegations collapse into one nudge; agent pulls queue at own cadence.
            const reason = route.routingReason ?? "assignee";
            let message;
            if (reason === "mention" || reason === "body-mention") {
                // Mentions always fire the short, accurate message without delegation boilerplate.
                message = `[NEW TASK] You were mentioned on ${identifier}: ${title}.\n\nIMPORTANT: Fetch the FULL issue details INCLUDING comment history. The task brief may be in the description OR in the comments.\n\nRun these commands:\n  linear issue ${identifier}\n  linear comments ${identifier}\n\nReview both the description AND comments for your task brief before taking action.`;
            }
            else {
                // Delegate/assignee: lightweight nudge with suppression.
                if (nudgeStore.isSuppressed(agentName, NUDGE_SUPPRESSION_MS)) {
                    log.info(`Nudge suppressed for ${agentName} — within 15-min window. ${identifier} silently queued.`);
                    return;
                }
                nudgeStore.recordNudge(agentName);
                const actionText = reason === "delegate"
                    ? `You were delegated ${identifier}`
                    : `You were assigned ${identifier}`;
                message = `[NEW TASK] ${actionText}. Run \`linear my-next\` to see your highest-priority pending task.`;
            }
            const sessionId = route.sessionKey;
            // Fire-and-forget delivery — use agent command with --deliver flag
            // This sends message to agent's configured channel instead of hardcoded Telegram ID
            const deliveryCmd = `${nodeBin} ${openclawScript} agent --agent ${JSON.stringify(agentName)} --message ${JSON.stringify(message)} --deliver`;
            const child = require("child_process").spawn(nodeBin, [
                openclawScript, "agent",
                "--agent", agentName,
                "--message", message,
                "--deliver",
            ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
            child.unref();
            log.info(`Delivery spawned for ${agentName} [${sessionId}]`);
            // Note: Linear agent session stays open until agent responds via comment.
            // We don't close it here because we're just delivering a message,
            // not starting an agent process that will run and exit.
        }
        catch (err) {
            log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    return router;
}
//# sourceMappingURL=index.js.map