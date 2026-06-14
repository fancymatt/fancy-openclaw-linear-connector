/**
 * Shared Linear API helpers — extracted from barrier.ts and review.ts.
 *
 * These functions handle common Linear API operations:
 *   - Label lookup and creation (findOrCreateLabel)
 *   - Comment posting (postComment)
 *   - Identifier → UUID resolution (resolveInternalId)
 *   - Atomic label swaps (issueUpdateLabels)
 *
 * All functions use the shared LINEAR_API_URL and accept an auth token.
 * Module log tag: "linear-helpers".
 */
export declare const LINEAR_API_URL = "https://api.linear.app/graphql";
export interface LabelNode {
    id: string;
    name: string;
}
export interface IssueWithLabels {
    internalId: string;
    teamId: string;
    labels: LabelNode[];
}
/**
 * Find an existing label by name in a team, or create it if missing.
 *
 * Returns the label UUID, or null on failure.
 */
export declare function findOrCreateLabel(teamId: string, labelName: string, authToken: string): Promise<string | null>;
/**
 * Post a comment on a Linear issue.
 *
 * @param issueInternalId - The issue's internal UUID (not the human-readable identifier).
 * @param body - Markdown body of the comment.
 * @param authToken - Linear API auth token.
 * @returns true if the comment was posted successfully.
 */
export declare function postComment(issueInternalId: string, body: string, authToken: string): Promise<boolean>;
/**
 * Resolve a human-readable issue identifier (e.g. "AI-1441") to an internal UUID.
 *
 * Returns null if the issue is not found or the API call fails.
 */
export declare function resolveInternalId(identifier: string, authToken: string): Promise<string | null>;
/**
 * Atomically replace all labels on an issue.
 *
 * @param internalId - The issue's internal UUID.
 * @param labelIds - The complete set of label IDs to set (replaces existing).
 * @param authToken - Linear API auth token.
 * @returns true if the update succeeded.
 */
export declare function issueUpdateLabels(internalId: string, labelIds: string[], authToken: string): Promise<boolean>;
/**
 * Fetch an issue's internal ID, team ID, and labels with their IDs.
 *
 * Returns null if the issue is not found or the API call fails.
 */
export declare function fetchIssueWithLabels(identifier: string, authToken: string): Promise<IssueWithLabels | null>;
//# sourceMappingURL=linear-helpers.d.ts.map