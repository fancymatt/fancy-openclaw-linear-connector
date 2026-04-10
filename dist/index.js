"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const webhook_1 = require("./webhook");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
function createApp() {
    const app = (0, express_1.default)();
    // Raw body capture for webhook signature validation.
    // Must be registered before any JSON body parser so we get the exact bytes.
    app.use("/webhooks", express_1.default.raw({ type: "application/json", limit: "1mb" }), (req, _res, next) => {
        if (Buffer.isBuffer(req.body)) {
            req.rawBody = req.body;
        }
        next();
    });
    // Health check
    app.get("/health", (_req, res) => {
        res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
    });
    // Webhook routes
    app.use("/webhooks", (0, webhook_1.createWebhookRouter)());
    return app;
}
// Only start listening when this file is the entry point, not when imported by tests
if (require.main === module) {
    const app = createApp();
    app.listen(PORT, () => {
        console.log(`[server] fancy-openclaw-linear-connector listening on port ${PORT}`);
    });
}
//# sourceMappingURL=index.js.map