/**
 * Event routing: determines which OpenClaw agent should handle a Linear event.
 *
 * Supports both traditional assignee-based routing and OAuth app actor
 * delegation (where the agent appears in the `delegate` field, not `assignee`).
 *
 * Also filters self-triggered events to prevent feedback loops,
 * while allowing agent-to-agent delegation.
 */
import type { LinearEvent } from "./webhook/schema";
import type { RouteResult } from "./types";
/**
 * Extract the target agent name from a webhook payload.
 * Checks delegate first (OAuth app actors), then assignee, then mentioned users.
 * Returns null if no agent target found or if it's a self-triggered event.
 */
export declare function extractAgentTarget(event: LinearEvent): string | null;
/**
 * Route a Linear event to an OpenClaw agent.
 * Returns a RouteResult if routing succeeded, null if no agent found.
 */
export declare function routeEvent(event: LinearEvent): RouteResult | null;
//# sourceMappingURL=router.d.ts.map