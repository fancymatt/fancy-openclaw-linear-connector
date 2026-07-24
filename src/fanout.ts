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
 *
 * AI-2523: spawn_if predicate — conditional child spawning. A state declaring
 * `spawn_if: { label_present: "ui-impact" }` spawns its child_workflow ONLY when
 * a closed child ticket carries that label. When no child carries the label, the
 * gate auto-waives and the parent proceeds with no steward action. The predicate
 * evaluation result is recorded on FanoutResult for inspection.
 */

import { componentLogger, createLogger } from "./logger.js";
import { findLabel, findOrCreateLabel } from "./linear-helpers.js";
import { generateSpawnPreview, checkCaps, formatPreviewComment, formatCapRefusalComment, parseSpawnCaps, type SpawnPreview, type CapCheckResult, type SpawnCaps } from "./spawn-preview.js";
import type { FanoutConfig, SpawnIfConfig, WorkflowDef } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "fanout");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * AI-1994: prefix of the HTML-comment marker embedded in each spawned child's
 * description, binding it to the spec entry that minted it. Full form:
 * `<!-- ai-1994:spec-entry-id: <id> -->`. Read back on re-entry to dedup.
 */
const SPEC_ENTRY_MARKER_PREFIX = "<!-- ai-1994:spec-entry-id: ";
const SPEC_ENTRY_MARKER_RE = /<!--\s*ai-1994:spec-entry-id:\s*(\S+?)\s*-->/;

/**
 * INF-32: marker binding a spawned child to the `wf:*` workflow that minted it.
 * Full form: `<!-- inf-32:child-workflow: wf:dev-impl -->`. Written alongside the
 * AI-1994 spec-entry marker; read back so dedup can key on
 * `(specEntryId, child_workflow)` instead of the content-addressed id alone.
 * Children minted before INF-32 carry no such marker — the read path falls back
 * to the child's own `wf:*` label, then to an id-only match.
 */
const CHILD_WORKFLOW_MARKER_PREFIX = "<!-- inf-32:child-workflow: ";
const CHILD_WORKFLOW_MARKER_RE = /<!--\s*inf-32:child-workflow:\s*(\S+?)\s*-->/;

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
  /**
   * AI-2199: per-entry child workflow override. When set, this finding's
   * children are labeled with this workflow id instead of the fanout config's
   * `child_workflow` default. Parsed from the `[wf:sprint-arm-ux → signe]`
   * marker in the spec entry title.
   */
  child_workflow?: string;
  /**
   * AI-2199: per-entry delegate override. When set, this finding's child is
   * delegated to this body id instead of the fanout config's `initial_delegate`.
   * Parsed from the `[wf:sprint-arm-ux → signe]` marker (the part after →).
   */
  delegate?: string;
  /** INF-359: classification of this implementation entry. */
  classification?: string;
  /** INF-359: capability this entry traces to, when classification requires one. */
  capability?: string;
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
  /**
   * INF-32: the `wf:*` workflow that minted this child. Spec-entry ids are
   * content-addressed, so two fan-outs on one parent sharing a `spec_source`
   * derive identical ids; without this field the second fan-out reads the
   * first's children as its own and mints nothing. Optional: children minted
   * before INF-32 carry no workflow marker — see {@link dedupeSpawnSpec} for
   * the legacy read path.
   */
  childWorkflow?: string;
}

/**
 * INF-37: The outcome of a spawn_if predicate evaluation.
 *
 * `waived` and `failed` both mean "no children spawned" but are NOT
 * interchangeable: `waived` is an answer, `failed` is the absence of one.
 * A barrier may vacuously satisfy on `waived`; it must never do so on `failed`.
 */
export type SpawnIfOutcome =
  /** The predicate evaluated true on a successful read — spawn. */
  | "fire"
  /** The predicate evaluated false on a successful read — legitimately skip. */
  | "waived"
  /** The predicate could not be evaluated (read/transport/GraphQL error). */
  | "failed";

