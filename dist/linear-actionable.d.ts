import type { LinearEvent } from "./webhook/schema.js";
export declare function isTerminalIssueState(state: unknown): boolean;
export declare function issueIdentifierFromSessionKey(ticketId: string): string;
export declare function isTerminalIssueEvent(event: LinearEvent): boolean;
export declare function issueIdentifierFromEvent(event: LinearEvent): string | null;
/**
 * Return false only when Linear confirms the issue is terminal or missing.
 * On auth/network/API uncertainty, keep the ticket actionable so we do not
 * silently drop legitimate work because Linear had a transient failure.
 */
export declare function isLinearIssueActionable(ticketId: string, agentId: string): Promise<boolean>;
//# sourceMappingURL=linear-actionable.d.ts.map