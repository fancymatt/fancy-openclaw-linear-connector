/**
 * Phase 5 / B-2 — Fan-out edge: spawning 1→N (AI-1439).
 *
 * Engine logic for the fan-out. On the researcher's `auditing → spawning` submit,
 * the findings list is the runtime cardinality (§5.2): the engine creates N
 * `dev-impl` children, links each to the parent, and transitions the parent → `managing`.
 *
 * Design: design.md §5.2, §5.4, §14.
 *
 * ACs:
 *   1. `submit` from `auditing` carries the findings list; engine mints N `dev-impl`
 *      children (each at `state:intake`, wf:dev-impl), one per finding.
 *   2. Each child is linked to the parent (parent/child relation set).
 *   3. Parent auto-transitions to `managing` once children are minted.
 *   4. A child may itself be an orchestrator — minting is uniform regardless (§5.4);
 *      no special-casing.
 *
 * This module is called from workflow-gate's applyStateTransition when the `spawn`
 * command is processed for a ux-audit ticket in the `spawning` state.
 */

import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "fanout");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ─────────────────────────────────────────────────────────────────

/** A single finding to fan out into its own child issue. */
export interface Finding {
  /** Short title / summary of the finding. */
  title: string;
  /** Detailed description (optional). */
  description?: string;
}

/** Result of a fan-out operation. */
export interface FanoutResult {
  /** Number of children successfully created. */
  created: number;
  /** Identifiers of created child issues (e.g. ["AI-1443", "AI-1444"]). */
  childIdentifiers: string[];
  /** Errors encountered during creation (non-fatal; partial success allowed). */
  errors: FanoutError[];
}

export interface FanoutError {
  findingIndex: number;
  message: string;
}

// ── Finding extraction ────────────────────────────────────────────────────

/**
 * Parse findings from the ticket description.
 *
 * The researcher submits the findings list as part of the `complete-audit`
 * transition. The findings are embedded in the issue description in a structured
 * format. This parser extracts them.
 *
 * Expected format in the description (Markdown):
 * ```
 * ## Findings
 * - **Finding 1**: Short title
 * - **Finding 2**: Another title
 * ```
 *
 * Or as a structured block:
 * ```
 * ### Findings
 * 1. Title one
 * 2. Title two
 * 3. Title three
 * ```
 *
 * Falls back to line-by-line extraction if no structured block found.
 * Returns at least one finding (the ticket title itself as fallback) so the
 * fan-out always produces at least one child (§5.2).
 */
export function extractFindings(description: string | null | undefined, fallbackTitle: string): Finding[] {
  if (!description) {
    return [{ title: fallbackTitle }];
  }

  const findings: Finding[] = [];

  // Strategy 1: Look for "## Findings" or "### Findings" section
  const findingsSectionRegex = /(?:#{1,4}\s+Findings)\s*\n([\s\S]*?)(?=\n#{1,4}\s|\n*$)/i;
  const sectionMatch = findingsSectionRegex.exec(description);

  if (sectionMatch) {
    const sectionBody = sectionMatch[1];
    // Parse bullet points or numbered lists
    const lineRegex = /[-*]\s+\*\*(.+?)\*\*(?:[:\s-]+(.*))?|[-*]\s+(.+?)(?:\n|$)|\d+\.\s+(.+?)(?:\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(sectionBody)) !== null) {
      const title = (match[1] ?? match[3] ?? match[4] ?? "").trim();
      const desc = (match[2] ?? "").trim();
      if (title) {
        findings.push({ title, description: desc || undefined });
      }
    }
  }

  // Strategy 2: Look for a JSON-encoded findings block
  if (findings.length === 0) {
    const jsonRegex = /```json\s*\n([\s\S]*?)\n```/;
    const jsonMatch = jsonRegex.exec(description);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              findings.push({ title: item.trim() });
            } else if (typeof item === "object" && item.title) {
              findings.push({
                title: String(item.title).trim(),
                description: item.description ? String(item.description).trim() : undefined,
              });
            }
          }
        }
      } catch {
        // Not valid JSON — fall through
      }
    }
  }

  // Strategy 3: Look for inline findings markers (<!-- findings:N --> or similar)
  if (findings.length === 0) {
    const inlineRegex = /<!--\s*finding:\s*(.+?)\s*-->/gi;
    let match: RegExpExecArray | null;
    while ((match = inlineRegex.exec(description)) !== null) {
      findings.push({ title: match[1].trim() });
    }
  }

  // Fallback: at least one finding using the ticket title
  if (findings.length === 0) {
    findings.push({ title: fallbackTitle });
  }

  return findings;
}

