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
            agents: agents.length,
            agentNames: agents.map((a) => a.name),
        });
    });
    // OAuth callback — handles Linear app authorization flow
    app.get("/callback", oauth_callback_1.handleOAuthCallback);
    // Webhook routes — pass the event store from the dedup module
    const { EventStore } = require("./store/event-store");
    const eventStore = new EventStore();
    app.use("/", (0, webhook_1.createWebhookRouter)(eventStore));
    return app;
}
// Only start listening when this file is the entry point, not when imported by tests
if (require.main === module) {
    const agents = (0, agents_1.getAgents)();
    log.info(`Starting connector with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);
    // Start token refresh for all configured agents
    if (agents.length > 0) {
        (0, token_refresh_1.startTokenRefresh)();
    }
    const app = createApp();
    app.listen(PORT, () => {
        log.info(`fancy-openclaw-linear-connector listening on port ${PORT}`);
    });
}
//# sourceMappingURL=index.js.map