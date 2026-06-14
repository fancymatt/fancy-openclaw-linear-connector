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
export type { StaleSessionDetail } from "./session-tracker.js";
type StaleSessionInput = {
    agentId: string;
    sessionKey: string;
    startedAt: number;
    timeoutMs: number;
    pendingTickets: string[];
};
export type StaleClass = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C-UNK";
export declare const STALE_CLASS_NAMES: Record<StaleClass, string>;
export interface SessionMetadata {
    agentId: string;
    ticketId: string;
    sessionKey: string;
    sessionFile: string | null;
    sessionStartedAt: number;
    lastActivityAt: number;
    timeoutMs: number;
    totalDurationMs: number;
}
export interface ToolCallEntry {
    name: string;
    arguments: Record<string, unknown>;
    result: "success" | "error" | "no-result";
    timestamp: string;
}
export interface ToolCallSummary {
    byName: Record<string, number>;
    totalCalls: number;
    last10: ToolCallEntry[];
}
export interface LastAssistantMessage {
    fullText: string;
    hasQuestion: boolean;
    hasToolCalls: boolean;
    stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" | "unknown";
    timestamp: string;
}
export interface LinearTicketSnapshot {
    identifier: string;
    stateAtStart: string | null;
    stateAtTimeout: string | null;
    lastCommentAtStart: string | null;
    lastCommentAtTimeout: string | null;
    commentCountAtStart: number | null;
    commentCountAtTimeout: number | null;
}
export interface StaleSnapshot {
    capturedAt: string;
    metadata: SessionMetadata;
    lastAssistantMessage: LastAssistantMessage | null;
    lastToolCall: ToolCallEntry | null;
    toolCallSummary: ToolCallSummary;
    linearTicket: LinearTicketSnapshot;
    classification: StaleClass;
    errors: string[];
    diagnosticPath: string;
}
export interface ForensicsConfig {
    /** Directory for diagnostic snapshots. Default: ~/.openclaw/diagnostics/stale-sessions/ */
    diagnosticsDir?: string;
    /** Path to ~/.openclaw/ (for finding session files). Default: $HOME/.openclaw */
    openclawHome?: string;
    /** Number of tool calls without productive output to classify as C5. Default: 20 */
    loopThreshold?: number;
    /**
     * Linear user ID of the human owner (Matt) to assign for needs-human recovery classes
     * (C1/C3/C5/C6/C-UNK). Falls back to STALE_HUMAN_ASSIGNEE_LINEAR_ID env var.
     */
    humanAssigneeLinearId?: string;
    /** Path to SQLite file for tracking C2/C4 re-dispatch attempt counts. Default: data/stale-redispatch-attempts.db */
    redispatchDbPath?: string;
    /** Max C2/C4 re-dispatch attempts before escalating to human. Default: 3 (STALE_REDISPATCH_MAX_ATTEMPTS env) */
    maxRedispatchAttempts?: number;
}
/**
 * Build a forensic snapshot for a stale session.
 */
export declare function buildSnapshot(stale: StaleSessionInput, config?: ForensicsConfig): StaleSnapshot;
export declare function classify(lastAssistant: LastAssistantMessage | null, toolCalls: ToolCallSummary, errors: string[], loopThreshold?: number): StaleClass;
/**
 * Write a forensic snapshot to the diagnostics directory.
 */
export declare function writeSnapshot(snapshot: StaleSnapshot, config?: ForensicsConfig): string;
/**
 * Append a one-line summary to the JSONL digest file for aggregation.
 */
export declare function appendDigestEntry(snapshot: StaleSnapshot, config?: ForensicsConfig): void;
interface LinearIssueState {
    identifier: string;
    state: {
        name: string;
        type: string;
    } | null;
    comments: {
        nodes: Array<{
            id: string;
            createdAt: string;
        }>;
    };
}
/**
 * Fetch the current state of a Linear issue for forensic comparison.
 */
export declare function fetchLinearTicketState(ticketId: string, agentId: string): Promise<LinearIssueState | null>;
export interface RecoveryResult {
    success: boolean;
    action: string;
    detail?: string;
    /**
     * AI-1578 (AC2): set on a C4 first-stall re-poke. When true, recoverTicket
     * retained the delegate and changed no state — the caller should re-wake the
     * SAME delegate for this ticket rather than treating it as orphaned. Only the
     * second consecutive C4 stall sheds the delegate (existing orphan behavior).
     */
    rePoke?: boolean;
}
export declare function recoverTicket(snapshot: StaleSnapshot, agentId: string, config?: ForensicsConfig): Promise<RecoveryResult>;
/**
 * Build a human-readable recovery comment for the Linear ticket based on classification.
 * For C2/C4, pass attempt (1-based current count) and maxAttempts to include retry info.
 */
export declare function buildRecoveryComment(snapshot: StaleSnapshot, attempt?: number, maxAttempts?: number): string;
export interface DigestEntry {
    capturedAt: string;
    agent: string;
    ticket: string;
    classification: StaleClass;
    classificationName: string;
    totalDurationMs: number;
    toolCallCount: number;
    stopReason: string | null;
    errors: number;
    diagnosticPath: string;
}
export interface DigestSummary {
    period: {
        from: string;
        to: string;
    };
    totalStaleSessions: number;
    byClass: Record<string, number>;
    byAgent: Record<string, number>;
    entries: DigestEntry[];
}
/**
 * Read the digest JSONL and produce an aggregated summary.
 */
export declare function aggregateDigest(config?: ForensicsConfig, daysBack?: number): DigestSummary;
/**
 * Format a digest summary as human-readable text.
 */
export declare function formatDigestSummary(summary: DigestSummary): string;
//# sourceMappingURL=stale-session-forensics.d.ts.map