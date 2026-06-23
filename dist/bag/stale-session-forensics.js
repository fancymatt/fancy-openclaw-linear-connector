/**
 * Stale-session forensics, classification, and recovery.
 *
 * When the session-tracker detects a stale session, this module:
 *   1. Reads the agent's OpenClaw session JSONL from disk
 *   2. Extracts forensic data (messages, tool calls, errors)
 *   3. Classifies the failure into C1–C6 / C-UNK
 *   4. Executes a class-specific recovery action on the Linear ticket
 *   5. Writes a diagnostic snapshot to ~/.openclaw/diagnostics/stale-sessions/
 *
 * The connector and OpenClaw share the same host (Nakazawa), so session files
 * are directly readable from ~/.openclaw/agents/<agentId>/sessions/.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLogger, componentLogger } from "../logger.js";
import { getAccessToken, getOpenclawAgentName } from "../agents.js";
import { StaleRedispatchCounter } from "./stale-redispatch-counter.js";
const log = componentLogger(createLogger(), "stale-forensics");
export const STALE_CLASS_NAMES = {
    C1: "Waiting on user",
    C2: "Tool hang",
    C3: "Silent completion",
    C4: "Never started",
    C5: "Looped / runaway",
    C6: "Errored",
    "C-UNK": "Unknown",
};
const DEFAULT_LOOP_THRESHOLD = 20;
function parseEnvInt(name, defaultVal) {
    const raw = process.env[name];
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}
/**
 * Find the session file for a given (agentId, sessionKey) by reading
 * OpenClaw's sessions.json index.
 */