// ── Linear API helpers ────────────────────────────────────────────────────

/**
 * Fetch the issue's team ID and parent info.
 */
async function fetchIssueTeamAndParent(
  issueId: string,
  authToken: string,
): Promise<{ internalId: string; teamId: string; parentIssueId: string | null; description: string | null; title: string | null } | null> {
  const query = `
    query IssueTeamParent($id: String!) {
      issue(id: $id) {
        id
        title
        description
        team { id }
        parent { id }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          id: string;
          title: string | null;
          description: string | null;
          team: { id: string };
          parent: { id: string } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      internalId: issue.id,
      teamId: issue.team.id,
      parentIssueId: issue.parent?.id ?? null,
      description: issue.description,
      title: issue.title,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`fanout: failed to fetch issue team/parent for ${issueId}: ${msg}`);
    return null;
  }
}

/**
 * Resolve a label ID by name within a team. Creates the label if it doesn't exist.
 */
async function ensureLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
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
    type LookupResp = { data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } } };
    const lookupData = (await lookupRes.json()) as LookupResp;
    const existing = (lookupData.data?.team?.labels?.nodes ?? []).find(
      (n) => n.name === labelName,
    );
    if (existing) return existing.id;
  } catch (err) {
    log.error(`fanout: label lookup failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
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
    type CreateResp = {
      data?: { issueLabelCreate?: { success: boolean; issueLabel?: { id: string } } };
    };
    const createData = (await createRes.json()) as CreateResp;
    const result = createData.data?.issueLabelCreate;
    if (result?.success && result.issueLabel) {
      log.info(`fanout: created label '${labelName}' in team ${teamId}`);
      return result.issueLabel.id;
    }
    return null;
  } catch (err) {
    log.error(`fanout: label creation failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Create a single child issue in Linear.
 * Returns the child's human-readable identifier (e.g. "AI-1443") on success.
 */
async function createChildIssue(
  teamId: string,
  title: string,
  description: string | undefined,
  parentIssueId: string,
  labelIds: string[],
  authToken: string,
): Promise<string | null> {
  const mutation = `
    mutation CreateChild($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier }
      }
    }
  `;
  const input: Record<string, unknown> = {
    teamId,
    title,
    description: description ?? "",
    labelIds,
    parentId: parentIssueId,
  };

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { input } }),
    });
    type Resp = {
      data?: {
        issueCreate?: {
          success: boolean;
          issue?: { id: string; identifier: string } | null;
        };
      };
    };
    const data = (await res.json()) as Resp;
    const result = data.data?.issueCreate;
    if (result?.success && result.issue) {
      return result.issue.identifier;
    }
    log.warn(`fanout: issueCreate returned non-success for '${title}': ${JSON.stringify(result)}`);
    return null;
  } catch (err) {
    log.error(`fanout: issueCreate failed for '${title}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Execute the fan-out: create N dev-impl children from the findings list.
 *
 * Called by the workflow engine when the `spawn` command is processed on a
 * ux-audit ticket in the `spawning` state.
 *
 * Steps:
 *   1. Fetch the parent issue's team, title, and description.
 *   2. Extract findings from the description.
 *   3. Ensure required labels exist (wf:dev-impl, state:intake).
 *   4. Create one child issue per finding, each linked to the parent.
 *   5. Return the result with created count and any partial errors.
 *
 * The caller (applyStateTransition) transitions the parent to `managing`
 * after a successful fan-out (or logs a warning on partial failure).
 *
 * AC4 (§5.4): Minting is uniform — children are always created as dev-impl
 * at intake, regardless of whether the child itself might be an orchestrator
 * archetype. No special-casing.
 */
