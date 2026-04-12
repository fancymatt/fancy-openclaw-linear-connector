"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpOpenClawDeliveryAdapter = void 0;
exports.createAssignmentPayload = createAssignmentPayload;
const logger_1 = require("../logger");
const log = (0, logger_1.componentLogger)((0, logger_1.createLogger)(), "delivery");
class HttpOpenClawDeliveryAdapter {
    constructor(options) {
        this.gatewayUrl = options.gatewayUrl.replace(/\/$/, "");
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async deliver(request) {
        const requestBody = JSON.stringify(request.payload);
        const { agentId, sessionKey } = request.destination;
        log.info(`Attempting delivery to ${agentId} [${sessionKey}]`);
        try {
            const response = await this.fetchImpl(`${this.gatewayUrl}/deliveries/openclaw`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-openclaw-session-key": request.destination.sessionKey,
                    "x-openclaw-agent-id": request.destination.agentId,
                },
                body: requestBody,
            });
            const responseBody = await response.text();
            if (response.ok) {
                log.info(`Delivery succeeded for ${agentId}: ${response.status}`);
            }
            else {
                log.error(`Delivery failed for ${agentId}: ${response.status} ${responseBody}`);
            }
            return {
                ok: response.ok,
                destination: request.destination,
                transport: "http",
                requestBody,
                statusCode: response.status,
                responseBody,
                error: response.ok ? undefined : `Delivery failed with status ${response.status}`,
            };
        }
        catch (error) {
            log.error(`Delivery error for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
            return {
                ok: false,
                destination: request.destination,
                transport: "http",
                requestBody,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
exports.HttpOpenClawDeliveryAdapter = HttpOpenClawDeliveryAdapter;
function createAssignmentPayload(route) {
    const issue = extractIssue(route.event);
    const identifier = issue?.identifier ?? "unknown issue";
    const title = issue?.title ?? "Untitled Linear task";
    return {
        version: 1,
        source: "linear",
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        priority: route.priority,
        eventType: route.event.type,
        action: route.event.action,
        issue,
        summary: `[${identifier}] ${title}`,
        rawEvent: route.event,
    };
}
function extractIssue(event) {
    if (isIssueEvent(event)) {
        return {
            id: event.data.id,
            identifier: event.data.identifier,
            title: event.data.title,
            url: event.data.url,
            teamKey: event.data.teamKey,
            stateName: event.data.state.name,
            assigneeName: event.data.assigneeName,
            priority: event.data.priority,
        };
    }
    return undefined;
}
function isIssueEvent(event) {
    return event.type === "Issue" && (event.action === "create" || event.action === "update");
}
//# sourceMappingURL=adapter.js.map