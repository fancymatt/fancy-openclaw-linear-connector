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

// ── Types ─────────────────────────────────────────────────────────────────

export interface LabelNode {
  id: string;
  name: string;
  /** AI-2176: true when this label is a Linear label GROUP, not a regular label.
   *  Only populated by queries that select it; undefined elsewhere. */
  isGroup?: boolean;
  /** AI-2176: the parent group of this label, when it is a group child. */
  parent?: { id: string; name: string } | null;
}

export interface IssueWithLabels {
  internalId: string;
  teamId: string;
  labels: LabelNode[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Find an existing label by name in a team, or create it if missing.
 *
 * Returns the label UUID, or null on failure.
 */
export async function findOrCreateLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
  // AI-2176: group-aware resolution + raw GraphQL error surfacing. See the twin
  // implementation in workflow-gate.ts for the full rationale. A team may model
  // `state:*` as a Linear label GROUP ("state") with bare-named children; a blind
  // flat lookup misses the child and a flat create collides with the group-owned
  // namespace and fail-closes. Fully backwards-compatible with flat colon labels.
  const colonIdx = labelName.indexOf(":");
  const groupName = colonIdx > 0 ? labelName.slice(0, colonIdx) : null;
  const childName = colonIdx > 0 ? labelName.slice(colonIdx + 1) : labelName;

  // Look up existing
  const lookupQuery = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels(first: 250) { nodes { id name isGroup parent { id name } } }
      }
    }
  `;
  let nodes: LabelNode[] = [];
  try {
    const lookupRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: lookupQuery, variables: { teamId } }),
    });
    type LookupResp = { data?: { team?: { labels: { nodes: LabelNode[] } } }; errors?: unknown };
    const lookupData = (await lookupRes.json()) as LookupResp;
    if (lookupData.errors) {
      log.warn(`team label lookup GraphQL errors for team=${teamId} label='${labelName}': ${JSON.stringify(lookupData.errors)}`);
    }
    nodes = lookupData.data?.team?.labels?.nodes ?? [];
    // (a) Flat exact match — unchanged behavior.
    const flat = nodes.find((n) => n.name === labelName && !n.isGroup);
    if (flat) return flat.id;
    // (b) Group-child match.
    if (groupName) {
      const child = nodes.find(
        (n) => !n.isGroup && n.parent?.name === groupName && n.name === childName,
      );
      if (child) return child.id;
    }
  } catch (err) {
    log.error(`label lookup failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Create — as a group child when the namespace is group-owned, else flat.
  const group = groupName ? nodes.find((n) => n.isGroup && n.name === groupName) : undefined;
  const createName = group ? childName : labelName;
  const createMutation = group
    ? `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!, $parentId: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color, parentId: $parentId }) {
        success
        issueLabel { id }
      }
    }
  `
    : `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
        success
        issueLabel { id }
      }
    }
  `;
  const createVars = group
    ? { teamId, name: createName, color: "#94a3b8", parentId: group.id }
    : { teamId, name: createName, color: "#94a3b8" };
  try {
    const createRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: createMutation, variables: createVars }),
    });
    type CreateResp = {
      data?: { issueLabelCreate?: { success: boolean; issueLabel?: { id: string } } };
      errors?: unknown;
    };
    const createData = (await createRes.json()) as CreateResp;
    const result = createData.data?.issueLabelCreate;
    if (result?.success && result.issueLabel) {
      log.info(`created label '${labelName}' in team ${teamId}${group ? ` (child of group '${groupName}')` : ""}`);
      return result.issueLabel.id;
    }
    // AI-2177: surface the raw failure instead of swallowing it.
    const errorBody = createData.errors ? JSON.stringify(createData.errors) : "none";
    log.error(`label create FAIL-CLOSED for '${labelName}' in team ${teamId} (${group ? `child of group '${groupName}'` : "flat"}): success=${result?.success ?? "null"} errors=${errorBody}`);

    // AI-2176 inherited-label fallback (see workflow-gate.ts twin for full rationale).
    const isInheritedConflict = createData.errors &&
      Array.isArray(createData.errors) &&
      createData.errors.some((e: Record<string, unknown>) =>
        typeof e.message === "string" && e.message.includes("conflicting inherited label"),
      );
    if (isInheritedConflict) {
      log.info(`inherited-label fallback for '${labelName}' on team ${teamId}`);
      try {
        const teamsQuery = `query OrgTeams { teams { nodes { id } } }`;
        const teamsRes = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authToken },
          body: JSON.stringify({ query: teamsQuery }),
        });
        const teamsData = (await teamsRes.json()) as {
          data?: { teams?: { nodes: Array<{ id: string }> } };
        };
        const teamIds = teamsData.data?.teams?.nodes?.map((t) => t.id).filter((id) => id !== teamId) ?? [];
        for (const otherTeamId of teamIds) {
          const otherLabelsQuery = `
            query OtherTeamLabels($tid: String!) {
              team(id: $tid) {
                labels(first: 250) { nodes { id name } }
              }
            }
          `;
          const otherRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: otherLabelsQuery, variables: { tid: otherTeamId } }),
          });
          const otherData = (await otherRes.json()) as {
            data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } };
          };
          const match = otherData.data?.team?.labels?.nodes?.find((l) => l.name === labelName);
          if (match) {
            log.info(`inherited-label fallback found '${labelName}' as id=${match.id} on team ${otherTeamId} (usable on sub-team ${teamId})`);
            return match.id;
          }
        }
        log.warn(`inherited-label fallback found no org-wide match for '${labelName}' across ${teamIds.length} teams`);
      } catch (fallbackErr) {
        log.warn(`inherited-label fallback query failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      }
    }

    return null;
  } catch (err) {
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
export async function postComment(
  issueInternalId: string,
  body: string,
  authToken: string,
): Promise<boolean> {
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
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.commentCreate?.success ?? false;
  } catch (err) {
    log.error(`comment post failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Resolve a human-readable issue identifier (e.g. "AI-1441") to an internal UUID.
 *
 * Returns null if the issue is not found or the API call fails.
 */
export async function resolveInternalId(
  identifier: string,
  authToken: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { id } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { id: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.id ?? null;
  } catch (err) {
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
export async function issueUpdateLabels(
  internalId: string,
  labelIds: string[],
  authToken: string,
): Promise<boolean> {
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
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error(`issueUpdate failed for ${internalId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Fetch an issue's internal ID, team ID, and labels with their IDs.
 *
 * Returns null if the issue is not found or the API call fails.
 */
export async function fetchIssueWithLabels(
  identifier: string,
  authToken: string,
): Promise<IssueWithLabels | null> {
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
    type Resp = {
      data?: {
        issue?: {
          id: string;
          team: { id: string };
          labels: { nodes: LabelNode[] };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return { internalId: issue.id, teamId: issue.team.id, labels: issue.labels.nodes };
  } catch (err) {
    log.error(`failed to fetch labels for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
