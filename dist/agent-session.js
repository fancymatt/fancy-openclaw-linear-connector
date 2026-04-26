/**
 * Agent session management for Linear's agent workspace UI.
 * Creates agent sessions on issues and emits thought activities
 * so the "Working" widget appears in Linear.
 */
import { getAccessToken } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
const log = componentLogger(createLogger(), "agent-session");
const LINEAR_API = "https://api.linear.app/graphql";
// Dedup: track recently-created sessions per issue
const recentSessions = new Map();
const SESSION_DEDUP_WINDOW_MS = 30000; // 30 seconds
// In-flight lock for session creation
const sessionCreationInFlight = new Map();
/**
 * Create an agent session on an issue and emit a thought activity.
 * Uses in-flight lock and dedup to prevent duplicate sessions.
 */
export async function createSessionAndEmitThought(issueId, agentName, issueContext) {
    const lockKey = `${issueId}:${agentName}`;
    // If another request is already creating a session, wait for it
    const inFlight = sessionCreationInFlight.get(lockKey);
    if (inFlight) {
        const result = await inFlight;
        return { sessionId: result.sessionId, result: "session skipped: waited for in-flight" };
    }
    // Dedup: skip if we already created a session recently
    const now = Date.now();
    const existing = recentSessions.get(issueId);
    if (existing && now - existing.timestamp < SESSION_DEDUP_WINDOW_MS) {
        return { sessionId: existing.sessionId, result: "session skipped: dedup window" };
    }
    const promise = doCreateSessionAndEmitThought(issueId, agentName, issueContext);
    sessionCreationInFlight.set(lockKey, promise);
    try {
        return await promise;
    }
    finally {
        sessionCreationInFlight.delete(lockKey);
    }
}
async function doCreateSessionAndEmitThought(issueId, agentName, issueContext) {
    const token = getAccessToken(agentName);
    if (!token)
        return { sessionId: null, result: `session skipped: no token for ${agentName}` };
    try {
        // Step 1: Create agent session on the issue
        const createRes = await fetch(LINEAR_API, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query: `mutation($input: AgentSessionCreateOnIssue!) {
          agentSessionCreateOnIssue(input: $input) {
            success
            agentSession { id status }
          }
        }`,
                variables: { input: { issueId } },
            }),
        });
        const createResult = (await createRes.json());
        if (!createResult.data?.agentSessionCreateOnIssue?.success) {
            const errMsg = createResult.errors?.[0]?.message ?? "unknown error";
            return { sessionId: null, result: `session create failed: ${errMsg}` };
        }
        const sessionId = createResult.data.agentSessionCreateOnIssue.agentSession?.id;
        if (!sessionId)
            return { sessionId: null, result: "session created but no id returned" };
        recentSessions.set(issueId, { timestamp: Date.now(), sessionId });
        // Step 2: Emit thought activity
        const identifier = issueContext?.identifier ?? "";
        const title = issueContext?.title ?? "";
        const desc = (issueContext?.description ?? "").slice(0, 200);
        const agentLabel = agentName.charAt(0).toUpperCase() + agentName.slice(1);
        let thoughtBody;
        if (identifier && title) {
            thoughtBody = `${agentLabel} picking up **${identifier}**: ${title}`;
            if (desc)
                thoughtBody += `\n\n> ${desc}${(issueContext?.description?.length ?? 0) > 200 ? "..." : ""}`;
        }
        else {
            thoughtBody = `${agentLabel} reviewing the issue...`;
        }
        const thoughtOk = await emitThought(sessionId, agentName, thoughtBody);
        log.info(`Session created for ${agentName} on ${identifier}: ${sessionId} | thought ${thoughtOk ? "ok" : "failed"}`);
        return {
            sessionId,
            result: `session created (${sessionId}) | thought ${thoughtOk ? "emitted" : "failed"}`,
        };
    }
    catch (err) {
        return {
            sessionId: null,
            result: `session error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
/** Emit a thought activity on an existing agent session */
export async function emitThought(sessionId, agentName, body) {
    const token = getAccessToken(agentName);
    if (!token)
        return false;
    try {
        const res = await fetch(LINEAR_API, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query: `mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success }
        }`,
                variables: {
                    input: {
                        agentSessionId: sessionId,
                        content: { type: "thought", body },
                    },
                },
            }),
        });
        const result = (await res.json());
        return result.data?.agentActivityCreate?.success ?? false;
    }
    catch {
        return false;
    }
}
/** Emit a response activity (e.g. task completion) on an existing agent session */
export async function emitResponse(sessionId, agentName, body) {
    const token = getAccessToken(agentName);
    if (!token)
        return false;
    try {
        const res = await fetch(LINEAR_API, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query: `mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success }
        }`,
                variables: {
                    input: {
                        agentSessionId: sessionId,
                        content: { type: "response", body },
                    },
                },
            }),
        });
        const result = (await res.json());
        return result.data?.agentActivityCreate?.success ?? false;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=agent-session.js.map