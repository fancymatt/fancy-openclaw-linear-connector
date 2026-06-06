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
//# sourceMappingURL=build-message.d.ts.map