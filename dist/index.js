"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const webhook_1 = require("./webhook");
const token_refresh_1 = require("./token-refresh");
const agents_1 = require("./agents");
const logger_1 = require("./logger");
const oauth_callback_1 = require("./oauth-callback");
const log = (0, logger_1.componentLogger)((0, logger_1.createLogger)(), "server");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME ?? "fancymatt";
function createApp() {
    const app = (0, express_1.default)();
    // Raw body capture for webhook signature validation.
    app.use("/", express_1.default.raw({ type: "application/json", limit: "1mb" }), (req, _res, next) => {
        if (Buffer.isBuffer(req.body)) {
            req.rawBody = req.body;
        }
        next();
    });
    // Health check
    app.get("/health", (_req, res) => {
        const agents = (0, agents_1.getAgents)();
        res.json({
            status: "ok",
            service: "fancy-openclaw-linear-connector",
            deployment: DEPLOYMENT_NAME,
            agents: agents.length,
            agentNames: agents.map((a) => a.name),
        });
    });
    // OAuth callback — handles Linear app authorization flow
    app.get("/callback", oauth_callback_1.handleOAuthCallback);
    // Webhook routes — pass the event store from the dedup module
    const { EventStore } = require("./store/event-store");
    const { NudgeStore } = require("./store/nudge-store");
    const { AgentQueue } = require("./queue");
    const eventStore = new EventStore();
    const nudgeStore = new NudgeStore();
    const agentQueue = new AgentQueue();
    app.use("/", (0, webhook_1.createWebhookRouter)(eventStore, nudgeStore, agentQueue));
    return app;
}
// Only start listening when this file is the entry point, not when imported by tests
if (require.main === module) {
    const agents = (0, agents_1.getAgents)();
    log.info(`Starting connector [${DEPLOYMENT_NAME}] with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);
    // Watch agents.json for external changes — no restart needed to add agents
    (0, agents_1.watchAgentsFile)();
    // Start token refresh for all configured agents
    if (agents.length > 0) {
        (0, token_refresh_1.startTokenRefresh)();
    }
    const app = createApp();
    const server = app.listen(PORT, () => {
        log.info(`fancy-openclaw-linear-connector [${DEPLOYMENT_NAME}] listening on port ${PORT} (pid=${process.pid})`);
    });
    // Graceful shutdown — drain in-flight connections before exit
    function shutdown(signal) {
        log.info(`Received ${signal}, shutting down gracefully...`);
        server.close(() => {
            log.info("Server closed. Exiting.");
            process.exit(0);
        });
        // Force exit after 8s if drain stalls (systemd SendSIGKILL fires at 10s)
        setTimeout(() => {
            log.warn("Graceful shutdown timed out, forcing exit.");
            process.exit(1);
        }, 8000).unref();
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
//# sourceMappingURL=index.js.map