/**
 * AI-1428 — DELEGATE_UNAVAILABLE escalation.
 *
 * When the liveness check confirms an agent is unreachable, this module
 * posts an explicit escalation comment on the Linear ticket and reassigns
 * the ticket to the steward (Ai) so a human can intervene.
 *
 * Builds on patterns from escalation-gate.ts but serves a different purpose:
 * escalation-gate enforces proxy-layer command rules; this module handles
 * the outbound "agent unreachable" notification path.
 */
export interface EscalationResult {
    /** Comment was posted successfully. */
    commentPosted: boolean;
    /** Delegate was changed to steward. */
    delegateChanged: boolean;
}
/**
 * Emit a DELEGATE_UNAVAILABLE event: post an escalation comment on the
 * Linear ticket and (optionally) reassign the delegate to the steward.
 *
 * Returns a summary of what succeeded. Failures are logged but do not throw.
 */
export declare function emitDelegateUnavailable(issueIdentifier: string, targetAgentId: string, reason: string, authToken?: string): Promise<EscalationResult>;
//# sourceMappingURL=escalation.d.ts.map