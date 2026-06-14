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
import { componentLogger, createLogger } from "./logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "linear-helpers");
export const LINEAR_API_URL = "https://api.linear.app/graphql";
// ── Helpers ───────────────────────────────────────────────────────────────
/**
 * Find an existing label by name in a team, or create it if missing.
 *
 * Returns the label UUID, or null on failure.
 */
export async function findOrCreateLabel(teamId, labelName, authToken) {
    // Look up existing
    const lookupQuery = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { id name } }
      }
    }
  `;
    try {
        const lookupRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: lookupQuery, variables: { teamId } }),
        });
        const lookupData = (await lookupRes.json());
        const existing = (lookupData.data?.team?.labels?.nodes ?? []).find((n) => n.name === labelName);
        if (existing)
            return existing.id;
    }
    catch (err) {
        log.error(`label lookup failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    // Create
    const createMutation = `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
        success
        issueLabel { id }
      }
    }
  `;
    try {
        const createRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({
                query: createMutation,
                variables: { teamId, name: labelName, color: "#94a3b8" },
            }),
        });
        const createData = (await createRes.json());
        const result = createData.data?.issueLabelCreate;
        if (result?.success && result.issueLabel) {
            log.info(`created label '${labelName}' in team ${teamId}`);
            return result.issueLabel.id;
        }
        return null;
    }
    catch (err) {
        log.error(`label creation failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/**
 * Post a comment on a Linear issue.
 *
 * @param issueInternalId - The issue's internal UUID (not the human-readable identifier).
 * @param body - Markdown body of the comment.
 * @param authToken - Linear API auth token.
 * @returns true if the comment was posted successfully.
 */
export async function postComment(issueInternalId, body, authToken) {
    const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
        });
        const data = (await res.json());
        return data.data?.commentCreate?.success ?? false;
    }
    catch (err) {
        log.error(`comment post failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
/**
 * Resolve a human-readable issue identifier (e.g. "AI-1441") to an internal UUID.
 *
 * Returns null if the issue is not found or the API call fails.
 */
export async function resolveInternalId(identifier, authToken) {
    const query = `query($id: String!) { issue(id: $id) { id } }`;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: identifier } }),
        });
        const data = (await res.json());
        return data.data?.issue?.id ?? null;
    }
    catch (err) {
        log.error(`failed to resolve internal ID for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/**
 * Atomically replace all labels on an issue.
 *
 * @param internalId - The issue's internal UUID.
 * @param labelIds - The complete set of label IDs to set (replaces existing).
 * @param authToken - Linear API auth token.
 * @returns true if the update succeeded.
 */
export async function issueUpdateLabels(internalId, labelIds, authToken) {
    const mutation = `
    mutation UpdateLabels($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: mutation, variables: { issueId: internalId, labelIds } }),
        });
        const data = (await res.json());
        if (!data.data?.issueUpdate?.success) {
            log.warn(`issueUpdate returned non-success for ${internalId}`);
            return false;
        }
        return true;
    }
    catch (err) {
        log.error(`issueUpdate failed for ${internalId}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
/**
 * Fetch an issue's internal ID, team ID, and labels with their IDs.
 *
 * Returns null if the issue is not found or the API call fails.
 */
export async function fetchIssueWithLabels(identifier, authToken) {
    const query = `
    query IssueLabels($id: String!) {
      issue(id: $id) {
        id
        team { id }
        labels { nodes { id name } }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: identifier } }),
        });
        const data = (await res.json());
        const issue = data.data?.issue;
        if (!issue)
            return null;
        return { internalId: issue.id, teamId: issue.team.id, labels: issue.labels.nodes };
    }
    catch (err) {
        log.error(`failed to fetch labels for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
//# sourceMappingURL=linear-helpers.js.map