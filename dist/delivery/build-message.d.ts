/**
 * Phase 3 / B3 — Outbound per-step instruction injection (AI-1354).
 *
 * For workflow tickets (wf:* label), replaces the generic delegation decision-tree
 * with a per-step instruction block listing exactly the legal command(s) for the
 * ticket's current state (derived from dev-impl.yaml). Ad-hoc tickets (no wf:*) get
 * the byte-identical generic message — §4.6 mode switch.
 *
 * Fail-open: any label-fetch failure, YAML load error, or missing state falls back
 * to the generic message. An agent always gets actionable instructions.
 *
 * Design: design.md §4.6 (outbound direction), §11 Phase 3.
 */
import type { RouteResult } from "../types.js";
/**
 * Build a routing-reason-specific delivery message for an agent.
 *
 * Workflow tickets: per-step instruction block for the current state (B3).
 * Ad-hoc / mentions: generic message, byte-identical to pre-B3 output.
 *
 * authToken is required for workflow label resolution; without it (or on any
 * error) the function falls back to the generic message.
 *
 * When coalescedCount > 0, appends a coalescing note regardless of path.
 */
export declare function buildDeliveryMessage(route: RouteResult, authToken?: string): Promise<string>;
/**
 * Build a workflow-aware per-step delivery message for a single ticket by identifier.
 * Fetches title and labels from Linear; returns null when the ticket is not a workflow
 * ticket. On transient fetch failure, returns a workflow-context-unavailable fallback
 * (AI-1708) instead of silently returning null.
 *
 * Used by the pending-bag wake-up path so agents get the same rich instruction block
 * that event-driven delegation produces.
 */
export declare function buildWorkflowAwareDeliveryMessage(identifier: string, authToken: string, actionText?: string): Promise<string | null>;
/**
 * Attempt to build a workflow-aware per-step instruction block.
 * Returns null to signal "fall back to generic" on any error or ad-hoc ticket.
 *
 * AI-1708: Label fetch now uses fetchLabelsWithRetry. If all retries are
 * exhausted, a WARN is logged with the failure reason before returning null.
 */
export declare function tryBuildWorkflowMessage(actionText: string, identifier: string, title: string, authToken: string): Promise<string | null>;
//# sourceMappingURL=build-message.d.ts.map