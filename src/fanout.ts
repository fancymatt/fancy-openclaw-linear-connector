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
import { generateSpawnPreview, checkCaps, formatPreviewComment, formatCapRefusalComment, parseSpawnCaps, type SpawnPreview, type CapCheckResult, type SpawnCaps } from "./spawn-preview.js";
import type { FanoutConfig, WorkflowDef } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "fanout");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * AI-1994: prefix of the HTML-comment marker embedded in each spawned child's
 * description, binding it to the spec entry that minted it. Full form:
 * `<!-- ai-1994:spec-entry-id: <id> -->`. Read back on re-entry to dedup.
 */
const SPEC_ENTRY_MARKER_PREFIX = "<!-- ai-1994:spec-entry-id: ";
const SPEC_ENTRY_MARKER_RE = /<!--\s*ai-1994:spec-entry-id:\s*(\S+?)\s*-->/;

// ── Types ─────────────────────────────────────────────────────────────────

/** A single finding to fan out into its own child issue. */
export interface Finding {
  /** Short title / summary of the finding. */
  title: string;
  /** Detailed description (optional). */
  description?: string;
  /**
   * AI-1994: engine-derived stable id for this spec entry. Deterministic from
   * the entry's content (title + description), so it is stable across re-entry
   * and independent of position — appending a new entry never shifts existing
   * ids. Used by {@link dedupeSpawnSpec} to match against already-spawned
   * children (`child.specEntryId === finding.id`). Set by
   * {@link extractSpecFindings}; the spec format itself (AI-1992) has no
   * authored id field.
   */
  id?: string;
}

/**
 * AI-1994: a child ticket already spawned from a prior fan-out of the same spec.
 * `specEntryId` is the {@link Finding.id} of the spec entry that minted it,
 * persisted on the child at creation time and read back on re-entry.
 */
export interface ExistingChild {
  /** Human-readable identifier (e.g. "AI-3001"). */
  identifier: string;
  /** The spec entry id this child was spawned from. */
  specEntryId: string;
  /** Current workflow state (any state suppresses re-spawn — informational). */
  state?: string;
}

/** Result of a fan-out operation. */
export interface FanoutResult {
  /** Number of children successfully created. */
  created: number;
  /** Identifiers of created child issues (e.g. ["AI-1443", "AI-1444"]). */
  childIdentifiers: string[];
  /** Errors encountered during creation (non-fatal; partial success allowed). */
  errors: FanoutError[];
  /** Phase 6.5 / H-2: spawn-preview generated before instantiation. */
  preview: SpawnPreview | null;
  /** Phase 6.5 / H-2: whether the fan-out was refused by caps. */
  refused: boolean;
  /** Phase 6.5 / H-2: whether steward approval is pending. */
  pendingApproval: boolean;
  /**
   * AI-1994: identifiers of existing children whose spec entry was removed on
   * re-entry. These are NEVER cancelled (destructive actions stay
   * human/steward-driven) — the engine posts a note listing them instead.
   */
  unmatchedChildren: string[];
}

export interface FanoutError {
  findingIndex: number;
  message: string;
}

// ── Stable spec-entry ids (AI-1994) ────────────────────────────────────────

/**
 * AI-1994: derive a deterministic, content-addressed id for a spec entry.
 *
 * Requirements pinned by the ACs:
 *  - DETERMINISTIC: identical entry content → identical id (survives re-entry).
 *  - STABLE under append: the id depends only on the entry's own content, never
 *    its position, so adding a sibling entry cannot shift it.
 *  - DISTINCT: distinct entries (different title/description) get distinct ids.
 *
 * Implementation: FNV-1a over `title\ndescription`, rendered as fixed-width hex
 * and prefixed with a readable title slug. The slug aids human debugging; the
 * hash guarantees uniqueness even when two titles slugify identically.
 */
function deriveFindingId(title: string, description?: string): string {
  const material = `${title}\n${description ?? ""}`;
  // FNV-1a 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "entry";
  return `${slug}-${hex}`;
}