/** AI-2523: Result of a spawn_if predicate evaluation. */
export interface SpawnIfResult {
  /**
   * INF-37: the discriminant. `waived` vs `failed` is a load-bearing
   * distinction — see SpawnIfOutcome. Prefer this over `reason`, which is
   * human-readable prose and not a contract.
   */
  outcome: SpawnIfOutcome;
  /** Whether the predicate passed — children should be spawned. Equivalent to `outcome === "fire"`. */
  shouldSpawn: boolean;
  /** Human-readable explanation of the evaluation outcome. */
  reason: string;
  /** Identifiers of closed children that carried the target label (empty when waived). */
  matchedChildren: string[];
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
  /**
   * AI-2523: result of spawn_if predicate evaluation, if configured.
   */
  spawnIfResult?: SpawnIfResult;
  /**
   * INF-28: number of spec entries the fan-out attempted to spawn (toSpawn.length).
   * Distinguished from `created` — attempted > 0 && created === 0 means the mint
   * failed, not that the spec was empty or waived.
   */
  attempted: number;
  /**
   * INF-28: identifiers of all children that match the current spec (newly minted ∪
   * existing children whose specEntryId is in the current spec). Unlike
   * `childIdentifiers` (new mints only), this includes pre-existing spec-matched
   * children, so the barrier can wait on the correct set rather than re-querying
   * accumulated history.
   */
  specMatchedChildren: string[];
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

function extractMetadataValue(material: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[;\\n])\\s*${escaped}\\s*:\\s*([^;\\n]+)`, "i").exec(material);
  return match?.[1]?.trim();
}

function withFindingMetadata(finding: Finding): Finding {
  const material = `${finding.title}\n${finding.description ?? ""}`;
  return {
    ...finding,
    classification: finding.classification ?? extractMetadataValue(material, "classification"),
    capability: finding.capability ?? extractMetadataValue(material, "capability"),
  };
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
            } else if (item && typeof item === "object" && "title" in item && item.title) {
              findings.push({
                title: String(item.title).trim(),
                description: "description" in item && item.description ? String(item.description).trim() : undefined,
                classification: "classification" in item && item.classification ? String(item.classification).trim() : undefined,
                capability: "capability" in item && item.capability ? String(item.capability).trim() : undefined,
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
  /**
   * AI-2199: regex for per-entry child workflow marker in spec bullet titles.
   * Matches: [wf:sprint-arm-ux → signe] or [wf:sprint-arm-ux]
   * The arrow (→ or ->) separates workflow id from optional delegate.
   */
  const PER_ENTRY_MARKER_RE = /^\\?\[wf:([^\s\\\]]+)(?:\s*[→>-]\s*([^\s\\\]]+))?\\?\]\s*/;

  /**
   * INF-488: ASCII arrow arm markers ("-> sprint-arm-x: title" or
   * "-> sprint-arm-x -> delegate: title"). These are a distinct line shape
   * from the bullet/numbered formats below — a bare "-" immediately followed
   * by ">" never satisfies the bullet regex's "[-*]\s+" prefix (whitespace
   * must follow the "-"), so the whole line was silently skipped and the
   * arm's workflow/delegate routing fell back to the fanout default.
   */
  const ARROW_LINE_RE = /^->\s*([^\s:>]+)(?:\s*->\s*([^\s:]+))?\s*:\s*(.+)$/;
  const lineRegex = /[-*]\s+\*\*(.+?)\*\*(?:[:\s-]+(.*))?|[-*]\s+(.+?)(?:\n|$)|\d+\.\s+(.+?)(?:\n|$)/;

  if (sectionMatch) {
    const sectionBody = sectionMatch[1];
    for (const rawLine of sectionBody.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const arrowMatch = ARROW_LINE_RE.exec(line);
      if (arrowMatch) {
        const title = arrowMatch[3].trim();
        if (title) {
          const finding: Finding = { title, child_workflow: `wf:${arrowMatch[1]}` };
          if (arrowMatch[2]) {
            finding.delegate = arrowMatch[2];
          }
          findings.push(finding);
        }
        continue;
      }

      const match = lineRegex.exec(line);
      if (!match) continue;
      const title = (match[1] ?? match[3] ?? match[4] ?? "").trim();
      const desc = (match[2] ?? "").trim();
      if (title) {
        // AI-2199: check for per-entry child workflow marker
        const markerMatch = PER_ENTRY_MARKER_RE.exec(title);
        // Guard: a marker that consumes the ENTIRE title (no trailing text)
        // would strip to an empty string — keep the literal text instead of
        // producing an unusable blank title.
        const strippedTitle =
          markerMatch && title.length > markerMatch[0].length
            ? title.slice(markerMatch[0].length)
            : title;
        const finding: Finding = {
          title: strippedTitle,
          description: desc || undefined,
        };
        if (markerMatch) {
          finding.child_workflow = `wf:${markerMatch[1]}`;
          if (markerMatch[2]) {
            finding.delegate = markerMatch[2];
          }
        }
        findings.push(finding);
      }
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
                classification: item.classification ? String(item.classification).trim() : undefined,
                capability: item.capability ? String(item.capability).trim() : undefined,
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
  return withStableIds(findings.map(withFindingMetadata));
}

// ── INF-123: Auto-derive Findings from completed arm children ──────────────

/**
 * INF-123: Query a parent issue's children and auto-derive `## Findings` entries
 * from the terminal descriptions of completed `wf:sprint-arm-*` children.
 *
 * The sprint workflow spawns arm children via `spawn-arms`. When those arms
 * complete, their terminal descriptions contain the findings they produced.
 * `spawn-impl` traditionally required the steward to hand-transcribe these into
 * a `## Findings` section on the parent. This function fills that gap by reading
 * the completed arms and synthesizing Finding entries.
 *
 * Returns the derived findings (with stable IDs) or an empty array if no
 * completed arm children with findings are found. Fail-open: errors (network,
 * parse) are logged and return [].
 */
export async function autoDeriveArmFindings(
  parentInternalId: string,
  authToken: string,
): Promise<Finding[]> {
  const query = `
    query ParentChildrenForArmFindings($id: String!) {
      issue(id: $id) {
        children {
          nodes {
            identifier
            description
            state { name type }
            labels { nodes { name } }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentInternalId } }),
    });
    type ArmChild = {
      identifier: string;
      description?: string | null;
      state?: { name: string; type: string } | null;
      labels?: { nodes?: Array<{ name?: string }> } | null;
    };
    type Resp = {
      data?: {
        issue?: {
          children?: {
            nodes?: ArmChild[];
          } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.children?.nodes ?? [];

    // Filter to terminal children with wf:sprint-arm-* labels
    const armChildren = nodes.filter((n) => {
      const isTerminal = n.state?.type === "completed";
      const hasArmLabel = (n.labels?.nodes ?? []).some(
        (l) => typeof l.name === "string" && /^wf:sprint-arm-/.test(l.name),
      );
      return isTerminal && hasArmLabel && n.description;
    });

    if (armChildren.length === 0) {
      log.info(`autoDeriveArmFindings: no terminal wf:sprint-arm-* children found for ${parentInternalId}`);
      return [];
    }

    // Extract findings from each arm's description
    const allFindings: Finding[] = [];
    const seenTitles = new Set<string>();

    for (const child of armChildren) {
      // Each arm's terminal description should contain a `## Findings` section
      const armFindings = extractSpecFindings(child.description, "findings");
      for (const f of armFindings) {
        // Deduplicate by title across arms
        if (!seenTitles.has(f.title)) {
          seenTitles.add(f.title);
          allFindings.push(f);
        }
      }
    }

