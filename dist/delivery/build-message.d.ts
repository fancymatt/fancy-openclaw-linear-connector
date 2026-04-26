import type { RouteResult } from "../types.js";
/**
 * Build a routing-reason-specific delivery message for an agent.
 *
 * Mentions: full [NEW TASK] push with commenter name and response options.
 * Delegate/assignee: full decision-tree nudge.
 *
 * When coalescedCount > 0, appends a note indicating how many events
 * were coalesced into this single delivery.
 */
export declare function buildDeliveryMessage(route: RouteResult): string;
//# sourceMappingURL=build-message.d.ts.map