/** Attach a stable, engine-derived id to each finding (AI-1994). */
function withStableIds(findings: Finding[]): Finding[] {
  return findings.map((f) => ({ ...f, id: deriveFindingId(f.title, f.description) }));
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

/**
 * AI-1992: Strict, config-driven spec extraction — NO title fallback.
 *
 * The declarative fan-out (AC5) refuses the transition on a malformed, ambiguous,
 * or empty spawn spec: the engine never guesses or partially spawns. Unlike
 * {@link extractFindings} (which always yields ≥1 finding via the ticket title),
 * this returns an EMPTY array when the parent description has no parseable spec
 * section named by `spec_source`. The caller treats [] as "refuse the transition".
 *
 * `spec_source` names the description section to read (e.g. "findings" → a
 * `## Findings` / `### Findings` markdown section). Parsing strategies mirror
 * extractFindings (markdown bullets/numbered list, JSON block, inline markers)
 * but are scoped to the named section and carry no fallback.
 */
export function extractSpecFindings(
  description: string | null | undefined,
  specSource: string,
): Finding[] {
  if (!description || !specSource) return [];
  const findings: Finding[] = [];

  // Section header keyed by spec_source (case-insensitive). Escape regex meta.
  const safeName = specSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(
    `(?:#{1,4}\\s+${safeName})\\s*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s|\\n*$)`,
    "i",
  );
  const sectionMatch = sectionRegex.exec(description);
  if (sectionMatch) {
    const sectionBody = sectionMatch[1];
    const lineRegex = /[-*]\s+\*\*(.+?)\*\*(?:[:\s-]+(.*))?|[-*]\s+(.+?)(?:\n|$)|\d+\.\s+(.+?)(?:\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(sectionBody)) !== null) {
      const title = (match[1] ?? match[3] ?? match[4] ?? "").trim();
      const desc = (match[2] ?? "").trim();
      if (title) findings.push({ title, description: desc || undefined });
    }
  }

  // JSON block fallback (still scoped — no title fallback).
  if (findings.length === 0) {
    const jsonMatch = /```json\s*\n([\s\S]*?)\n```/.exec(description);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              findings.push({ title: item.trim() });
            } else if (item && typeof item === "object" && item.title) {
              findings.push({
                title: String(item.title).trim(),
                description: item.description ? String(item.description).trim() : undefined,
              });
            }
          }
        }
      } catch {
        /* not valid JSON — no findings */
      }
    }
  }

  // AI-1994: every extracted entry carries a stable, engine-derived id so the
  // fan-out can dedup against already-spawned children on re-entry.
  return withStableIds(findings);
}

// ── Incremental re-spawn dedup (AI-1994) ────────────────────────────────────

/**
 * AI-1994: pure dedup core for incremental re-spawn.
 *
 * The dev-sprint rework loop re-enters a fan-out state. Without dedup, re-entry
 * would duplicate already-spawned children. This partitions the current spec
 * against the children that already exist:
 *
 *  - `toSpawn` — spec entries with NO existing child (matched by
 *    `finding.id === child.specEntryId`). Only these are minted; existing
 *    children in ANY state (including terminal) suppress re-spawn.
 *  - `unmatchedChildren` — existing children whose spec entry is gone from the
 *    current spec. These are NEVER cancelled here — destructive actions stay
 *    human/steward-driven — the caller surfaces them in a note instead.
 *
 * Pure and side-effect free: given the same inputs it always returns the same
 * partition, which is what makes re-entry idempotent.
 */
export function dedupeSpawnSpec(
  findings: Finding[],
  existingChildren: ExistingChild[],
): { toSpawn: Finding[]; unmatchedChildren: ExistingChild[] } {
  const existingIds = new Set(existingChildren.map((c) => c.specEntryId));
  const specIds = new Set(findings.map((f) => f.id));
  const toSpawn = findings.filter((f) => !existingIds.has(f.id as string));
  const unmatchedChildren = existingChildren.filter((c) => !specIds.has(c.specEntryId));
  return { toSpawn, unmatchedChildren };
}

/**
 * AI-1992: Validate a fan-out spec ahead of the atomic transition (AC5).
 *
 * Returns the extracted findings when the spec is well-formed, or a structured
 * refusal reason otherwise. Used by the workflow engine to refuse the transition
 * BEFORE any state mutation or child spawn when the spec cannot be fully validated.
 */