export async function executeFanout(
  parentIssueId: string,
  authToken: string,
  findingsOverride?: Finding[],
): Promise<FanoutResult> {
  const result: FanoutResult = {
    created: 0,
    childIdentifiers: [],
    errors: [],
  };

  // 1. Fetch parent issue context
  const parentCtx = await fetchIssueTeamAndParent(parentIssueId, authToken);
  if (!parentCtx) {
    result.errors.push({
      findingIndex: -1,
      message: `Failed to fetch parent issue context for ${parentIssueId}`,
    });
    return result;
  }

  // 2. Extract findings
  const findings = findingsOverride ?? extractFindings(parentCtx.description, parentCtx.title ?? "Untitled finding");
  log.info(`fanout: extracted ${findings.length} finding(s) from parent ${parentIssueId}`);

  if (findings.length === 0) {
    result.errors.push({
      findingIndex: -1,
      message: "No findings extracted — fan-out requires at least one finding",
    });
    return result;
  }

  // 3. Ensure required labels exist
  const wfLabelId = await ensureLabel(parentCtx.teamId, "wf:dev-impl", authToken);
  const stateLabelId = await ensureLabel(parentCtx.teamId, "state:intake", authToken);

  if (!wfLabelId || !stateLabelId) {
    result.errors.push({
      findingIndex: -1,
      message: `Failed to resolve required labels (wf:dev-impl: ${wfLabelId ?? "missing"}, state:intake: ${stateLabelId ?? "missing"})`,
    });
    return result;
  }

  const labelIds = [wfLabelId, stateLabelId];

  // 4. Create children — one per finding
  // The parent's internal UUID was resolved by fetchIssueTeamAndParent above.
  // No additional API call needed — we already have parentCtx.internalId.
  const parentInternalId = parentCtx.internalId;

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    const childTitle = finding.title;

    // Build child description: include finding details + parent reference
    const childDescription = [
      `Parent: ${parentIssueId}`,
      finding.description ? `\n${finding.description}` : "",
    ].join("\n");

    const childId = await createChildIssue(
      parentCtx.teamId,
      childTitle,
      childDescription,
      parentInternalId,
      labelIds,
      authToken,
    );

    if (childId) {
      result.created++;
      result.childIdentifiers.push(childId);
      log.info(`fanout: created child ${childId} — "${childTitle}" (finding ${i + 1}/${findings.length})`);
    } else {
      result.errors.push({
        findingIndex: i,
        message: `Failed to create child for finding: "${childTitle}"`,
      });
      log.warn(`fanout: failed to create child for finding ${i + 1}/${findings.length}: "${childTitle}"`);
    }
  }

  log.info(
    `fanout: completed for ${parentIssueId} — ${result.created}/${findings.length} children created` +
    (result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ""),
  );

  return result;
}

// (resolveInternalId removed — internal UUID is now returned directly by fetchIssueTeamAndParent.)

/**
 * Determine if the fan-out should be triggered for a given workflow + state + command.
 * Returns true when:
 *   - The workflow is ux-audit or sprint (any archetype that fans out 1→N)
 *   - The state is spawning
 *   - The command is spawn
 *
 * Phase 6 / C-3 (AI-1473): generalized from ux-audit-only to archetype-agnostic.
 * Both orchestrator (ux-audit) and feature-initiative (sprint) archetypes use
 * the same fan-out pattern: spawning state, spawn command → mint dev-impl children.
 */
export function shouldTriggerFanout(
  workflowId: string,
  currentState: string,
  intent: string,
): boolean {
  return (workflowId === "ux-audit" || workflowId === "sprint") && currentState === "spawning" && intent === "spawn";
}