function findSessionFile(agentId, sessionKey, openclawHome) {
    const openclawAgentName = getOpenclawAgentName(agentId);
    const sessionsDir = path.join(openclawHome, "agents", openclawAgentName, "sessions");
    const indexPath = path.join(sessionsDir, "sessions.json");
    try {
        if (!fs.existsSync(indexPath)) {
            log.debug(`Sessions index not found: ${indexPath}`);
            return null;
        }
        const raw = fs.readFileSync(indexPath, "utf8");
        const index = JSON.parse(raw);
        // Try exact match: agent:<agentId>:<sessionKey>
        const openclawKey = `agent:${openclawAgentName}:${sessionKey}`;
        const entry = index[openclawKey];
        if (entry && typeof entry === "object") {
            return {
                sessionId: String(entry.sessionId ?? ""),
                sessionFile: String(entry.sessionFile ?? path.join(sessionsDir, `${entry.sessionId}.jsonl`)),
                sessionStartedAt: typeof entry.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
                status: typeof entry.status === "string" ? entry.status : undefined,
            };
        }
        // Fallback: try with hook prefix
        const hookKey = `agent:${openclawAgentName}:hook:${sessionKey}`;
        const hookEntry = index[hookKey];
        if (hookEntry && typeof hookEntry === "object") {
            return {
                sessionId: String(hookEntry.sessionId ?? ""),
                sessionFile: String(hookEntry.sessionFile ?? path.join(sessionsDir, `${hookEntry.sessionId}.jsonl`)),
                sessionStartedAt: typeof hookEntry.sessionStartedAt === "number" ? hookEntry.sessionStartedAt : undefined,
                status: typeof hookEntry.status === "string" ? hookEntry.status : undefined,
            };
        }
        // Fallback: scan keys for a match containing the sessionKey
        for (const [key, val] of Object.entries(index)) {
            if (key.includes(sessionKey.toLowerCase()) && typeof val === "object" && val.sessionId) {
                return {
                    sessionId: String(val.sessionId),
                    sessionFile: String(val.sessionFile ?? path.join(sessionsDir, `${val.sessionId}.jsonl`)),
                    sessionStartedAt: typeof val.sessionStartedAt === "number" ? val.sessionStartedAt : undefined,
                    status: typeof val.status === "string" ? val.status : undefined,
                };
            }
        }
        log.debug(`No session found in index for ${openclawKey}`);
        return null;
    }
    catch (err) {
        log.warn(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/**
 * Read and parse a session JSONL file, returning all events.
 */
function readSessionJsonl(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return [];
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        return lines.map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        }).filter((e) => e !== null);
    }
    catch (err) {
        log.warn(`Failed to read session JSONL: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
// ── Snapshot builder ────────────────────────────────────────────────────────
/**
 * Build a forensic snapshot for a stale session.
 */
export function buildSnapshot(stale, config = {}) {
    const now = Date.now();
    const openclawHome = config.openclawHome ?? path.join(os.homedir(), ".openclaw");
    const loopThreshold = config.loopThreshold ?? DEFAULT_LOOP_THRESHOLD;
    // Find session file
    const sessionInfo = findSessionFile(stale.agentId, stale.sessionKey, openclawHome);
    const sessionFile = sessionInfo?.sessionFile ?? null;
    const events = sessionFile ? readSessionJsonl(sessionFile) : [];
    // Parse events for forensics
    const lastAssistant = extractLastAssistantMessage(events);
    const toolCalls = extractToolCallSummary(events);
    const lastToolCall = toolCalls.last10.length > 0 ? toolCalls.last10[0] : null;
    const errors = extractErrors(events);
    // Build metadata
    const metadata = {
        agentId: stale.agentId,
        ticketId: stale.sessionKey,
        sessionKey: `agent:${getOpenclawAgentName(stale.agentId)}:${stale.sessionKey}`,
        sessionFile,
        sessionStartedAt: stale.startedAt,
        lastActivityAt: now,
        timeoutMs: stale.timeoutMs,
        totalDurationMs: now - stale.startedAt,
    };
    // Linear ticket snapshot (will be populated by fetchLinearTicketState)
    const ticketIdentifier = stale.sessionKey.replace(/^linear-/, "");
    const linearTicket = {
        identifier: ticketIdentifier,
        stateAtStart: null,
        stateAtTimeout: null,
        lastCommentAtStart: null,
        lastCommentAtTimeout: null,
        commentCountAtStart: null,
        commentCountAtTimeout: null,
    };
    // Classify
    const classification = classify(lastAssistant, toolCalls, errors, loopThreshold);
    const diagnosticPath = "";
    const snapshot = {
        capturedAt: new Date(now).toISOString(),
        metadata,
        lastAssistantMessage: lastAssistant,
        lastToolCall: lastToolCall,
        toolCallSummary: toolCalls,
        linearTicket,
        classification,
        errors,
        diagnosticPath,
    };
    return snapshot;
}
// ── Extraction helpers ──────────────────────────────────────────────────────
function extractLastAssistantMessage(events) {
    // Walk backwards to find last assistant message
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.type === "message" && event.message?.role === "assistant") {
            const content = event.message.content ?? [];
            const textParts = content.filter((c) => c.type === "text" && c.text);
            const toolCallParts = content.filter((c) => c.type === "toolCall");
            const fullText = textParts.map((c) => c.text ?? "").join("\n");
            const stopReason = normalizeStopReason(event.message.stopReason);
            return {
                fullText,
                hasQuestion: detectQuestion(fullText),
                hasToolCalls: toolCallParts.length > 0,
                stopReason,
                timestamp: event.timestamp ?? new Date().toISOString(),
            };
        }
    }
    return null;
}
function normalizeStopReason(raw) {
    if (!raw)
        return "unknown";
    const lower = raw.toLowerCase();
    if (lower === "stop" || lower === "end_turn")
        return "end_turn";
    if (lower === "tool_use" || lower === "tooluse" || lower === "tool_call")
        return "tool_use";
    if (lower.includes("max_token") || lower.includes("length"))
        return "max_tokens";
    if (lower === "error" || lower.includes("error"))
        return "error";
    return "unknown";
}
function detectQuestion(text) {
    const trimmed = text.trim();
    // Ends with a question mark
    if (/\?$/.test(trimmed))
        return true;
    // Common question patterns
    const questionPatterns = /^(what|who|when|where|why|how|which|can you|could you|should i|would you|do you|is there|are there|did you|have you)\b/i;
    return questionPatterns.test(trimmed);
}
function extractToolCallSummary(events) {
    const byName = {};
    const allCalls = [];
    for (const event of events) {
        if (event.type !== "message" || event.message?.role !== "assistant")
            continue;
        const content = event.message.content ?? [];
        for (const part of content) {
            if (part.type === "toolCall" && part.name) {
                byName[part.name] = (byName[part.name] || 0) + 1;
                allCalls.push({
                    name: part.name,
                    arguments: part.arguments ?? {},
                    result: "no-result", // Will be resolved below
                    timestamp: event.timestamp ?? "",
                });
            }
        }
    }
    // Resolve tool results — find matching toolResult messages
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.type !== "message" || event.message?.role !== "toolResult")
            continue;
        const toolCallId = event.message.content?.[0]?.name; // toolResult uses toolCallId
        if (!toolCallId)
            continue;
        const isError = event.message.content?.some((c) => c.type === "text" && (c.text?.includes("Error") ?? false));
        // Match by finding the toolCall entry with this ID embedded in the name
        for (const call of allCalls) {
            if (call.result !== "no-result")
                continue;
            if (call.name && toolCallId.includes(call.name)) {
                call.result = isError ? "error" : "success";
                break;
            }
        }
    }
    // Sort by timestamp descending, take last 10
    allCalls.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return {
        byName,
        totalCalls: allCalls.length,
        last10: allCalls.slice(0, 10),
    };
}
function extractErrors(events) {
    const errors = [];
    for (const event of events) {
        if (event.type !== "message")
            continue;
        // Check for error tool results
        if (event.message?.role === "toolResult") {
            const content = event.message.content ?? [];
            for (const part of content) {
                if (part.type === "text" && part.text && part.text.length > 0) {
                    // Look for error indicators
                    if (part.text.includes("Error:") || part.text.includes("error:") || part.text.startsWith("Error")) {
                        errors.push(part.text.slice(0, 500));
                    }
                }
            }
        }
        // Check for model errors (stopReason = "error")
        if (event.message?.role === "assistant" && event.message.stopReason === "error") {
            errors.push(`Model error: stopReason=error at ${event.timestamp}`);
        }
    }
    return errors;
}
// ── Classification ──────────────────────────────────────────────────────────
export function classify(lastAssistant, toolCalls, errors, loopThreshold = DEFAULT_LOOP_THRESHOLD) {
    // C4: Never started
    if (toolCalls.totalCalls === 0 && (!lastAssistant || lastAssistant.fullText.trim().length === 0)) {
        return "C4";
    }
    // C6: Errored
    if (errors.length > 0 && lastAssistant?.stopReason === "error") {
        return "C6";
    }
    // C5: Looped / runaway
    if (toolCalls.totalCalls > loopThreshold) {
        // Check if there's productive output (text from assistant that isn't just tool calls)
        const hasProductiveText = lastAssistant && lastAssistant.fullText.trim().length > 50;
        if (!hasProductiveText) {
            return "C5";
        }
    }
    // C2: Tool hang — last tool call has no result
    if (lastAssistant?.hasToolCalls && lastAssistant?.stopReason === "tool_use") {
        // The model was waiting for a tool result that never came
        const lastTool = toolCalls.last10[0];
        if (lastTool && lastTool.result === "no-result") {
            return "C2";
        }
    }
    // C1: Waiting on user — agent asked a question but didn't use needs-human
    if (lastAssistant?.hasQuestion && lastAssistant?.stopReason === "end_turn") {
        return "C1";
    }
    // C3: Silent completion — agent produced substantive text but didn't transition
    if (lastAssistant && !lastAssistant.hasToolCalls && lastAssistant.stopReason === "end_turn") {
        const textLen = lastAssistant.fullText.trim().length;
        if (textLen > 100) {
            return "C3";
        }
    }
    // Fallback for sessions with tool calls that ended cleanly but without clear classification
    if (toolCalls.totalCalls > 0 && lastAssistant?.stopReason === "end_turn") {
        // Agent did work and ended, but didn't hand off. C3 is the closest match.
        return "C3";
    }
    return "C-UNK";
}
// ── Snapshot persistence ────────────────────────────────────────────────────
/**
 * Write a forensic snapshot to the diagnostics directory.
 */
export function writeSnapshot(snapshot, config = {}) {
    const diagDir = config.diagnosticsDir ?? path.join(os.homedir(), ".openclaw", "diagnostics", "stale-sessions");
    fs.mkdirSync(diagDir, { recursive: true });
    const ts = new Date(snapshot.capturedAt).toISOString().replace(/[:.]/g, "-");
    const filename = `${ts}-${snapshot.metadata.agentId}-${snapshot.metadata.ticketId}.json`;
    const filePath = path.join(diagDir, filename);
    // Redact sensitive data before writing
    const sanitized = redactSnapshot(snapshot);
    fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2) + "\n", "utf8");
    log.info(`Forensic snapshot written: ${filePath}`);
    return filePath;
}
/**
 * Append a one-line summary to the JSONL digest file for aggregation.
 */
export function appendDigestEntry(snapshot, config = {}) {
    const diagDir = config.diagnosticsDir ?? path.join(os.homedir(), ".openclaw", "diagnostics", "stale-sessions");
    fs.mkdirSync(diagDir, { recursive: true });
    const digestPath = path.join(diagDir, "digest.jsonl");
    const entry = {
        capturedAt: snapshot.capturedAt,
        agent: snapshot.metadata.agentId,
        ticket: snapshot.metadata.ticketId,
        classification: snapshot.classification,
        classificationName: STALE_CLASS_NAMES[snapshot.classification],
        totalDurationMs: snapshot.metadata.totalDurationMs,
        toolCallCount: snapshot.toolCallSummary.totalCalls,
        stopReason: snapshot.lastAssistantMessage?.stopReason ?? null,
        errors: snapshot.errors.length,
        diagnosticPath: snapshot.diagnosticPath,
    };
    fs.appendFileSync(digestPath, JSON.stringify(entry) + "\n", "utf8");
}
function redactSnapshot(snapshot) {
    // Deep clone and redact sensitive fields
    const cloned = JSON.parse(JSON.stringify(snapshot));
    // Redact tool call arguments that might contain secrets
    if (cloned.toolCallSummary?.last10) {
        for (const call of cloned.toolCallSummary.last10) {
            if (call.arguments) {
                call.arguments = redactObj(call.arguments);
            }
        }
    }
    // Redact full text that might contain tokens
    if (cloned.lastAssistantMessage?.fullText) {
        cloned.lastAssistantMessage.fullText = redactText(cloned.lastAssistantMessage.fullText);
    }
    return cloned;
}
function redactText(text) {
    return text
        .replace(/sk_[a-zA-Z0-9_-]+/g, "[REDACTED]")
        .replace(/lin_[a-zA-Z0-9_-]+/g, "[REDACTED]")
        .replace(/Bearer\s+[^\s"]+/g, "Bearer [REDACTED]")
        .replace(/token["']?\s*[:=]\s*["'][^"']+["']/gi, "token: [REDACTED]")
        .replace(/secret["']?\s*[:=]\s*["'][^"']+["']/gi, "secret: [REDACTED]");
}
function redactObj(obj) {
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        if (/(token|secret|password|authorization|api[_-]?key|access[_-]?token)/i.test(key)) {
            out[key] = "[REDACTED]";
        }
        else if (typeof val === "string") {
            out[key] = redactText(val);
        }
        else {
            out[key] = val;
        }
    }
    return out;
}
/**
 * Fetch the current state of a Linear issue for forensic comparison.
 */
export async function fetchLinearTicketState(ticketId, agentId) {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    if (!token) {
        log.warn(`No Linear token available for ${agentId} — cannot fetch ticket state`);
        return null;
    }
    const identifier = ticketId.replace(/^linear-/, "");
    const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    try {
        const res = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: authHeader,
            },
            body: JSON.stringify({
                query: `query TicketForensics($id: String!) {
          issue(id: $id) {
            id
            identifier
            state { name type }
            comments(first: 1, orderBy: createdAt) { nodes { id createdAt } }
          }
        }`,
                variables: { id: identifier },
            }),
        });
        if (!res.ok) {
            log.warn(`Linear API returned ${res.status} for ${identifier}`);
            return null;
        }
        const body = (await res.json());
        if (body.errors?.length) {
            log.warn(`Linear API error for ${identifier}: ${body.errors.map((e) => e.message).join("; ")}`);
            return null;
        }
        return body.data?.issue ?? null;
    }
    catch (err) {
        log.warn(`Linear fetch failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/**
 * Fetch workflow states for a team and cache them.
 * This avoids hardcoding state IDs which differ per team.
 */
async function fetchWorkflowStates(teamId, agentId) {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    if (!token)
        return [];
    const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    try {
        const res = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({
                query: `query TeamStates($teamId: String!) { team(id: $teamId) { workflow { states { id name type } } } }`,
                variables: { teamId },
            }),
        });
        const body = (await res.json());
        return body.data?.team?.workflow?.states ?? [];
    }
    catch {
        return [];
    }
}
/**
 * Execute a class-specific recovery action on the Linear ticket.
 * Posts a comment and transitions the ticket state.
 */
/**
 * Classes that require human review — assignee=Matt, delegate cleared.
 * C2 and C4 are tool hangs / never-started: return to Todo for re-dispatch.
 */
const NEEDS_HUMAN_CLASSES = new Set(["C1", "C3", "C5", "C6", "C-UNK"]);
export async function recoverTicket(snapshot, agentId, config = {}) {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    if (!token) {
        return { success: false, action: "none", detail: "No Linear token available" };
    }
    const identifier = snapshot.metadata.ticketId.replace(/^linear-/, "");
    const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    // For C2/C4: track re-dispatch attempts and cap if necessary
    let redispatchAttempt;
    let redispatchMax;
    let isRedispatchCapped = false;
    if (snapshot.classification === "C2" || snapshot.classification === "C4") {
        redispatchMax = config.maxRedispatchAttempts ?? parseEnvInt("STALE_REDISPATCH_MAX_ATTEMPTS", 3);
        const counter = new StaleRedispatchCounter(config.redispatchDbPath);
        redispatchAttempt = counter.incrementAndGet(snapshot.metadata.ticketId);
        counter.close();
        isRedispatchCapped = redispatchAttempt >= redispatchMax;
    }
    // Build comment based on classification
    const comment = buildRecoveryComment(snapshot, redispatchAttempt, redispatchMax);
    // Determine target state name based on classification
    const targetStateName = getRecoveryTargetStateName(snapshot.classification);
    try {
        // Fetch the issue to get its ID, team, and current state. We need the live
        // state to guard against clobbering a ticket that already reached a terminal
        // state between stale-detection and recovery-execution (see terminal guard below).
        const issueRes = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({
                query: `query IssueWithTeam($id: String!) { issue(id: $id) { id team { id } state { name type } } }`,
                variables: { id: identifier },
            }),
        });
        const issueBody = (await issueRes.json());
        const issueId = issueBody.data?.issue?.id;
        const teamId = issueBody.data?.issue?.team?.id;
        if (!issueId) {
            return { success: false, action: "none", detail: `Issue ${identifier} not found` };
        }
        // Terminal guard: a stale session can be reaped after its ticket already
        // advanced to a terminal state (e.g. the agent finished, the work merged, and
        // Done was set in the window between stale-detection and this recovery). Running
        // recovery here would clobber a completed ticket — post a contradictory comment,
        // clear the delegate, and try to drag it back to "To Do". Skip entirely if the
        // ticket is already terminal. (Linear state.type: completed | canceled.)
        const liveStateType = issueBody.data?.issue?.state?.type;
        const liveStateName = issueBody.data?.issue?.state?.name ?? "(unknown)";
        if (liveStateType === "completed" || liveStateType === "canceled") {
            log.info(`Recovery for ${identifier}: ticket already terminal (state="${liveStateName}", type=${liveStateType}) — skipping recovery to avoid clobbering completed work`);
            return {
                success: true,
                action: "skipped-terminal",
                detail: `Ticket already in terminal state "${liveStateName}" — no recovery needed`,
            };
        }
        // AI-1578 (AC2): C4 re-poke before orphan. C4 = session spawned but produced
        // zero output. A single transient stall (container restart, idle-close, the
        // completion-announce give-up) should NOT immediately shed the delegate and
        // orphan code-adjacent work. On the FIRST C4 stall, retain the delegate and
        // re-poke it to resume; only the second consecutive stall falls through to the
        // normal shed/orphan path below.
        if (snapshot.classification === "C4" && redispatchAttempt === 1 && !isRedispatchCapped) {
            const diagSuffix = snapshot.diagnosticPath ? `\n\n📝 Diagnostics: \`${snapshot.diagnosticPath}\`` : "";
            const rePokeComment = `🟡 **Stale session — re-poking delegate** (class **C4**, ${STALE_CLASS_NAMES.C4})\n\n` +
                `Your session for ${identifier} ended without producing output. This is your first stall, ` +
                `so the ticket stays with you (delegate retained, state unchanged) instead of being orphaned.\n\n` +
                `Resume now and run the pending transition verb. If you genuinely cannot proceed, run ` +
                `\`linear escape ${identifier}\`.${diagSuffix}`;
            await fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: authHeader },
                body: JSON.stringify({
                    query: `mutation($issueId: ID!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`,
                    variables: { issueId, body: rePokeComment },
                }),
            });
            log.info(`Recovery for ${identifier}: class=C4 first stall → re-poke (delegate retained, state unchanged)`);
            return {
                success: true,
                action: "re-poke-c4",
                rePoke: true,
                detail: "C4 first stall — delegate retained, re-poke requested",
            };
        }
        // Post comment
        await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({
                query: `mutation($issueId: ID!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`,
                variables: { issueId, body: comment },
            }),
        });
        // Apply needs-human semantics: set assignee + clear delegate.
        // C1/C3/C5/C6/C-UNK → assign to human owner and clear delegate (human must review).
        // C2/C4 → clear both (connector will re-dispatch normally), unless cap is breached.
        const needsHuman = NEEDS_HUMAN_CLASSES.has(snapshot.classification) || isRedispatchCapped;
        const humanId = config.humanAssigneeLinearId ?? process.env.STALE_HUMAN_ASSIGNEE_LINEAR_ID ?? null;
        if (needsHuman && !humanId) {
            log.warn(`Recovery for ${identifier}: class=${snapshot.classification} requires human assignment ` +
                `but STALE_HUMAN_ASSIGNEE_LINEAR_ID is not set — delegate cleared, assignee not set`);
        }
        // Build combined update input: ownership (always) + optional state transition.
        // Using a single issueUpdate mutation instead of two sequential calls avoids the
        // race where the state-change webhook arrives at the connector before the delegate-clear
        // has propagated, causing the stale-route guard to see the old delegate and re-wake
        // the same agent that just timed out.
        const updateInput = {
            delegateId: null,
            assigneeId: needsHuman ? (humanId ?? null) : null,
        };
        let stateTransitioned = false;
        if (targetStateName && teamId) {
            const states = await fetchWorkflowStates(teamId, agentId);
            // Resolve by exact name first; teams differ on the precise label ("To Do"
            // vs "Todo" vs "Backlog"), so fall back to the canonical re-dispatch target
            // by state TYPE (unstarted, then backlog) when the name doesn't match. This
            // keeps recovery working across teams instead of silently no-op'ing when the
            // hardcoded name is wrong (the "Todo" vs "To Do" bug).
            const targetState = states.find((s) => s.name === targetStateName) ??
                states.find((s) => s.name.toLowerCase() === targetStateName.toLowerCase()) ??
                states.find((s) => s.type === "unstarted") ??
                states.find((s) => s.type === "backlog");
            if (targetState) {
                updateInput.stateId = targetState.id;
                if (targetState.name !== targetStateName) {
                    log.info(`Recovery for ${identifier}: target "${targetStateName}" resolved to "${targetState.name}" (type=${targetState.type})`);
                }
            }
            else {
                log.warn(`Target state "${targetStateName}" not found in team ${teamId} workflow (no name or unstarted/backlog type match)`);
            }
        }
        const updateRes = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({
                query: `mutation RecoverIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { issue { id state { name } } success }
        }`,
                variables: { id: identifier, input: updateInput },
            }),
        });
        const updateBody = (await updateRes.json());
        stateTransitioned = updateBody.data?.issueUpdate?.success ?? false;
        const className = STALE_CLASS_NAMES[snapshot.classification];
        const ownershipTag = needsHuman ? (humanId ? "+needs-human(assignee+delegate-cleared)" : "+delegate-cleared") : "+delegate-cleared";
        log.info(`Recovery for ${identifier}: class=${snapshot.classification} (${className}), ` +
            `comment posted, state ${stateTransitioned ? "transitioned to " + targetStateName : "unchanged"}, ${ownershipTag}`);
        return {
            success: true,
            action: `classify=${snapshot.classification} comment+${stateTransitioned ? "state(" + targetStateName + ")" : "comment-only"}${ownershipTag}`,
            detail: `${className} — ${comment.slice(0, 200)}`,
        };
    }
    catch (err) {
        return {
            success: false,
            action: "error",
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}
/**
 * Build a human-readable recovery comment for the Linear ticket based on classification.
 * For C2/C4, pass attempt (1-based current count) and maxAttempts to include retry info.
 */
export function buildRecoveryComment(snapshot, attempt, maxAttempts) {
    const cls = snapshot.classification;
    const className = STALE_CLASS_NAMES[cls];
    const duration = Math.round(snapshot.metadata.totalDurationMs / 60000);
    const diagPath = snapshot.diagnosticPath;
    switch (cls) {
        case "C1":
            return `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. The agent appears to have been waiting for user input but did not transition the ticket to a human.\n\n` +
                `Last assistant message ended with a question:\n> ${(snapshot.lastAssistantMessage?.fullText ?? "").slice(0, 300)}\n\n` +
                `Ticket returned for human review.${diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : ""}`;
        case "C2": {
            const isCapped = attempt !== undefined && maxAttempts !== undefined && attempt >= maxAttempts;
            const base = `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. The agent was waiting for a tool response that never arrived.\n\n` +
                `Last tool call: \`${snapshot.lastToolCall?.name ?? "unknown"}\`` +
                (snapshot.lastToolCall?.arguments ? `\nArguments: ${JSON.stringify(snapshot.lastToolCall.arguments).slice(0, 200)}` : "") +
                `\n\n`;
            if (isCapped) {
                return base +
                    `Max re-dispatch attempts reached (**${attempt}/${maxAttempts}**). Escalating to human review.` +
                    (diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : "");
            }
            const attemptSuffix = attempt !== undefined && maxAttempts !== undefined
                ? `\n\nRe-dispatch attempt **${attempt} of ${maxAttempts}**.`
                : "";
            return base +
                `Ticket returned to Todo for re-dispatch.` +
                (diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : "") +
                attemptSuffix;
        }
        case "C3":
            return `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. The agent appears to have completed work but did not transition the ticket state.\n\n` +
                `Last assistant message:\n> ${(snapshot.lastAssistantMessage?.fullText ?? "").slice(0, 500)}\n\n` +
                `Please review and confirm completion or re-route.${diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : ""}`;
        case "C4": {
            const isCapped = attempt !== undefined && maxAttempts !== undefined && attempt >= maxAttempts;
            const base = `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. The agent session was spawned but produced no output.\n\n`;
            if (isCapped) {
                return base +
                    `Max re-dispatch attempts reached (**${attempt}/${maxAttempts}**). Escalating to human review.` +
                    (diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : "");
            }
            const attemptSuffix = attempt !== undefined && maxAttempts !== undefined
                ? `\n\nRe-dispatch attempt **${attempt} of ${maxAttempts}**.`
                : "";
            return base +
                `Ticket returned to Todo for re-dispatch.` +
                (diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : "") +
                attemptSuffix;
        }
        case "C5":
            return `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. The agent made ${snapshot.toolCallSummary.totalCalls} tool calls without productive output.\n\n` +
                `Tool call breakdown: ${JSON.stringify(snapshot.toolCallSummary.byName)}\n\n` +
                `Manual intervention required.${diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : ""}`;
        case "C6":
            return `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. The agent encountered errors:\n\n` +
                snapshot.errors.slice(0, 5).map((e) => `- ${e}`).join("\n") +
                `\n\nManual intervention required.${diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : ""}`;
        case "C-UNK":
        default:
            return `🔴 **Stale session recovered** — class **${cls}** (${className})\n\n` +
                `Session timed out after ${duration} minutes. Could not classify the failure mode.\n\n` +
                `Tool calls: ${snapshot.toolCallSummary.totalCalls}\n` +
                `Stop reason: ${snapshot.lastAssistantMessage?.stopReason ?? "unknown"}\n` +
                `Errors: ${snapshot.errors.length}\n\n` +
                `Manual intervention required.${diagPath ? `\n\n📝 Diagnostics: \`${diagPath}\`` : ""}`;
    }
}
/**
 * Map classification to a target Linear workflow state name.
 * These are human-readable state names that get resolved to IDs at runtime.
 */
function getRecoveryTargetStateName(cls) {
    // For now, all classifications move tickets back to "Todo" for re-evaluation.
    // Team leads can customize this mapping per team via env vars or config.
    const envOverride = process.env[`STALE_RECOVERY_STATE_${cls}`];
    if (envOverride)
        return envOverride;
    switch (cls) {
        case "C1": // Waiting on user → needs human review
        case "C2": // Tool hang → re-dispatch
        case "C3": // Silent completion → confirm
        case "C4": // Never started → re-dispatch
        case "C5": // Looped → manual intervention
        case "C6": // Errored → manual intervention
        case "C-UNK": // Unknown → manual intervention
        default:
            // "To Do" is the canonical unstarted-state name in our teams; recoverTicket
            // also falls back to resolving by state type if a team labels it differently.
            return process.env.STALE_RECOVERY_STATE_DEFAULT ?? "To Do";
    }
}
/**
 * Read the digest JSONL and produce an aggregated summary.
 */
export function aggregateDigest(config = {}, daysBack = 7) {
    const diagDir = config.diagnosticsDir ?? path.join(os.homedir(), ".openclaw", "diagnostics", "stale-sessions");
    const digestPath = path.join(diagDir, "digest.jsonl");
    if (!fs.existsSync(digestPath)) {
        return {
            period: { from: new Date().toISOString(), to: new Date().toISOString() },
            totalStaleSessions: 0,
            byClass: {},
            byAgent: {},
            entries: [],
        };
    }
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const lines = fs.readFileSync(digestPath, "utf8").split("\n").filter((l) => l.trim());
    const entries = [];
    const byClass = {};
    const byAgent = {};
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (new Date(entry.capturedAt) >= cutoff) {
                entries.push(entry);
                byClass[entry.classification] = (byClass[entry.classification] || 0) + 1;
                byAgent[entry.agent] = (byAgent[entry.agent] || 0) + 1;
            }
        }
        catch {
            // Skip malformed lines
        }
    }
    return {
        period: {
            from: cutoff.toISOString(),
            to: new Date().toISOString(),
        },
        totalStaleSessions: entries.length,
        byClass,
        byAgent,
        entries,
    };
}
/**
 * Format a digest summary as human-readable text.
 */
export function formatDigestSummary(summary) {
    const lines = [
        `# Stale Session Digest`,
        `Period: ${summary.period.from.slice(0, 10)} → ${summary.period.to.slice(0, 10)}`,
        `Total stale sessions: ${summary.totalStaleSessions}`,
        "",
        "## By Classification",
    ];
    for (const [cls, count] of Object.entries(summary.byClass).sort((a, b) => b[1] - a[1])) {
        const name = STALE_CLASS_NAMES[cls] ?? cls;
        const pct = summary.totalStaleSessions > 0
            ? Math.round((count / summary.totalStaleSessions) * 100)
            : 0;
        lines.push(`- **${cls}** (${name}): ${count} (${pct}%)`);
    }
    lines.push("", "## By Agent");
    for (const [agent, count] of Object.entries(summary.byAgent).sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${agent}: ${count}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=stale-session-forensics.js.map