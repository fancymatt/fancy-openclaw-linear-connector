/**
 * AI-1565: Pre-routing workflow bootstrap hook.
 *
 * When a wf:* label is added to a ticket with no state:* label, applies the
 * entry state from the workflow def and sets the first-owner delegate — no
 * human/agent action required.
 *
 * Reverse (demote): when wf:* is removed and state:* labels remain, cleans
 * them up so the ticket reverts to ad-hoc.
 *
 * This hook runs before the delegate-based router so a label-only change
 * (no delegate, no assignee, no mention) can bootstrap the ticket.
 */
import type { LinearEvent } from "./webhook/schema.js";
export interface BootstrapResult {
    action: "bootstrapped" | "demoted";
    workflowId?: string;
    entryState?: string;
}
/**
 * Pre-routing bootstrap hook — runs before the delegate-based router.
 *
 * Returns a BootstrapResult if the bootstrap or demote path fired, null otherwise.
 * Never throws: all errors are caught and logged, failing safe.
 */
export declare function maybeBootstrapWorkflow(event: LinearEvent, authToken: string): Promise<BootstrapResult | null>;
//# sourceMappingURL=workflow-bootstrap.d.ts.map