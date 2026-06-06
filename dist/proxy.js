/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement), design.md §4.6, §11, §13.
 *
 * Slice 1 adds the first enforced inbound rule: on workflow tickets (wf:*)
 * the `needs-human` command is steward-only. All other commands remain
 * transparent pass-through.
 */
import { componentLogger, createLogger } from "./logger.js";
import { checkEnforcementRules } from "./escalation-gate.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "proxy");
const LINEAR_API_URL = "https://api.linear.app/graphql";
function parseBody(req) {
    try {
        if (Buffer.isBuffer(req.body)) {
            return JSON.parse(req.body.toString("utf8"));
        }
        if (typeof req.body === "object" && req.body !== null) {
            return req.body;
        }
    }
    catch {
        // fall through
    }
    return null;
}
/**
 * Best-effort extraction of ticket identifier from GraphQL variables.
 * Returns the first non-empty string found in common ID variable names, or null.
 */
function extractIssueId(body) {
    if (!body?.variables)
        return null;
    const vars = body.variables;
    for (const key of ["id", "issueId", "identifier"]) {
        const v = vars[key];
        if (typeof v === "string" && v.length > 0)
            return v;
    }
    return null;
}
/**
 * Build the ticket context string for log lines (empty string when no ID found).
 */
function extractTicketContext(body) {
    const id = extractIssueId(body);
    return id ? ` ticket=${id}` : "";
}
export async function handleProxyRequest(req, res) {
    const authorization = req.headers["authorization"];
    if (!authorization) {
        res.status(401).json({ errors: [{ message: "Missing Authorization header" }] });
        return;
    }
    const agentId = req.headers["x-openclaw-agent"] ?? "unknown";
    const intent = req.headers["x-openclaw-linear-intent"] ?? null;
    const body = parseBody(req);
    const opName = body?.operationName ?? "(unnamed)";
    const issueId = extractIssueId(body);
    const ticketCtx = issueId ? ` ticket=${issueId}` : "";
    log.info(`forward agent=${agentId} op=${opName}${ticketCtx}${intent ? ` intent=${intent}` : ""}`);
    // Phase 2 / slice 1: evaluate enforcement rules before forwarding.
    if (intent) {
        const rejection = await checkEnforcementRules(intent, issueId, authorization, agentId);
        if (rejection) {
            log.warn(`enforcement-block agent=${agentId} intent=${intent}${ticketCtx}: ${rejection}`);
            res.status(200).json({ errors: [{ message: rejection }] });
            return;
        }
    }
    let upstreamRes;
    try {
        upstreamRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: authorization,
            },
            body: JSON.stringify(body),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`upstream request failed: ${msg}`);
        res
            .status(502)
            .json({ errors: [{ message: `Linear API unreachable: ${msg}` }] });
        return;
    }
    const responseText = await upstreamRes.text();
    log.info(`response agent=${agentId} op=${opName} status=${upstreamRes.status}`);
    res
        .status(upstreamRes.status)
        .set("Content-Type", "application/json")
        .send(responseText);
}
//# sourceMappingURL=proxy.js.map