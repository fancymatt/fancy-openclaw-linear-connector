"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebhookRouter = createWebhookRouter;
const express_1 = require("express");
const signature_1 = require("./signature");
const normalize_1 = require("./normalize");
const nudge_store_1 = require("../store/nudge-store");
const router_1 = require("../router");
const agent_session_1 = require("../agent-session");
const logger_1 = require("../logger");
const log = (0, logger_1.componentLogger)((0, logger_1.createLogger)(), "webhook");
/** 15-minute suppression window for bulk-delegation noise reduction (AI-348). */
const NUDGE_SUPPRESSION_MS = 15 * 60 * 1000;
const nudgeStore = new nudge_store_1.NudgeStore();
function createWebhookRouter(eventStore) {
    const router = (0, express_1.Router)();
    router.post("/linear", async (req, res) => {
        const secret = process.env.LINEAR_WEBHOOK_SECRET;
        // ── 1. Debug: log relevant headers ──────────────────────────────────
        log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);
        log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
        log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);
        // ── 2. Get raw body ────────────────────────────────────────────
        const rawBody = req.rawBody;
        log.info(`Raw body length: ${rawBody?.length || 0} bytes`);
        // ── 3. Verify signature ──────────────────────────────────────────
        const signature = req.headers["x-linear-signature"] || "";
        const isValid = (0, signature_1.verifyLinearSignature)(rawBody, signature, secret);
        log.info(`Signature validation result: ${isValid ? "valid" : "invalid"}`);
        if (!isValid) {
            log.warn("Signature invalid - rejecting webhook");
            res.status(400).send({ error: "Invalid signature" });
            return;
        }
        // ── 4. Parse JSON ──────────────────────────────────────────────
        const event = (0, normalize_1.normalizeLinearEvent)(JSON.parse(rawBody.toString()));
        log.info(`Event normalized: type=${event.type}`);
        // ── 5. Route event ───────────────────────────────────────────
        const route = (0, router_1.routeEvent)(event);
        if (!route) {
            log.info(`No agent target for event type=${event.type} action=${"action" in event ? event.action : "?"}`);
            return;
        }
        const { agentName, sessionKey } = route;
        log.info(`routeEvent: type=${event.type} identifier=${event.data?.identifier ?? 'none'} reason=${route.routingReason ?? "assignee"}`);
        // ── 6. Create Linear agent session ───────────────────────────────
        let agentSessionId = null;
        if (route.event.type === "Issue" && route.event.action === "create") {
            try {
                const data = route.event.data;
                const identifier = data?.identifier;
                const title = data?.title;
                const issueId = data?.id;
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
        // ── 7. Deliver to OpenClaw agent ──────────────────────────────────
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
            // Mentions: fire the short, accurate message without delegation boilerplate.
            if (reason === "mention" || reason === "body-mention") {
                // Mentions always fire the short, accurate message without delegation boilerplate.
                message = `[NEW TASK] You were mentioned on ${identifier}: ${title}.
IMPORTANT: Fetch the FULL issue details INCLUDING comment history. The task brief may be in the description OR in the comments.
Run these commands:
  linear issue ${identifier}
  linear comments ${identifier}

Review both the description AND comments for your task brief before taking action.`;
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