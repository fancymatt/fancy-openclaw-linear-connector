import type { LinearEvent } from "./webhook/schema.js";
export declare function isTerminalIssueState(state: unknown): boolean;
export declare function isParkedIssueState(state: unknown): boolean;
export interface LinearIssueState {
    name?: string;
    type?: string;
}
export interface LinearIssueReference {
    id?: string;
    identifier?: string;
    state?: LinearIssueState | null;
}
export interface LinearIssueRelation {
    type?: string;
    issue?: LinearIssueReference | null;
    relatedIssue?: LinearIssueReference | null;
}
export interface LinearIssueWithRelations extends LinearIssueReference {
    delegate?: {
        id?: string;
        name?: string;
    } | null;
    assignee?: {
        id?: string;
        name?: string;
    } | null;
    relations?: {
        nodes?: LinearIssueRelation[] | null;
    } | null;
}
export declare function isBlockedByOpenIssue(issue: LinearIssueWithRelations): boolean;
export declare function issueIdentifierFromSessionKey(ticketId: string): string;
export declare function isTerminalIssueEvent(event: LinearEvent): boolean;
export declare function issueIdentifierFromEvent(event: LinearEvent): string | null;
/**
 * Return false only when Linear confirms the issue is terminal or missing.
 * On auth/network/API uncertainty, keep the ticket actionable so we do not
 * silently drop legitimate work because Linear had a transient failure.
 */
export declare function isLinearIssueStillRoutedToAgent(ticketId: string, agentId: string, routingReason: "delegate" | "assignee" | "mention" | "body-mention" | undefined): Promise<boolean>;
export declare function isLinearIssueActionable(ticketId: string, agentId: string): Promise<boolean>;
//# sourceMappingURL=linear-actionable.d.ts.map