import { componentLogger, createLogger } from "./logger.js";
import { getAccessToken, getAgents } from "./agents.js";
import { fetchWorkflowLabels } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "hierarchy");
const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * INF-475: Address structural inconsistency between spawners to ensure a
 * single canonical hierarchy (Spawner -> Sprint -> Scope/Implementation/Validation).
 *
 * When a ticket is parented to a Sprint (wf:dev-sprint), the connector
 * automatically re-parents it to the appropriate subticket based on its workflow:
 *  - wf:sprint-arm-* -> "Scope"
 *  - wf:task / wf:dev-impl -> "Implementation"
 *  - wf:ui-audit -> "Validation"
 *
 * This enables the "Backlog pull-in" workflow where Matt or an agent can
 * simply set the parent of a task to a Sprint, and the connector ensures it
 * lands in the correct bucket for barrier tracking.
 */

export async function maybeReparentIssue(
  issueId: string,
  newParentId: string,
  authToken: string,
): Promise<void> {
  try {
    // 1. Fetch parent labels to see if it's a Sprint
    const parentLabels = await fetchWorkflowLabels(newParentId, authToken);
    const isSprint = parentLabels.includes("wf:dev-sprint");
    if (!isSprint) return;

    // 2. Fetch issue labels to see its workflow
    const issueLabels = await fetchWorkflowLabels(issueId, authToken);
    const issueWorkflow = issueLabels.find((l) => l.startsWith("wf:"));
    if (!issueWorkflow) return;

    // 3. Resolve target sub-parent title
    const subParentTitle = (() => {
      if (issueWorkflow.startsWith("wf:sprint-arm-")) return "Scope";
      if (issueWorkflow === "wf:dev-impl" || issueWorkflow === "wf:task") return "Implementation";
      if (issueWorkflow === "wf:ui-audit") return "Validation";
      return null;
    })();

    if (!subParentTitle) return;

    // 4. Find the sub-parent among the Sprint's children
    const subParent = await findChildByTitle(newParentId, subParentTitle, authToken);
    if (!subParent) {
      log.warn(`re-parent: could not find '${subParentTitle}' sub-parent for sprint ${newParentId}`);
      return;
    }

    // 5. Apply the re-parenting
    if (subParent.id === newParentId) return; // already there? (shouldn't happen with title match)

    const success = await updateParent(issueId, subParent.id, authToken);
    if (success) {
      log.info(`re-parent: issue ${issueId} (${issueWorkflow}) moved from sprint ${newParentId} to ${subParentTitle} (${subParent.id})`);
    }
  } catch (err) {
    log.error(`re-parent: failed for issue ${issueId} -> parent ${newParentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * INF-475: Ensure the 3 skeleton sub-parents exist for a Sprint.
 * Called when a wf:dev-sprint ticket is created or bootstrapped.
 */
export async function ensureSkeletonChildren(
  sprintId: string,
  teamId: string,
  authToken: string,
): Promise<void> {
  const titles = ["Scope", "Implementation", "Validation"];
  for (const title of titles) {
    const existing = await findChildByTitle(sprintId, title, authToken);
    if (!existing) {
      const description = `Skeleton sub-parent for ${title} bucket. Created automatically to ensure canonical hierarchy (INF-475).`;
      const success = await createIssue(teamId, title, description, sprintId, authToken);
      if (success) {
        log.info(`hierarchy: created skeleton sub-parent '${title}' for sprint ${sprintId}`);
      }
    }
  }
}

async function createIssue(
  teamId: string,
  title: string,
  description: string,
  parentId: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation CreateSkeletonChild($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
      }
    }
  `;
  const input = {
    teamId,
    title,
    description,
    parentId,
  };
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { input } }),
    });
    const data = await res.json() as any;
    return data.data?.issueCreate?.success ?? false;
  } catch (err) {
    log.error(`hierarchy: failed to create skeleton child '${title}': ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function findChildByTitle(
  parentId: string,
  title: string,
  authToken: string,
): Promise<{ id: string } | null> {
  const query = `
    query IssueChildren($id: String!) {
      issue(id: $id) {
        children {
          nodes { id title }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentId } }),
    });
    const data = await res.json() as any;
    const nodes = data.data?.issue?.children?.nodes ?? [];
    return nodes.find((n: any) => n.title === title) ?? null;
  } catch {
    return null;
  }
}

async function updateParent(
  issueId: string,
  parentId: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation UpdateParent($issueId: String!, $parentId: String!) {
      issueUpdate(id: $issueId, input: { parentId: $parentId }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId, parentId } }),
    });
    const data = await res.json() as any;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
}
