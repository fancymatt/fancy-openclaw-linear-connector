/**
 * Engagement-status overlay (AI-1510).
 *
 * In dev-impl, native Linear status is a NON-AUTHORITATIVE *engagement* signal:
 * it answers "is an agent touching this ticket right now," not which pipeline
 * stage it's in. The pipeline stage lives entirely in the `state:*` label; native
 * status cycles To Do → Thinking → Doing based on the delegate's session lifecycle.
 *
 *   - dispatch / agent reads the ticket  → thinking
 *   - agent authors its first activity    → doing   (monotonic: never downgrades)
 *   - session ends with no successor      → todo
 *
 * Each workflow state's `native_state` in dev-impl.yaml is the *resting* value
 * (todo for every active stage); a real transition writes that resting value, and
 * the next delegate's dispatch re-drives thinking → doing.
 *
 * These writes are connector-initiated (delegate's vaulted token), NOT routed
 * through the proxy's agent path — so the workflow gate does not (and should not)
 * gate them. They are free to move native status precisely because the redesign
 * demoted native status to non-authoritative (label + delegate are the truth).
 *
 * Fail-open everywhere: any fetch/resolve error is logged and swallowed. A missed
 * status flip is cosmetic; it must never block dispatch or session-end handling.
 */
export type EngagementSemantic = "thinking" | "doing" | "todo";
/**
 * Apply an engagement status to a workflow ticket. No-op for ad-hoc tickets
 * (no `wf:*` label) and for the monotonic thinking-after-doing case.
 *
 * @param ticketRef          `linear-AI-1292` or `AI-1292`
 * @param token              delegate's access token (raw or Bearer-prefixed)
 * @param agentLinearUserId  Linear user ID of the authoring agent; when provided,
 *                           the "doing" flip is skipped if the agent is not the
 *                           current delegate (AI-1660).
 */
export declare function applyEngagementStatus(ticketRef: string, semantic: EngagementSemantic, token: string | null | undefined, agentLinearUserId?: string | null): Promise<void>;
//# sourceMappingURL=engagement-status.d.ts.map