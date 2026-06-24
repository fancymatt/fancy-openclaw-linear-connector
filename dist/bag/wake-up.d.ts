/**
 * Wake-up signal delivery.
 *
 * Sends a thin "you have N pending tickets" message to an agent when the bag
 * has work for them and they're not in an active session. The agent then uses
 * `linear consider-work <ID>` (single ticket) or `linear queue --next` /
 * `linear queue` (multiple tickets) to fetch and process work in priority order.
 *
 * NOTE: The session key uses the ticket's `linear-<IDENTIFIER>` format (e.g.
 * `linear-ILL-148`) so that the wake-up session shares context with any
 * subsequent webhook events for the same ticket. For multi-ticket wake-ups,
 * the first ticket's identifier is used as the key.
 */
import { type DeliveryConfig } from "../delivery/index.js";
export interface WakeUpConfig extends DeliveryConfig {
    /** Signal message template. {count} and {tickets} are replaced. */
    signalTemplate?: string;
    /**
     * Linear auth token for the agent receiving the wake-up.
     * When provided and ticketIds.length === 1, the wake-up message is replaced
     * with the same rich per-step workflow instruction block that event-driven
     * delegation produces — so agents get full context upfront instead of a thin
     * "run consider-work" prompt that is blocked on workflow tickets.
     */
    linearAuthToken?: string;
}
export declare const SINGLE_TICKET_TEMPLATE = "You have 1 pending ticket: {tickets}. Run `linear consider-work {tickets}` to begin.";
export declare const MULTI_TICKET_TEMPLATE = "You have {count} pending ticket(s) waiting: {tickets}. Run `linear queue --next` to pick up the highest-priority one, or `linear queue` to see all.";
export declare const MENTION_TICKET_TEMPLATE = "You have been @mentioned on ticket: {tickets}. Run `linear observe-issue {tickets}` to review.";
/**
 * Context from the prior delegate's handoff comment, bundled into the wake-up
 * message so the next agent sees it even if the comment hasn't landed in Linear
 * yet (fixes the same-second dispatch race documented in AI-1673).
 */
export interface HandoffContext {
    /** Display name of the agent who handed off the ticket. */
    delegateName: string;
    /** The handoff comment body. */
    comment: string;
    /** Age of the comment in milliseconds at dispatch time (0 = same-second race). */
    ageMs: number;
}
export declare function buildWakeUpMessage(ticketIds: string[], signalTemplate?: string, handoffCtx?: HandoffContext | null): string;
/**
 * Send a wake-up signal to an agent.
 *
 * For single-ticket workflow dispatches where a linearAuthToken is available,
 * the message is upgraded to the same rich per-step instruction block that
 * event-driven delegation produces. For multi-ticket dispatches or ad-hoc tickets,
 * falls back to the thin template.
 */
export declare function sendWakeUpSignal(agentId: string, ticketIds: string[], config: WakeUpConfig): Promise<{
    runId?: string;
} | void>;
//# sourceMappingURL=wake-up.d.ts.map