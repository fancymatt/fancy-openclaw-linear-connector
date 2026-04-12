/**
 * Agent session management for Linear's agent workspace UI.
 * Creates agent sessions on issues and emits thought activities
 * so the "Working" widget appears in Linear.
 */
interface SessionCreateResult {
    sessionId: string | null;
    result: string;
}
/**
 * Create an agent session on an issue and emit a thought activity.
 * Uses in-flight lock and dedup to prevent duplicate sessions.
 */
export declare function createSessionAndEmitThought(issueId: string, agentName: string, issueContext?: {
    identifier?: string;
    title?: string;
    description?: string;
}): Promise<SessionCreateResult>;
/** Emit a thought activity on an existing agent session */
export declare function emitThought(sessionId: string, agentName: string, body: string): Promise<boolean>;
/** Emit a response activity (e.g. task completion) on an existing agent session */
export declare function emitResponse(sessionId: string, agentName: string, body: string): Promise<boolean>;
export {};
//# sourceMappingURL=agent-session.d.ts.map