    log.info(
      `autoDeriveArmFindings: derived ${allFindings.length} finding(s) from ${armChildren.length} completed arm child(ren) for ${parentInternalId}: ${allFindings.map((f) => f.title).join(", ")}`,
    );
    return withStableIds(allFindings);
  } catch (err) {
    log.warn(
      `autoDeriveArmFindings: failed for ${parentInternalId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * INF-258: Derive structured spec entries from children of the parent ticket.
 *
 * When a parent ticket enters a fan-out state with `spec_source: structured`
 * but has no `## Structured` section in its description (e.g. pre-existing
 * children created by sprint-spawner), this function examines the parent's
 * existing children with workflow labels matching wf:sprint-arm-* patterns
 * and creates structured entries from their titles.
 *
 * Returns an array of Finding objects (title + optional description) that can
 * be formatted into a `## Structured` section. Returns empty array when no
 * suitable children are found.
 */
export async function deriveStructuredFromChildren(
  parentInternalId: string,
  authToken: string,
): Promise<Pick<Finding, "title" | "description">[]> {
  const query = `
    query Inf258StructuredChildren($id: String!) {
      issue(id: $id) {
        children {
          nodes {
            identifier
            title
            labels { nodes { name } }
          }
        }
      }
    }
  `;
  type ChildNode = {
    identifier: string;
    title?: string | null;
    labels?: { nodes?: Array<{ name?: string }> } | null;
  };
  let nodes: ChildNode[] = [];
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentInternalId } }),
    });
    const data = (await res.json()) as {
      data?: { issue?: { children?: { nodes?: ChildNode[] } | null } | null };
    };
    nodes = data.data?.issue?.children?.nodes ?? [];
  } catch (err) {
    log.warn(
      `fanout: INF-258: failed to fetch children for ${parentInternalId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const derived: Pick<Finding, "title" | "description">[] = [];
  for (const child of nodes) {
    const wfLabel = (child.labels?.nodes ?? [])
      .map((l) => l.name)
      .find((name): name is string => typeof name === "string" && name.startsWith("wf:sprint-arm-"));
    if (!wfLabel) continue;

    const title = (child.title ?? child.identifier).trim();
    const description = `spawned from ${child.identifier}`;
    derived.push({ title, description });
  }

  if (derived.length > 0) {
    log.info(
      `fanout: INF-258: derived ${derived.length} structured entry(ies) from children of ${parentInternalId}`,
    );
  }
  return derived;
}

/**
 * INF-123: Auto-populate (or replace) a `## Findings` section on an issue's
 * description from an array of findings. Uses the Linear API to update the
 * description.
 *
 * When the description already has a `## Findings` section, it is replaced.
 * Otherwise the section is prepended to the existing content (or becomes the
 * full description). Returns true if the update succeeded.
 */
export async function autoPopulateFindingsSection(
  parentInternalId: string,
  findings: Finding[],
  existingDescription: string | null | undefined,
  authToken: string,
): Promise<boolean> {
  // Format the findings as a markdown section
  const lines: string[] = ["## Findings\n"];
  for (const f of findings) {
    if (f.description) {
      lines.push(`- **${f.title}**: ${f.description}`);
    } else {
      lines.push(`- **${f.title}**`);
    }
  }
  const findingsSection = lines.join("\n");

  // Build the new description
  let newDescription: string;
  const existingDesc = existingDescription ?? "";
  const findingsRegex = /^##\s+Findings[\s\S]*?(?=\n##\s|\n*$)/im;

  if (findingsRegex.test(existingDesc)) {
    // Replace existing ## Findings section
    newDescription = existingDesc.replace(findingsRegex, findingsSection);
  } else if (existingDesc.trim()) {
    // Prepend to existing content
    newDescription = `${findingsSection}\n\n${existingDesc}`;
  } else {
    // Empty description — just the findings section
    newDescription = findingsSection;
  }

  // Import here to avoid circular dependency at module level
  const { issueUpdateDescription } = await import("./linear-helpers.js");
  const ok = await issueUpdateDescription(parentInternalId, newDescription, authToken);
  if (ok) {
    log.info(`autoPopulateFindingsSection: wrote ${findings.length} finding(s) to description of ${parentInternalId}`);
  } else {
    log.warn(`autoPopulateFindingsSection: failed to update description for ${parentInternalId}`);
  }
  return ok;
}

// ── Incremental re-spawn dedup (AI-1994) ────────────────────────────────────

/**
 * AI-1994: pure dedup core for incremental re-spawn.
 * INF-32: scoped by the minting workflow, not the spec-entry id alone.
 *
 * The dev-sprint rework loop re-enters a fan-out state. Without dedup, re-entry
 * would duplicate already-spawned children. This partitions the current spec
 * against the children that already exist:
 *
 *  - `toSpawn` — spec entries with no child minted by THIS workflow. Only these
 *    are minted; a matching child in ANY state (including terminal) suppresses
 *    re-spawn.
 *  - `unmatchedChildren` — this workflow's children whose spec entry is gone from
 *    the current spec. These are NEVER cancelled here — destructive actions stay
 *    human/steward-driven — the caller surfaces them in a note instead.
 *  - `legacyIdOnlyMatches` — children that suppressed a spawn on an id-only
 *    match because their minting workflow could not be resolved (see below).
 *
 * INF-32: `deriveFindingId` is content-addressed (FNV-1a over title+description)
 * and knows nothing about the fan-out that consumed the entry. So two fan-out
 * states on one parent sharing a `spec_source` derive IDENTICAL ids, and an
 * id-only key made the second fan-out read the first's children as its own:
 * `toSpawn` emptied, the engine logged a "legitimate no-op", and zero children
 * spawned into a barrier that vacuously satisfied. The dedup key is therefore
 * `(specEntryId, effective child_workflow)`. "Effective" means
 * `finding.child_workflow ?? childWorkflow` — the per-entry AI-2199 override is
 * what the child is actually labeled with at mint time, so it is what dedup must
 * compare against.
 *
 * Legacy read path (AC1 back-compat): children minted before INF-32 carry no
 * workflow. An unresolvable-workflow child still SUPPRESSES via an id-only match
 * — the conservative choice, since double-minting against a real pre-INF-32
 * parent is worse than a missed spawn — but every such match is reported in
 * `legacyIdOnlyMatches` so the caller can surface it. Suppression is not the
 * defect; silence is. Legacy children are likewise still eligible to be reported
 * unmatched, preserving the AI-1994 orphan note for them.
 *
 * Orphan scoping: only children minted by this fan-out's own workflow (or legacy
 * children of unknown provenance) can be unmatched here. Another workflow's child
 * is not this fan-out's to orphan — reporting it would trade the silent no-op for
 * a spurious note pointing a steward at a ticket doing exactly what it should.
 *
 * Pure and side-effect free: given the same inputs it always returns the same
 * partition, which is what makes re-entry idempotent.
 *
 * @param childWorkflow This fan-out config's `child_workflow` default. Omitted by
 *   pre-INF-32 callers, which degrades to the id-only legacy path throughout.
 */
export function dedupeSpawnSpec(
  findings: Finding[],
  existingChildren: ExistingChild[],
  childWorkflow?: string,
): { toSpawn: Finding[]; unmatchedChildren: ExistingChild[]; legacyIdOnlyMatches: ExistingChild[] } {
  const toSpawn: Finding[] = [];
  const legacyIdOnlyMatches: ExistingChild[] = [];

  for (const f of findings) {
    // AI-2199: the per-entry override is what the child is labeled with at mint
    // time (see the mint loop's `findingWorkflow`), so it is the dedup key.
    const effectiveWorkflow = f.child_workflow ?? childWorkflow;
    const sameEntry = existingChildren.filter((c) => c.specEntryId === f.id);

    const scopedMatch = sameEntry.find(
      (c) => c.childWorkflow !== undefined && c.childWorkflow === effectiveWorkflow,
    );
    if (scopedMatch) continue; // this workflow already minted it

    const legacyMatch = sameEntry.find((c) => c.childWorkflow === undefined);
    if (legacyMatch) {
      // Unknown provenance: suppress conservatively, but never silently.
      legacyIdOnlyMatches.push(legacyMatch);
      continue;
    }

    toSpawn.push(f);
  }

  // Orphan detection, scoped in both directions: a child of ANOTHER workflow is
  // never unmatched here (its spec belongs to a fan-out this one cannot see),
  // while this workflow's own child with a vanished entry still is (AI-1994 AC2).
  const specIds = new Set(findings.map((f) => f.id));
  const unmatchedChildren = existingChildren.filter(
    (c) =>
      !specIds.has(c.specEntryId) &&
      (c.childWorkflow === undefined || c.childWorkflow === childWorkflow),
  );

  return { toSpawn, unmatchedChildren, legacyIdOnlyMatches };
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
  registeredWorkflows?: Set<string>,
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
  if (config.classification_required) {
    const field = config.classification_field?.trim() || "classification";
    const allowed = new Set(config.allowed_classifications ?? []);
    for (const f of findings) {
      const classification = f.classification ?? extractMetadataValue(`${f.title}\n${f.description ?? ""}`, field);
      if (!classification) {
        return {
          ok: false,
          reason: `fan-out spec entry "${f.title}" is unclassified — add '${field}: traces-to-capability' or '${field}: declared-standalone'.`,
        };
      }
      if (allowed.size > 0 && !allowed.has(classification)) {
        return {
          ok: false,
          reason: `fan-out spec entry "${f.title}" has unsupported ${field} '${classification}'. Allowed values: ${[...allowed].join(", ")}.`,
        };
      }
    }
    const standaloneCount = findings.filter((f) => (f.classification ?? "") === "declared-standalone").length;
    const standaloneShare = standaloneCount / findings.length;
    if (
      typeof config.standalone_share_nudge_above === "number" &&
      standaloneShare > config.standalone_share_nudge_above
    ) {
      log.warn(
        `fanout: standalone share ${standaloneCount}/${findings.length} (${standaloneShare.toFixed(2)}) ` +
        `exceeds nudge threshold ${config.standalone_share_nudge_above}; allowing classified spec`,
      );
    }
  }
  // AI-2199: validate per-entry child workflow ids against the registry.
  // When registeredWorkflows is provided, every finding with child_workflow
  // set must reference a registered workflow id. Fail-closed: one unregistered
  // entry refuses the entire transition (no partial spawn).
  if (registeredWorkflows) {
    for (const f of findings) {
      if (f.child_workflow) {
        // Strip the 'wf:' prefix to get the raw def id
        const defId = f.child_workflow.startsWith("wf:") ? f.child_workflow.slice(3) : f.child_workflow;
        if (!registeredWorkflows.has(f.child_workflow) && !registeredWorkflows.has(defId)) {
          return {
            ok: false,
            reason: `fan-out spec entry "${f.title}" references unregistered child workflow '${f.child_workflow}' — no workflow definition found. ` +
              `Register the workflow def or remove the entry and retry.`,
          };
        }
      }
    }

    // INF-41: validate config default child_workflow against the registry.
    // When at least one finding lacks a per-entry [wf:...] marker, the config
    // default applies to that finding — the default must be registered.
    // Marker-less findings have child_workflow undefined; the default is
    // applied at spawn time (finding.child_workflow ?? childWorkflowLabel).
    const hasMarkerLessFindings = findings.some((f) => !f.child_workflow);
    if (hasMarkerLessFindings && config.child_workflow) {
      const defId = config.child_workflow.startsWith("wf:") ? config.child_workflow.slice(3) : config.child_workflow;
      if (!registeredWorkflows.has(config.child_workflow) && !registeredWorkflows.has(defId)) {
        return {
          ok: false,
          reason: `fan-out config default child_workflow '${config.child_workflow}' is not a registered workflow. ` +
            `The config default applies to marker-less spec entries (no [wf:...] per-entry override), but no workflow ` +
            `definition for '${config.child_workflow}' was found. Register the workflow def or ensure all spec entries ` +
            `declare an explicit [wf:...] marker referencing a registered workflow, then retry.`,
        };
      }
    }
  }
  return { ok: true, findings };
}

// ── Spawn-if predicate ─────────────────────────────────────────────────────

/**
 * AI-2523: GraphQL query to fetch a parent issue's children with their
 * identifiers, labels, and native workflow state (type). This lets us
 * determine which children are closed (terminal) and what labels they carry.
 */
const PARENT_CHILDREN_QUERY = `
  query ParentChildrenLabels($id: String!) {
    issue(id: $id) {
      children {
        nodes {
          identifier
          state { name type }
          labels { nodes { id name } }
        }
      }
    }
  }
`;

interface ChildNode {
  identifier: string;
  state: { name: string; type: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
}

interface ParentChildrenResponse {
  data?: {
    issue?: {
      children: {
        nodes: ChildNode[];
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

/**
 * AI-2523: Evaluate a spawn_if predicate for a parent issue.
 *
 * Queries the parent's children (via ParentChildrenLabels), filters to closed
 * children (native state type === "completed"), then checks if any closed child
 * carries the configured label.
 *
 * The result is a SpawnIfResult indicating whether the spawn should proceed,
 * a human-readable reason, and the list of matched child identifiers.
 *
 * On query failure, an error is returned (fail-closed: no spawn), and the
 * caller (executeFanout) is expected to post a failure comment.
 *
 * INF-37: every failure path yields `outcome: "failed"` — distinct from
 * `"waived"`, which requires a *successful* read whose predicate was false.
 * Callers must branch on `outcome`, never on `reason`: "no children spawned"
 * is the same observable for both, so a caller that cannot tell them apart
 * will let a transient API error satisfy a barrier that never ran.
 */
export async function evaluateSpawnIf(
  parentInternalId: string,
  authToken: string,
  spawnIf: SpawnIfConfig,
): Promise<SpawnIfResult> {
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: PARENT_CHILDREN_QUERY, variables: { id: parentInternalId } }),
    });

    // INF-37: a non-2xx is an unreadable response, not an empty child set. A
    // body that happens to parse (or a 5xx HTML error page that doesn't) must
    // never reach the `?? []` waive path below.
    if (!res.ok) {
      return {
        outcome: "failed",
        shouldSpawn: false,
        reason: `spawn_if evaluation failed: children query returned HTTP ${res.status}`,
        matchedChildren: [],
      };
    }

    const data = (await res.json()) as ParentChildrenResponse;

    if (data.errors?.length) {
      const errorMsg = data.errors.map((e) => e.message).join("; ");
      return {
        outcome: "failed",
        shouldSpawn: false,
        reason: `spawn_if evaluation failed: GraphQL error — ${errorMsg}`,
        matchedChildren: [],
      };
    }

    // INF-37: Linear returns 200 + `issue: null` for an unreadable/absent
    // parent. `?? []` used to launder that into "no children" → waive. A
    // missing issue means the predicate has no input, which is a failure.
    const issueNode = data.data?.issue;
    if (!issueNode?.children) {
      return {
        outcome: "failed",
        shouldSpawn: false,
        reason: `spawn_if evaluation failed: children query returned no issue/children payload for the parent`,
        matchedChildren: [],
      };
    }

    const children = issueNode.children.nodes ?? [];
    const targetLabel = spawnIf.label_present;

    // Filter to closed children (native state type === "completed")
    const closedChildren = children.filter((c) => c.state?.type === "completed");

    // Find those carrying the target label
    const matchedChildren = closedChildren
      .filter((c) => c.labels.nodes.some((l) => l.name === targetLabel))
      .map((c) => c.identifier);

    if (matchedChildren.length > 0) {
      return {
        outcome: "fire",
        shouldSpawn: true,
        reason: `spawn_if predicate matched: ${matchedChildren.length} closed child(ren) carry the '${targetLabel}' label (${matchedChildren.join(", ")})`,
        matchedChildren,
      };
    }

    // No match found — determine the right diagnostic. Every branch below is a
    // genuine `waived`: the children query succeeded and the predicate is false.
    if (children.length === 0) {
      return {
        outcome: "waived",
        shouldSpawn: false,
        reason: `spawn_if predicate waived: parent has no children — no '${targetLabel}' label found anywhere`,
        matchedChildren: [],
      };
    }

    const closedCount = closedChildren.length;
    if (closedCount === 0) {
      const openChildren = children.map((c) => c.identifier).join(", ");
      return {
        outcome: "waived",
        shouldSpawn: false,
        reason: `spawn_if predicate waived: no closed children yet (${children.length} open child(ren) — ${openChildren}) — none carry '${targetLabel}'`,
        matchedChildren: [],
      };
    }

    return {
      outcome: "waived",
      shouldSpawn: false,
      reason: `spawn_if predicate waived: ${closedCount} closed child(ren) checked, none carry the '${targetLabel}' label`,
      matchedChildren: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failed",
      shouldSpawn: false,
      reason: `spawn_if evaluation failed: query error — ${msg}`,
      matchedChildren: [],
    };
  }
}

/**
 * Post a spawn_if outcome comment on the parent ticket.
 * Fail-open: errors are logged but don't block the operation.
 */
async function postSpawnIfComment(
  issueInternalId: string,
  spawnIfResult: SpawnIfResult,
  authToken: string,
): Promise<void> {
  const emoji = spawnIfResult.shouldSpawn ? "✅" : "⏭️";
  const body = [
    `${emoji} **spawn_if Evaluation** (label_present: "${spawnIfResult.matchedChildren.length > 0 ? spawnIfResult.reason.match(/'([^']+)'/)?.[1] ?? "—" : "—"}")`,
    ``,  // "ui-impact" not stable — just explain clearly
    `**Outcome:** ${spawnIfResult.shouldSpawn ? "FIRE — spawning children" : "WAIVE — skipping spawn"}`,
    `**Reason:** ${spawnIfResult.reason}`,
    spawnIfResult.matchedChildren.length > 0
      ? `**Matched children:** ${spawnIfResult.matchedChildren.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
    });
    log.info(`fanout: spawn_if comment posted on ${issueInternalId} (${spawnIfResult.shouldSpawn ? "fire" : "waive"})`);
  } catch (err) {
    log.warn(`fanout: failed to post spawn_if comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Post a spawn_if error comment on the parent ticket when the children query fails.
 */
async function postSpawnIfErrorComment(
  issueInternalId: string,
  errorMessage: string,
  authToken: string,
): Promise<void> {
  const body = [
    `❌ **spawn_if Evaluation Error**`,
    ``,  // blank line
    `The spawn_if predicate could not be evaluated because the children query failed.`,
    `**Error:** ${errorMessage}`,
    ``,  // blank line
    // INF-37: this used to claim "the parent ticket transition was refused",
    // which was never true — the transition is applied before fan-out runs, and
    // the barrier then advanced the parent anyway. Describe what actually happens.
    `**No children were spawned.** Because the predicate could not be evaluated, the zero-child result is unverified — it is NOT treated as a waive, and the parent's barrier will not auto-advance on it. The parent is holding at this state pending a steward retry.`,
  ].join("\n");

  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
    });
    log.info(`fanout: spawn_if error comment posted on ${issueInternalId}`);
  } catch (err) {
    log.warn(`fanout: failed to post spawn_if error comment: ${err instanceof Error ? err.message : String(err)}`);
  }
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
 *   3. Resolve entry-state labels per child workflow and create child issues.
 *   4. Create one child issue per finding, each linked to the parent.
 *   5. Return the result with created count and any partial errors.
 *
 * The caller (applyStateTransition) transitions the parent to `managing`
 * after a successful fan-out (or logs a warning on partial failure).
 *
 * AC4 (§5.4): Minting is uniform — children are always created as dev-impl
 * at the child workflow's entry_state, regardless of whether the child itself
 * might be an orchestrator archetype. No special-casing.
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
    /**
     * INF-111: function to resolve the entry state label for a child workflow.
     * Given a wf:* label (e.g. "wf:sprint-arm-scope"), should return the
     * appropriate state label (e.g. "state:doing"). When omitted, children
     * are minted at "state:intake" (legacy default).
     * This fixes the def-skew bug where mint used "state:intake" while the
     * live workflow defs had a different entry_state, causing the proxy to
     * auto-migrate children to escape (terminal).
     */
    lookupEntryState?: (workflowLabel: string) => Promise<string | undefined>;
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
    attempted: 0,
    specMatchedChildren: [],
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
  const findings = (options?.findingsOverride ?? extractSpecFindings(parentCtx.description, config.spec_source))
    .map(withFindingMetadata);
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
  // INF-32: scope the dedup to this fan-out's own workflow — spec-entry ids are
  // content-addressed, so a sibling fan-out sharing this spec_source has children
  // carrying the very ids we are about to mint.
  const { toSpawn, unmatchedChildren, legacyIdOnlyMatches } = dedupeSpawnSpec(
    findings,
    existingChildren,
    childWorkflowLabel,
  );
  result.unmatchedChildren = unmatchedChildren.map((c) => c.identifier);
  result.attempted = toSpawn.length;

  // INF-28: compute the spec-matched set = existing children whose specEntryId
  // matches a current finding. New mints are appended later. This is the set
  // the barrier waits on — not accumulated history (which includes stale siblings).
  const specFindingIds = new Set(findings.map((f) => f.id).filter(Boolean));
  const matchedExisting = existingChildren.filter(
    (c) => specFindingIds.has(c.specEntryId),
  );
  result.specMatchedChildren = matchedExisting.map((c) => c.identifier);

  if (legacyIdOnlyMatches.length > 0) {
    // INF-32 AC1: a workflow-less child suppressed a spawn on an id-only match.
    // Conservative, but never silent — that silence is the bug this fixes.
    log.warn(
      `fanout: ${legacyIdOnlyMatches.length} child(ren) of ${parentIssueId} suppressed a spawn via the ` +
      `pre-INF-32 id-only fallback (no child-workflow marker or wf:* label to scope against ` +
      `'${childWorkflowLabel}'): ${legacyIdOnlyMatches.map((c) => c.identifier).join(", ")}`,
    );
  }

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

  // ── AI-2523: spawn_if predicate evaluation ─────────────────────────
  // Evaluate the spawn_if predicate BEFORE spawn-preview/caps checks but AFTER
  // the dedup (both are independent — dedup partitions the spec, spawn_if
  // queries children by label). When spawn_if is configured and evaluates to
  // shouldSpawn: false, we short-circuit — no children are created.
  if (config.spawn_if) {
    const siResult = await evaluateSpawnIf(parentCtx.internalId, authToken, config.spawn_if);
    result.spawnIfResult = siResult;

    if (!siResult.shouldSpawn) {
      // INF-37: keyed on the `outcome` discriminant. This used to prefix-match
      // the human-readable `reason` string — a silent trap, since reworded prose
      // would reclassify a failure as a waive.
      const isError = siResult.outcome === "failed";

      if (isError) {
        result.errors.push({
          findingIndex: -1,
          message: siResult.reason,
        });
        await postSpawnIfErrorComment(parentCtx.internalId, siResult.reason, authToken);
      } else {
        await postSpawnIfComment(parentCtx.internalId, siResult, authToken);
      }

      log.info(
        `fanout: spawn_if ${isError ? "failed" : "waived"} for ${parentIssueId} — ${siResult.reason}`,
      );
      return result;
    }

    await postSpawnIfComment(parentCtx.internalId, siResult, authToken);

    log.info(
      `fanout: spawn_if fired for ${parentIssueId} — ${siResult.reason}`,
    );
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

  // INF-27 AC2: workflow labels are governed routing contracts. Refuse the
  // whole fan-out before any mint if the target team lacks any referenced wf:*.
  const workflowLabelIds = new Map<string, string>();
  const distinctWorkflowLabels = [...new Set(toSpawn.map((f) => f.child_workflow ?? childWorkflowLabel))];
  if (config.integration_verify?.child_workflow) {
    distinctWorkflowLabels.push(config.integration_verify.child_workflow);
  }
  for (const labelName of distinctWorkflowLabels) {
    const labelId = await findLabel(parentCtx.teamId, labelName, authToken);
    if (labelId) {
      workflowLabelIds.set(labelName, labelId);
    }
  }
  const missingWorkflowLabels = distinctWorkflowLabels.filter((labelName) => !workflowLabelIds.has(labelName));
  if (missingWorkflowLabels.length > 0) {
    result.refused = true;
    for (let i = 0; i < toSpawn.length; i++) {
      const labelName = toSpawn[i].child_workflow ?? childWorkflowLabel;
      if (!missingWorkflowLabels.includes(labelName)) continue;
      const message =
        `Refusing fan-out (INF-27 AC2): workflow label '${labelName}' does not exist in team ${parentCtx.teamId}. ` +
        "Minting there would produce an inert ticket that no workflow engine picks up. " +
        "Create the label in the target team, or mint into a team that defines it.";
      result.errors.push({ findingIndex: i, message });
      log.error(`fanout: ${message}`);
    }
    return result;
  }

  // 3. State labels are resolved per-workflow in the mint loop below.
  //    Cache resolved label ids by state name to avoid redundant API calls
  //    when multiple children share the same workflow entry_state.
  const stateLabelCache = new Map<string, string>();

  // AI-1992: optional initial delegate from config (used as default when
  // per-entry delegate is not set). Resolve once for reuse.
  let configDelegateId: string | null = null;
  if (config.initial_delegate) {
    configDelegateId = await resolveInitialDelegate(config.initial_delegate);
    if (!configDelegateId) {
      log.warn(`fanout: initial_delegate '${config.initial_delegate}' did not resolve to a Linear user — defaulting to undelegated`);
    }
  }

  const createdInternalIds: string[] = [];
  const createdComponents: Array<{ internalId: string; identifier: string; finding: Finding }> = [];

  // AI-1994: only the deduped `toSpawn` set is minted — existing children are
  // left untouched.
  for (let i = 0; i < toSpawn.length; i++) {
    const finding = toSpawn[i];
    const childTitle = finding.title;

    // INF-307 AC1: reject spec-hash marker titles (dangling -->).
    // The Cycle 4 spawner leak materialized internal HTML-comment spec-registry
    // entries as standalone issues with titles like
    // "inf-131:spec-hash:f7d9e2c4 for structured (updated for Cycle 3) -->".
    // The trailing --> proves the minter took a <!-- ... --> spec marker body
    // and wrote it as the issue title. Guard by refusing to mint any child
    // whose title contains a dangling --> (spec-hash marker pattern).
    if (/-->/.test(childTitle)) {
      result.errors.push({
        findingIndex: i,
        message: `Refusing to spawn: title "${childTitle}" contains a spec-hash marker (dangling -->) — spec-registry entries must remain internal HTML-comment markers, not standalone issues`,
      });
      log.warn(`fanout: REFUSED — spec-hash marker title for finding ${i + 1}/${toSpawn.length}: "${childTitle}"`);
      continue;
    }

    // AI-2199: per-entry child workflow override. Falls back to config default.
    const findingWorkflow = finding.child_workflow ?? childWorkflowLabel;
    const wfLabelId = workflowLabelIds.get(findingWorkflow);
    if (!wfLabelId) {
      result.errors.push({
        findingIndex: i,
        message: `Failed to resolve workflow label '${findingWorkflow}' for finding "${childTitle}"`,
      });
      continue;
    }
    // INF-111: resolve entry state label for this child's workflow.
    // If the caller provided lookupEntryState, use it to get the correct
    // state label from the workflow definition. Otherwise fall back to
    // "state:intake" (legacy default). Cache by state name for efficiency.
    const entryStateLabel = options?.lookupEntryState
      ? await options.lookupEntryState(findingWorkflow)
      : undefined;
    // INF-441: default to 'state:todo' (To Do) instead of 'state:intake' (Backlog)
    // for all spawned children to ensure they are dispatched and not silently inert.
    const stateLabelName = entryStateLabel ?? "state:todo";
    let entryStateLabelId: string | undefined | null = stateLabelCache.get(stateLabelName);
    if (!entryStateLabelId) {
      entryStateLabelId = await findOrCreateLabel(parentCtx.teamId, stateLabelName, authToken);
      if (entryStateLabelId) {
        stateLabelCache.set(stateLabelName, entryStateLabelId);
      }
    }
    if (!entryStateLabelId) {
      result.errors.push({
        findingIndex: i,
        message: `Failed to resolve required label ${stateLabelName} for workflow '${findingWorkflow}' in finding "${childTitle}"`,
      });
      continue;
    }
    const labelIds = [wfLabelId, entryStateLabelId];

    // AI-2199: per-entry delegate override. Falls back to config default.
    const delegateId = finding.delegate
      ? await resolveInitialDelegate(finding.delegate)
      : configDelegateId;
    if (finding.delegate && !delegateId) {
      log.warn(`fanout: per-entry delegate '${finding.delegate}' for finding "${childTitle}" did not resolve — spawning undelegated`);
    }

    // Build child description: parent reference + a machine-readable spec-entry
    // marker (AI-1994) so a later re-entry can match this child back to its spec
    // entry and skip re-spawning it. The marker is an HTML comment — invisible
    // in Linear's rendered markdown.
    const childDescription = [
      `Parent: ${parentIssueId}`,
      finding.id ? `${SPEC_ENTRY_MARKER_PREFIX}${finding.id} -->` : "",
      // INF-32: record the minting workflow so a later fan-out sharing this
      // spec_source can tell this child apart from one of its own.
      finding.id ? `${CHILD_WORKFLOW_MARKER_PREFIX}${findingWorkflow} -->` : "",
      finding.description ? `\n${finding.description}` : "",
    ].filter(Boolean).join("\n");

    const child = await createChildIssue(
      parentCtx.teamId,
      childTitle,
      childDescription,
      parentCtx.internalId,
      labelIds,
      authToken,
      delegateId,
    );

    if (child) {
      result.created++;
      result.childIdentifiers.push(child.identifier);
      createdInternalIds.push(child.internalId);
      createdComponents.push({ ...child, finding });
      log.info(`fanout: created child ${child.identifier} — "${childTitle}" (finding ${i + 1}/${toSpawn.length})`);
    } else {
      result.errors.push({
        findingIndex: i,
        message: `Failed to create child for finding: "${childTitle}"`,
      });
      log.warn(`fanout: failed to create child for finding ${i + 1}/${toSpawn.length}: "${childTitle}"`);
    }
  }

  // INF-28: append newly created children to the spec-matched set so the barrier
  // waits on all children that match the current spec — both existing and minted.
  result.specMatchedChildren.push(...result.childIdentifiers);

  if (
    config.integration_verify?.per_capability === true &&
    config.integration_verify.blocked_by === "capability-components" &&
    createdComponents.length > 0
  ) {
    const verifyWorkflow = config.integration_verify.child_workflow;
    const verifyWfLabelId = workflowLabelIds.get(verifyWorkflow);
    if (!verifyWfLabelId) {
      result.errors.push({
        findingIndex: -1,
        message: `Failed to resolve integration verification workflow label '${verifyWorkflow}'`,
      });
    } else {
      const groups = new Map<string, Array<{ internalId: string; identifier: string; finding: Finding }>>();
      for (const component of createdComponents) {
        if (component.finding.classification !== "traces-to-capability") continue;
        const capability = component.finding.capability?.trim();
        if (!capability) continue;
        const existing = groups.get(capability) ?? [];
        existing.push(component);
        groups.set(capability, existing);
      }

      for (const [capability, components] of groups) {
        const entryStateLabel = options?.lookupEntryState
          ? await options.lookupEntryState(verifyWorkflow)
          : undefined;
        const stateLabelName = entryStateLabel ?? "state:intake";
        let entryStateLabelId: string | undefined | null = stateLabelCache.get(stateLabelName);
        if (!entryStateLabelId) {
          entryStateLabelId = await findOrCreateLabel(parentCtx.teamId, stateLabelName, authToken);
          if (entryStateLabelId) {
            stateLabelCache.set(stateLabelName, entryStateLabelId);
          }
        }
        if (!entryStateLabelId) {
          result.errors.push({
            findingIndex: -1,
            message: `Failed to resolve required label ${stateLabelName} for integration verification workflow '${verifyWorkflow}'`,
          });
          continue;
        }

        const verifyDescription = [
          `Parent: ${parentIssueId}`,
          `Capability: ${capability}`,
          "",
          "Blocked by component tickets:",
          ...components.map((c) => `- ${c.identifier}: ${c.finding.title}`),
        ].join("\n");
        const verifyChild = await createChildIssue(
          parentCtx.teamId,
          `Integration verify: ${capability}`,
          verifyDescription,
          parentCtx.internalId,
          [verifyWfLabelId, entryStateLabelId],
          authToken,
          configDelegateId,
        );
        if (!verifyChild) {
          result.errors.push({
            findingIndex: -1,
            message: `Failed to create integration verification child for capability '${capability}'`,
          });
          continue;
        }
        result.created++;
        result.childIdentifiers.push(verifyChild.identifier);
        result.specMatchedChildren.push(verifyChild.identifier);
        for (const component of components) {
          await createBlockingRelation(component.internalId, verifyChild.internalId, authToken);
        }
        log.info(
          `fanout: created integration verification child ${verifyChild.identifier} for capability '${capability}' ` +
          `blocked by ${components.map((c) => c.identifier).join(", ")}`,
        );
      }
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
 * INF-32: each child's minting workflow is resolved so dedup can scope to it —
 * from the `inf-32:child-workflow` marker when present, else from the child's own
 * `wf:*` label (which is why this query asks for labels). Children predating
 * INF-32 have neither and are left `childWorkflow: undefined`, which
 * {@link dedupeSpawnSpec} handles via its reported id-only fallback.
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
        children { nodes { identifier description state { name } labels { nodes { name } } } }
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
            nodes?: Array<{
              identifier: string;
              description?: string | null;
              state?: { name?: string } | null;
              labels?: { nodes?: Array<{ name?: string }> } | null;
            }>;
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
        // INF-32: marker first (authoritative — written at mint time), then the
        // child's live wf:* label. Neither ⇒ a pre-INF-32 child; leave undefined
        // rather than guessing, and let dedupeSpawnSpec report the fallback.
        const wfMarker = CHILD_WORKFLOW_MARKER_RE.exec(n.description ?? "");
        const wfLabel = (n.labels?.nodes ?? [])
          .map((l) => l.name)
          .find((name): name is string => typeof name === "string" && /^wf:.+/.test(name));
        children.push({
          identifier: n.identifier,
          specEntryId: m[1],
          state: n.state?.name,
          childWorkflow: wfMarker ? wfMarker[1] : wfLabel,
        });
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

// ── INF-115: spec auto-derivation from prior-phase children ────────────────

/**
 * INF-115: the description section read from each prior-phase child when
 * deriving. Arm children (wf:sprint-arm-*) carry their approved output in a
 * `## Findings` section by convention — the same content the steward used to
 * hand-transcribe into the sprint parent (engine-watch runs 95/97 on LIF-63).
 */
const DERIVE_CHILD_SPEC_SECTION = "findings";

/** Marker comment written above an auto-derived spec section. */
export const AUTO_DERIVED_SPEC_MARKER = "<!-- inf-115:auto-derived";

/**
 * Match a child's workflow label against an `auto_derive_from` glob.
 * Supports a single trailing `*` (prefix match) or exact equality:
 *   "wf:sprint-arm-*"     matches "wf:sprint-arm-scope", "wf:sprint-arm-ux", …
 *   "wf:sprint-arm-scope" matches only itself.
 */
export function childWorkflowMatchesGlob(workflowLabel: string, glob: string): boolean {
  if (glob.endsWith("*")) {
    return workflowLabel.startsWith(glob.slice(0, -1));
  }
  return workflowLabel === glob;
}

/**
 * INF-115: Derive a fan-out spec from a parent's completed prior-phase children.
 *
 * The steward used to hand-transcribe arm outputs into the sprint parent's
 * spec section at every spawn phase. When the fanout config declares
 * `auto_derive_from` (a glob over prior-phase child wf:* labels), the engine
 * derives the section itself: each matching terminal child contributes its own
 * `## Findings` entries (flattened with an `[<identifier>]` prefix), or — when
 * the child has no structured section — a single entry from the child's title
 * pointing back at the child ticket.
 *
 * Returns null when no matching terminal children exist — the caller leaves
 * the spec section empty and the spawn refuses later exactly as before
 * INF-115 (fail-loud path intact).
 */
export async function deriveSpecFromPriorChildren(
  parentInternalId: string,
  authToken: string,
  opts: { fromChildWorkflow: string; requireTerminal?: boolean },
): Promise<Finding[] | null> {
  const requireTerminal = opts.requireTerminal !== false;
  const query = `
    query Inf115PriorPhaseChildren($id: String!) {
      issue(id: $id) {
        children {
          nodes {
            identifier
            title
            description
            state { name type }
            labels { nodes { name } }
          }
        }
      }
    }
  `;
  type ChildNode = {
    identifier: string;
    title?: string | null;
    description?: string | null;
    state?: { name?: string; type?: string } | null;
    labels?: { nodes?: Array<{ name?: string }> } | null;
  };
  let nodes: ChildNode[] = [];
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: parentInternalId } }),
    });
    const data = (await res.json()) as {
      data?: { issue?: { children?: { nodes?: ChildNode[] } | null } | null };
    };
    nodes = data.data?.issue?.children?.nodes ?? [];
  } catch (err) {
    log.warn(
      `fanout: INF-115: failed to fetch prior-phase children for ${parentInternalId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const findings: Finding[] = [];
  for (const child of nodes) {
    const wfLabel = (child.labels?.nodes ?? [])
      .map((l) => l.name)
      .find((name): name is string => typeof name === "string" && /^wf:.+/.test(name));
    if (!wfLabel || !childWorkflowMatchesGlob(wfLabel, opts.fromChildWorkflow)) continue;
    // "completed" is Linear's terminal state type (Done). Canceled/invalid
    // children carry no approved output and are excluded with it.
    if (requireTerminal && child.state?.type !== "completed") continue;

    // Prefer the child's own structured output section; fall back to its title.
    const childFindings = extractSpecFindings(child.description, DERIVE_CHILD_SPEC_SECTION);
    if (childFindings.length > 0) {
      for (const f of childFindings) {
        findings.push({
          title: `[${child.identifier}] ${f.title}`,
          description: f.description,
        });
      }
    } else {
      const title = (child.title ?? child.identifier).trim();
      findings.push({
        title: `[${child.identifier}] ${title}`,
        description: `Approved output lives on ${child.identifier} (no structured findings section — see the child ticket).`,
      });
    }
  }

  if (findings.length === 0) return null;
  log.info(
    `fanout: INF-115: derived ${findings.length} spec entr${findings.length === 1 ? "y" : "ies"} ` +
    `from prior-phase children of ${parentInternalId} (glob '${opts.fromChildWorkflow}')`,
  );
  return findings;
}

/**
 * INF-115: Render derived findings as a spec section and append it to the
 * parent description. Returns the new description, or null when the section
 * already exists with parseable entries — human-authored content always wins;
 * derivation never overwrites.
 */
export function upsertDerivedSpecSection(
  description: string | null | undefined,
  specSource: string,
  findings: Finding[],
): string | null {
  if (findings.length === 0) return null;
  if (extractSpecFindings(description, specSource).length > 0) return null;

  const heading = `## ${specSource.charAt(0).toUpperCase()}${specSource.slice(1)}`;
  const lines = findings.map((f) => {
    // Strip asterisks from titles so they can't break the "**Title**" parse.
    const title = f.title.replace(/\*+/g, "").trim();
    return f.description ? `- **${title}**: ${f.description}` : `- **${title}**`;
  });
  const section =
    `${heading}\n\n` +
    `${AUTO_DERIVED_SPEC_MARKER} — derived from completed prior-phase children; review/edit before spawning -->\n\n` +
    lines.join("\n") +
    "\n";

  const base = (description ?? "").trimEnd();
  return base ? `${base}\n\n${section}` : section;
}

/**
 * INF-115: persist an updated description on an issue. Returns true on success.
 * Fail-open: a failed write just means the steward authors the section by hand
 * (the pre-INF-115 path).
 */
export async function updateIssueDescription(
  internalIssueId: string,
  description: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation Inf115UpdateDescription($issueId: String!, $description: String!) {
      issueUpdate(id: $issueId, input: { description: $description }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalIssueId, description } }),
    });
    const data = (await res.json()) as { data?: { issueUpdate?: { success?: boolean } } };
    return data.data?.issueUpdate?.success === true;
  } catch (err) {
    log.warn(
      `fanout: INF-115: failed to update description on ${internalIssueId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
