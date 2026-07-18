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
  /** AI-2557: the team that owns this label. Undefined when the query doesn't select it.
   *  Used to reject inherited parent-team label IDs that Linear rejects on atomic write. */
  team?: { id: string };
}

export interface IssueWithLabels {
  internalId: string;
  teamId: string;
  labels: LabelNode[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function lookupTeamLabels(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<{ nodes: LabelNode[]; error: boolean }> {
  const colonIdx = labelName.indexOf(":");
  const lookupQuery = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels(first: 250) { nodes { id name isGroup team { id } parent { id name } } }
      }
    }
  `;
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
    return { nodes: lookupData.data?.team?.labels?.nodes ?? [], error: false };
  } catch (err) {
    log.error(`label lookup failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return { nodes: [], error: true };
  }
}

function findLabelInNodes(
  nodes: LabelNode[],
  labelName: string,
  teamId: string,
): string | null {
  const colonIdx = labelName.indexOf(":");
  const groupName = colonIdx > 0 ? labelName.slice(0, colonIdx) : null;
  const childName = colonIdx > 0 ? labelName.slice(colonIdx + 1) : labelName;

  // AI-2557: only return a label ID if it is owned by the requesting team.
  // Inherited parent-team labels pass the name check but Linear rejects their ID
  // on atomic issueUpdate(labelIds:). A non-matching team falls through to create
  // → inherited conflict → replaceTeamLabels promotion (AI-2543).
  // Labels without a `team` field (compatibility/default) always match.
  const flat = nodes.find((n) => n.name === labelName && !n.isGroup && (n.team == null || n.team.id === teamId));
  if (flat) return flat.id;
  if (groupName) {
    const child = nodes.find(
      (n) => !n.isGroup && n.parent?.name === groupName && n.name === childName && (n.team == null || n.team.id === teamId),
    );
    if (child) return child.id;
  }
  return null;
}

/**
 * Find an existing label by name in a team.
 *
 * Returns the label UUID, or null when absent or lookup fails.
 */
export async function findLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
  // INF-27 AC2: lookup-only twin of findOrCreateLabel for guarded wf:* labels.
  const lookup = await lookupTeamLabels(teamId, labelName, authToken);
  if (lookup.error) return null;
  return findLabelInNodes(lookup.nodes, labelName, teamId);
}

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

  const lookup = await lookupTeamLabels(teamId, labelName, authToken);
  if (lookup.error) {
    return null;
  }
  const nodes = lookup.nodes;
  const existing = findLabelInNodes(nodes, labelName, teamId);
  if (existing) return existing;

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
      // INF-41 AC4 defense-in-depth: log a warning when a wf:* label is created
      // at fanout time. If the registry validation gate was bypassed, this warns
      // that a label was minted for a potentially unregistered workflow — the child
      // will be enrolled in a workflow def that may not exist. This is diagnostic:
      // it lets us detect the case in production without a hard-fail that would
      // break test fixtures that legitimately create wf:* labels during setup.
      if (labelName.startsWith("wf:")) {
        log.warn(
          `linear-helpers: INF-41: created wf:* label '${labelName}' at creation time — if this workflow is not registered, ` +
          `the child will be enrolled in a nonexistent workflow def. Consider adding a workflow definition.`,
        );
      }
      log.info(`created label '${labelName}' in team ${teamId}${group ? ` (child of group '${groupName}')` : ""}`);
      return result.issueLabel.id;
    }
    // AI-2177: surface the raw failure instead of swallowing it.
    const errorBody = createData.errors ? JSON.stringify(createData.errors) : "none";
    log.error(`label create FAIL-CLOSED for '${labelName}' in team ${teamId} (${group ? `child of group '${groupName}'` : "flat"}): success=${result?.success ?? "null"} errors=${errorBody}`);

    // AI-2543 inherited-label promotion: Linear rejects a parent-team create with
    // "conflicting inherited label" and tells us to use `replaceTeamLabels` to promote
    // the label to this team. Retry with the promotion argument; the promoted label
    // is then owned by this team and accepted on issueUpdate.
    // (Replaces the AI-2176 fallback that borrowed the parent id — that id is rejected
    // by Linear's issueUpdate, blocking all governed transitions on the sub-team.)
    const isInheritedConflict = createData.errors &&
      Array.isArray(createData.errors) &&
      createData.errors.some((e: Record<string, unknown>) =>
        typeof e.message === "string" && e.message.includes("conflicting inherited label"),
      );
    if (isInheritedConflict) {
      // AI-2543 + AGI-12: Linear's IssueLabelCreateInput does NOT accept
      // `replaceTeamLabels` — it was removed from the schema. A plain retry
      // with `teamId` just repeats the same rejected create. Instead, omit
      // `teamId` to create a WORKSPACE-LEVEL label (visible to all teams),
      // which cannot have inheritance conflicts and is accepted by every
      // team's issueUpdate. For workflow state labels (state:*) this is also
      // semantically correct — they are universal, not team-specific.
      log.info(`inherited-label promotion for '${labelName}' — retrying as workspace-level label`);
      const promoteMutation = `
        mutation PromoteLabel($name: String!, $color: String!) {
          issueLabelCreate(input: { name: $name, color: $color }) {
            success
            issueLabel { id }
          }
        }
      `;
      const promoteVars = { name: createName, color: "#94a3b8" };
      try {
        const promoteRes = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authToken },
          body: JSON.stringify({ query: promoteMutation, variables: promoteVars }),
        });
        const promoteData = (await promoteRes.json()) as CreateResp;
        const promoteResult = promoteData.data?.issueLabelCreate;
        if (promoteResult?.success && promoteResult.issueLabel) {
          log.info(`promoted inherited label '${labelName}' to team ${teamId} as id=${promoteResult.issueLabel.id}`);
          return promoteResult.issueLabel.id;
        }
        const errBody = promoteData.errors ? JSON.stringify(promoteData.errors) : "none";
        log.warn(`inherited-label promotion failed for '${labelName}' on team ${teamId}: success=${promoteResult?.success ?? "null"} errors=${errBody}`);
      } catch (promoteErr) {
        log.warn(`inherited-label promotion failed: ${promoteErr instanceof Error ? promoteErr.message : String(promoteErr)}`);
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
export async function fetchLastCommentByUser(
  identifier: string,
  linearUserId: string,
  authToken: string,
): Promise<{ body: string; createdAt: string } | null> {
  const query = `
    query LastCommentByUser($id: String!) {
      issue(id: $id) {
        comments(first: 50, orderBy: createdAt) {
          nodes {
            body
            createdAt
            user {
              id
            }
          }
        }
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
          comments: {
            nodes: Array<{ body: string; createdAt: string; user: { id: string } | null }>;
          };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const comments = data.data?.issue?.comments?.nodes ?? [];
    // Scan newest-to-oldest for the first comment by the specified user
    // (comments are returned in ascending order by default even with first:50,
    // so iterate in reverse for newest-first by the target user).
    for (let i = comments.length - 1; i >= 0; i--) {
      const node = comments[i];
      if (node.user?.id === linearUserId && node.body?.trim()) {
        return { body: node.body, createdAt: node.createdAt };
      }
    }
    return null;
  } catch (err) {
    log.warn(`fetchLastCommentByUser failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Fetch issue labels and team id for label manipulation.
 *
 * Returns { internalId, teamId, labels } on success, null on any error.
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