export function validateFanoutSpec(
  description: string | null | undefined,
  config: FanoutConfig,
): { ok: true; findings: Finding[] } | { ok: false; reason: string } {
  if (!config || !/^wf:.+/.test(config.child_workflow ?? "")) {
    return {
      ok: false,
      reason: `fan-out child_workflow '${String(config?.child_workflow)}' is not a wf:* label — a workflow ticket spawns only workflow children`,
    };
  }
  const findings = extractSpecFindings(description, config.spec_source);
  if (findings.length === 0) {
    return {
      ok: false,
      reason:
        `fan-out spec is empty or unparseable: no '${config.spec_source}' entries found in the ticket description. ` +
        `Add a '## ${config.spec_source}' section with at least one bullet (e.g. "- **Title**: detail") and retry the spawn.`,
    };
  }
  return { ok: true, findings };
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
  delegateId?: string | null,
): Promise<{ internalId: string; identifier: string } | null> {
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
  if (delegateId) input.delegateId = delegateId;

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
      return { internalId: result.issue.id, identifier: result.issue.identifier };
    }
    log.warn(`fanout: issueCreate returned non-success for '${title}': ${JSON.stringify(result)}`);
    return null;
  } catch (err) {
    log.error(`fanout: issueCreate failed for '${title}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * AI-1992: create a "blocks" relation between two child issues (best-effort).
 * Used when a fanout state declares `block_siblings: true`. Fail-open — a failed
 * relation is logged but never aborts the spawn.
 */
async function createBlockingRelation(
  blockerInternalId: string,
  blockedInternalId: string,
  authToken: string,
): Promise<void> {
  const mutation = `
    mutation SiblingBlocks($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) { success }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({
        query: mutation,
        variables: { input: { issueId: blockerInternalId, relatedIssueId: blockedInternalId, type: "blocks" } },
      }),
    });
  } catch (err) {
    log.warn(`fanout: sibling blocking relation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * AI-1992: resolve a body id (e.g. "igor") to a Linear user id for
 * `initial_delegate`. Uses a lazy import of the agent registry to avoid a
 * static import cycle with workflow-gate. Returns null when unresolvable
 * (fail-open — the child simply starts undelegated, as before).
 */
async function resolveInitialDelegate(bodyId: string): Promise<string | null> {
  try {
    const mod = await import("./agents.js");
    const getAgents = (mod as { getAgents?: () => Array<{ name?: string; linearUserId?: string | null }> }).getAgents;
    if (typeof getAgents !== "function") return null;
    const agent = getAgents().find((a) => a.name?.toLowerCase() === bodyId.toLowerCase());
    return agent?.linearUserId ?? null;
  } catch {
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
  config: FanoutConfig,
  options?: {
    caps?: SpawnCaps;
    skipPreview?: boolean;
    findingsOverride?: Finding[];
    /**
     * AI-1994: authoritative list of already-spawned children (test seam,
     * mirroring `findingsOverride` / `skipPreview`). When omitted, the engine
     * fetches the parent's existing spawn-children from Linear so re-entry
     * dedups in production too.
     */
    existingChildren?: ExistingChild[];
  },
): Promise<FanoutResult> {
  const result: FanoutResult = {
    created: 0,
    childIdentifiers: [],
    errors: [],
    preview: null,
    refused: false,
    pendingApproval: false,
    unmatchedChildren: [],
  };

  // AI-1992 AC7 (spawn time): the child workflow type is config-driven and MUST
  // be a wf:* label. Refuse up front — never partially spawn a non-wf child.
  if (!config || typeof config.child_workflow !== "string" || !/^wf:.+/.test(config.child_workflow)) {
    result.refused = true;
    result.errors.push({
      findingIndex: -1,
      message: `Refusing fan-out: child_workflow '${String(config?.child_workflow)}' is not a wf:* label`,
    });
    log.warn(`fanout: REFUSED — non-wf child_workflow '${String(config?.child_workflow)}' for ${parentIssueId}`);
    return result;
  }
  const childWorkflowLabel = config.child_workflow;

  // 1. Fetch parent issue context
  const parentCtx = await fetchIssueTeamAndParent(parentIssueId, authToken);
  if (!parentCtx) {
    result.errors.push({
      findingIndex: -1,
      message: `Failed to fetch parent issue context for ${parentIssueId}`,
    });
    return result;
  }

  // 2. Extract findings from the config-named spec source (AC5 strict — no
  //    title fallback). A pre-flight validated caller may pass findingsOverride.
  const findings = options?.findingsOverride ?? extractSpecFindings(parentCtx.description, config.spec_source);
  log.info(`fanout: extracted ${findings.length} finding(s) from parent ${parentIssueId} (spec_source=${config.spec_source})`);

  if (findings.length === 0) {
    // AC5: an empty/unparseable spec refuses — never partially spawns.
    result.refused = true;
    result.errors.push({
      findingIndex: -1,
      message: `No '${config.spec_source}' entries found — fan-out requires at least one parseable spec entry`,
    });
    return result;
  }

  // ── AI-1994: incremental re-spawn dedup ────────────────────────────
  // The rework loop re-enters this fan-out state. Partition the spec against
  // already-spawned children: mint only entries with no child yet; leave every
  // existing child untouched; surface spec entries that were removed (their
  // child is now "unmatched") in a note rather than cancelling them.
  // `existingChildren` is a test seam; in production we read them back from the
  // parent's children (fail-open → first spawn sees none, spawns everything).
  const existingChildren =
    options?.existingChildren ?? (await fetchExistingSpawnChildren(parentCtx.internalId, authToken));
  const { toSpawn, unmatchedChildren } = dedupeSpawnSpec(findings, existingChildren);
  result.unmatchedChildren = unmatchedChildren.map((c) => c.identifier);

  if (unmatchedChildren.length > 0) {
    // AC2: never cancel — just post a note listing the orphaned children.
    await postUnmatchedChildrenNote(parentCtx.internalId, unmatchedChildren, authToken);
    log.info(
      `fanout: ${unmatchedChildren.length} unmatched child(ren) for ${parentIssueId} ` +
      `(spec entry removed, child preserved): ${result.unmatchedChildren.join(", ")}`,
    );
  }

  if (toSpawn.length === 0) {
    // AC3: unchanged spec re-entry (or every entry already has a child) spawns
    // nothing. This is a legitimate no-op, not a refusal.
    log.info(
      `fanout: incremental dedup — nothing new to spawn for ${parentIssueId} ` +
      `(${findings.length} spec entr${findings.length === 1 ? "y" : "ies"}, all already spawned)`,
    );
    return result;
  }

  // ── Phase 6.5 / H-2: Spawn-preview gate + hard recursion caps ──────
  // Before any child is instantiated, generate a preview and check caps.
  // AC1: exceeding max_children → REFUSED (not truncated).
  // AC2: above approval_above → steward approval required.
  // AC3: preview shows proposed child list before any child ticket exists.
  // Only the NEW children (toSpawn) are previewed/capped — already-spawned
  // siblings don't re-count against the cap on re-entry.
  if (!options?.skipPreview) {
    const caps = options?.caps ?? parseSpawnCaps();

    const previewResult = await generateSpawnPreview(
      parentIssueId,
      authToken,
      toSpawn.map((f) => ({ title: f.title, description: f.description })),
      caps,
    );

    if (previewResult.error) {
      result.errors.push({
        findingIndex: -1,
        message: `Spawn preview generation failed: ${previewResult.error}`,
      });
      return result;
    }

    result.preview = previewResult.preview;

    if (previewResult.preview) {
      // Post the preview comment for human visibility (AC3)
      const previewComment = formatPreviewComment(previewResult.preview);
      await postPreviewComment(parentCtx.internalId, previewComment, authToken);

      // AC1: hard cap violation → refuse entirely
      if (!previewResult.preview.capResult.allowed) {
        result.refused = true;
        result.errors.push({
          findingIndex: -1,
          message: previewResult.preview.capResult.refusalReason ?? "Fan-out refused by hard recursion cap",
        });
        log.warn(`fanout: REFUSED — caps blocked spawn for ${parentIssueId}: ${previewResult.preview.capResult.refusalReason}`);
        return result;
      }

      // AC2: approval_above threshold → return pending state
      if (previewResult.preview.requiresApproval) {
        result.pendingApproval = true;
        log.info(`fanout: pending steward approval for ${parentIssueId} (${previewResult.preview.childCount} children > approval_above ${caps.approvalAbove})`);
        return result;
      }
    }
  }

  // 3. Ensure required labels exist — the child workflow label is config-driven
  //    (AC2: no longer the hardcoded wf:dev-impl).
  const wfLabelId = await ensureLabel(parentCtx.teamId, childWorkflowLabel, authToken);
  const stateLabelId = await ensureLabel(parentCtx.teamId, "state:intake", authToken);

  if (!wfLabelId || !stateLabelId) {
    result.errors.push({
      findingIndex: -1,
      message: `Failed to resolve required labels (${childWorkflowLabel}: ${wfLabelId ?? "missing"}, state:intake: ${stateLabelId ?? "missing"})`,
    });
    return result;
  }

  const labelIds = [wfLabelId, stateLabelId];

  // 4. Create children — one per finding
  // The parent's internal UUID was resolved by fetchIssueTeamAndParent above.
  // No additional API call needed — we already have parentCtx.internalId.
  const parentInternalId = parentCtx.internalId;

  // AI-1992: optional initial delegate (config-driven). Resolve once; children
  // are all delegated to the same body id when configured. Fail-open.
  let initialDelegateId: string | null = null;
  if (config.initial_delegate) {
    initialDelegateId = await resolveInitialDelegate(config.initial_delegate);
    if (!initialDelegateId) {
      log.warn(`fanout: initial_delegate '${config.initial_delegate}' did not resolve to a Linear user — spawning children undelegated`);
    }
  }

  const createdInternalIds: string[] = [];

  // AI-1994: only the deduped `toSpawn` set is minted — existing children are
  // left untouched.
  for (let i = 0; i < toSpawn.length; i++) {
    const finding = toSpawn[i];
    const childTitle = finding.title;

    // Build child description: parent reference + a machine-readable spec-entry
    // marker (AI-1994) so a later re-entry can match this child back to its spec
    // entry and skip re-spawning it. The marker is an HTML comment — invisible
    // in Linear's rendered markdown.
    const childDescription = [
      `Parent: ${parentIssueId}`,
      finding.id ? `${SPEC_ENTRY_MARKER_PREFIX}${finding.id} -->` : "",
      finding.description ? `\n${finding.description}` : "",
    ].filter(Boolean).join("\n");

    const child = await createChildIssue(
      parentCtx.teamId,
      childTitle,
      childDescription,
      parentInternalId,
      labelIds,
      authToken,
      initialDelegateId,
    );

    if (child) {
      result.created++;
      result.childIdentifiers.push(child.identifier);
      createdInternalIds.push(child.internalId);
      log.info(`fanout: created child ${child.identifier} — "${childTitle}" (finding ${i + 1}/${toSpawn.length})`);
    } else {
      result.errors.push({
        findingIndex: i,
        message: `Failed to create child for finding: "${childTitle}"`,
      });
      log.warn(`fanout: failed to create child for finding ${i + 1}/${toSpawn.length}: "${childTitle}"`);
    }
  }

  // AI-1992: optional sibling blocking relations (config-driven) — each sibling
  // blocks the next so the managed children run in a defined order. Fail-open:
  // a failed relation never aborts the spawn.
  if (config.block_siblings && createdInternalIds.length > 1) {
    for (let i = 0; i < createdInternalIds.length - 1; i++) {
      await createBlockingRelation(createdInternalIds[i], createdInternalIds[i + 1], authToken);
    }
    log.info(`fanout: created ${createdInternalIds.length - 1} sibling blocking relation(s) for ${parentIssueId}`);
  }

  log.info(
    `fanout: completed for ${parentIssueId} — ${result.created}/${toSpawn.length} children created` +
    (result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ""),
  );

  return result;
}

/**
 * Post a preview comment on the parent ticket.
 * Fail-open: errors are logged but don't block the operation.
 */
async function postPreviewComment(
  issueInternalId: string,
  commentBody: string,
  authToken: string,
): Promise<void> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body: commentBody } }),
    });
    log.info(`fanout: spawn-preview comment posted on ${issueInternalId}`);
  } catch (err) {
    log.warn(`fanout: failed to post spawn-preview comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * AI-1994: read back the parent's already-spawned children so a re-entry of the
 * fan-out state can dedup against them. Only children carrying the spec-entry
 * marker (i.e. minted by a prior fan-out of this spec) are returned; pre-marker
 * or hand-created children have no marker and are ignored — they neither
 * suppress a spawn nor surface as unmatched.
 *
 * Fail-open: any error (network, unmocked query in a test) yields an empty list,
 * so dedup degrades to "spawn everything" — the pre-AI-1994 behaviour.
 */
async function fetchExistingSpawnChildren(
  parentInternalId: string,
  authToken: string,
): Promise<ExistingChild[]> {
  const query = `
    query FanoutChildren($id: String!) {
      issue(id: $id) {
        children { nodes { identifier description state { name } } }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentInternalId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          children?: {
            nodes?: Array<{ identifier: string; description?: string | null; state?: { name?: string } | null }>;
          } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.children?.nodes ?? [];
    const children: ExistingChild[] = [];
    for (const n of nodes) {
      const m = SPEC_ENTRY_MARKER_RE.exec(n.description ?? "");
      if (m) {
        children.push({ identifier: n.identifier, specEntryId: m[1], state: n.state?.name });
      }
    }
    return children;
  } catch (err) {
    log.warn(`fanout: failed to fetch existing children for dedup (${parentInternalId}): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * AI-1994: post a note listing children whose spec entry was removed on re-entry.
 * These are preserved (never cancelled) — the note hands the destructive decision
 * to a human/steward. Fail-open.
 */
async function postUnmatchedChildrenNote(
  parentInternalId: string,
  unmatched: ExistingChild[],
  authToken: string,
): Promise<void> {
  const list = unmatched.map((c) => `- ${c.identifier}${c.state ? ` (${c.state})` : ""}`).join("\n");
  const body =
    `**Fan-out re-entry: ${unmatched.length} unmatched child${unmatched.length === 1 ? "" : "ren"}.**\n\n` +
    `The following child ticket${unmatched.length === 1 ? "" : "s"} no longer ${unmatched.length === 1 ? "has" : "have"} a matching spec entry ` +
    `(the entry was removed from the spec). They were **not** cancelled — the engine never takes destructive action on a re-entry. ` +
    `Review and close/cancel manually if they are no longer needed:\n\n${list}`;
  await postPreviewComment(parentInternalId, body, authToken);
}

// (resolveInternalId removed — internal UUID is now returned directly by fetchIssueTeamAndParent.)

/**
 * AI-1992: Config-driven fan-out trigger — replaces the hardcoded ux-audit/sprint
 * allowlist. The fan-out fires when the current state declares a `fanout` block
 * and the incoming intent is that state's forward (non-break-glass) transition
 * command. Behavior is entirely YAML-driven: ANY workflow id fans out if its
 * state declares the config; a state with no fanout block never fans out.
 *
 * Returns the {@link FanoutConfig} (truthy) when the fan-out should fire, else
 * null. Returning the config lets the caller mint children under the configured
 * child_workflow and spec_source without re-reading the def.
 */
export function shouldTriggerFanout(
  def: WorkflowDef,
  currentState: string,
  intent: string,
): FanoutConfig | null {
  const state = def?.states?.find((s) => s.id === currentState);
  if (!state || !state.fanout) return null;
  // Never fan out on the break-glass (escape) edge out of a fanout state.
  const breakGlass = def.break_glass?.command ?? "escape";
  if (intent === breakGlass) return null;
  // The intent must be a real forward transition command declared on this state.
  const isForwardCommand = (state.transitions ?? []).some((t) => t.command === intent);
  if (!isForwardCommand) return null;
  return state.fanout;
}
