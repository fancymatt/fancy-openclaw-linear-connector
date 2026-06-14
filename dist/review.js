/**
 * Phase 5 / B-4 — Disposition review + parent-AC gate (F2b, §5.6).
 *
 * When the managing barrier fires and all children reach terminal state, the
 * parent transitions managing → review (done in B-3). This module handles
 * the **disposition** from review:
 *
 *   1. `→ done` (terminal) — gated on the **parent's own** AC being satisfied.
 *      The parent scope is NOT the sum of its children (the F2b fix, §5.6).
 *      The researcher must confirm that the parent issue's acceptance criteria
 *      are met independently of child completion.
 *
 *   2. `→ spawning` (follow-ups for gaps) — when the researcher identifies
 *      gaps that need additional children. Re-enters the spawning state to
 *      mint supplementary dev-impl tickets.
 *
 *   3. `→ escape` (break-glass) — always available per §4.4.
 *
 * Design: design.md §5.6, §14, §11 Phase 5 milestone.
 *
 * ACs:
 *   - managing barrier exits to review (disposition), not done. (B-3 — verified here)
 *   - From review the researcher dispositions: → done | → spawning | → escape.
 *   - → done is gated on the parent's own AC — not the sum of children (§5.6).
 */
import { componentLogger, createLogger } from "./logger.js";
import { fetchChildren } from "./barrier.js";
import { LINEAR_API_URL, findOrCreateLabel, postComment, resolveInternalId, issueUpdateLabels, fetchIssueWithLabels, } from "./linear-helpers.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "review");
// ── AC Checklist Parsing ──────────────────────────────────────────────────
/**
 * Parse acceptance criteria from the issue description.
 *
 * Looks for Markdown checkboxes in the description:
 *   - [x] AC item text
 *   - [ ] Unchecked item
 *
 * Also supports "## Acceptance criteria" section with list items:
 *   ## Acceptance criteria
 *   - [x] First criterion
 *   - [ ] Second criterion
 *
 * Returns the list of parsed items, or an empty array if none found.
 */
export function parseAcChecklist(description) {
    if (!description)
        return [];
    const items = [];
    // Match Markdown checkboxes: - [x] or - [ ] (case-insensitive for x)
    const checkboxRegex = /[-*]\s*\[([ xX])\]\s*(.+)/g;
    let match;
    while ((match = checkboxRegex.exec(description)) !== null) {
        const checked = match[1].toLowerCase() === "x";
        const text = match[2].trim();
        if (text) {
            items.push({ text, checked });
        }
    }
    return items;
}
/**
 * Evaluate whether all acceptance criteria items in the checklist are checked.
 *
 * Returns { satisfied: true } only when:
 *   - At least one checklist item exists AND
 *   - Every item is checked.
 *
 * Returns { satisfied: false } when any item is unchecked or no items found.
 * The F2b fix (§5.6): this checks the **parent's own** AC, not the sum of
 * children. Even if all children are done, the parent's own AC might not be
 * satisfied (e.g., the parent's scope includes cross-cutting concerns that
 * no single child covers).
 */
export function evaluateAcGate(items) {
    if (items.length === 0) {
        return {
            satisfied: false,
            reason: "No acceptance criteria checkboxes found in the parent issue description. Add ACs as Markdown checkboxes (- [x] / - [ ]) and retry.",
        };
    }
    const unchecked = items.filter((item) => !item.checked);
    if (unchecked.length > 0) {
        const uncheckedList = unchecked.map((item) => `  - [ ] ${item.text}`).join("\n");
        return {
            satisfied: false,
            reason: `${unchecked.length} of ${items.length} AC item(s) unchecked:\n${uncheckedList}`,
        };
    }
    return {
        satisfied: true,
        reason: `All ${items.length} AC item(s) satisfied.`,
    };
}
// ── Linear API: description fetch (review-specific) ───────────────────────
/**
 * Fetch the parent issue's description for AC parsing.
 *
 * Intentional fail-closed: on fetch error (network, auth, malformed response)
 * this returns null, which downstream yields an empty AC list → gate fails →
 * transition blocked. This is the correct security posture — we never
 * accidentally pass the AC gate due to a transient API failure.
 * Maintainers: do NOT change this to throw or return a default-pass result.
 */
async function fetchIssueDescription(identifier, authToken) {
    const query = `
    query IssueDescription($id: String!) {
      issue(id: $id) {
        description
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
        return data.data?.issue?.description ?? null;
    }
    catch (err) {
        log.error(`review: failed to fetch description for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
// ── Public API ────────────────────────────────────────────────────────────
/**
 * Evaluate the parent-AC gate for a ticket in `review` state.
 *
 * The F2b fix (§5.6): the parent's → done transition is gated on the **parent's
 * own** AC, not the sum of its children. This function fetches the parent's
 * description, parses the AC checklist, and verifies all items are checked.
 *
 * AC3: → done is gated on the parent's own AC being satisfied.
 */
export async function evaluateParentAcGate(parentIdentifier, authToken) {
    const description = await fetchIssueDescription(parentIdentifier, authToken);
    const items = parseAcChecklist(description);
    const { satisfied, reason } = evaluateAcGate(items);
    log.info(`review: parent-AC gate for ${parentIdentifier}: ${satisfied ? "PASSED" : "FAILED"} — ${reason}`);
    return {
        satisfied,
        parentIdentifier,
        reason,
        checklist: items.length > 0 ? items : undefined,
    };
}
/**
 * Attempt the `review → done` disposition.
 *
 * AC3: The → done transition is gated on the parent's own AC being satisfied.
 * If the AC gate fails, the transition is blocked and a diagnostic comment
 * is posted on the issue explaining which ACs are unmet.
 *
 * If the AC gate passes:
 *   1. Atomically swap state:review → state:done.
 *   2. Post a disposition summary comment.
 *
 * Returns the result of the disposition attempt.
 */
export async function dispositionToDone(parentIdentifier, authToken) {
    const result = {
        applied: false,
        targetState: "done",
        parentIdentifier,
    };
    // 1. Evaluate the parent-AC gate (§5.6 F2b)
    const acGate = await evaluateParentAcGate(parentIdentifier, authToken);
    if (!acGate.satisfied) {
        result.error = `Parent-AC gate failed: ${acGate.reason}`;
        log.info(`review: → done blocked for ${parentIdentifier}: AC gate not satisfied`);
        // Post diagnostic comment
        const internalId = await resolveInternalId(parentIdentifier, authToken);
        if (internalId) {
            await postComment(internalId, `[Disposition Gate] Cannot advance to **done** — parent AC not satisfied.\n\n${acGate.reason}\n\nResolve the unchecked items and retry \`approve\`.`, authToken);
        }
        return result;
    }
    // 2. Fetch children for the summary comment.
    //
    //    This API round-trip is intentional: the disposition-to-done comment
    //    must include the final child rollup (identifiers + states) so the
    //    researcher and any observers can verify the terminal state that
    //    triggered the barrier. The fetch is cheap (one GraphQL query) and
    //    provides essential audit context in the posted comment. Skipping it
    //    would leave a blind disposition comment with no child evidence.
    const children = await fetchChildren(parentIdentifier, authToken);
    // 3. Atomically swap state:review → state:done
    const issue = await fetchIssueWithLabels(parentIdentifier, authToken);
    if (!issue) {
        result.error = "Failed to fetch issue labels";
        return result;
    }
    const reviewLabel = issue.labels.find((l) => l.name === "state:review");
    if (!reviewLabel) {
        result.error = "No state:review label found on issue";
        return result;
    }
    const doneLabelId = await findOrCreateLabel(issue.teamId, "state:done", authToken);
    if (!doneLabelId) {
        result.error = "Failed to resolve state:done label";
        return result;
    }
    const newLabelIds = [
        ...issue.labels.filter((l) => l.id !== reviewLabel.id).map((l) => l.id),
        doneLabelId,
    ];
    const updated = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
    if (!updated) {
        result.error = "Label swap mutation returned non-success";
        return result;
    }
    // 4. Post disposition summary comment
    const childSummary = children.length > 0
        ? children.map((c) => `- ${c.identifier}: ${c.workflowState ?? "unknown"}`).join("\n")
        : "No children";
    const commentBody = `[Disposition] Parent AC satisfied — advancing review → done.\n\n` +
        `**AC gate:** ${acGate.reason}\n\n` +
        `**Children:**\n${childSummary}`;
    await postComment(issue.internalId, commentBody, authToken);
    result.applied = true;
    log.info(`review: ${parentIdentifier} review → done (parent AC satisfied)`);
    return result;
}
/**
 * Attempt the `review → spawning` disposition for follow-up gaps.
 *
 * AC2: From review, the researcher can disposition → spawning to create
 * follow-up children for gaps found during review. Re-enters the spawning
 * state so the fan-out engine can mint supplementary dev-impl tickets.
 *
 * Steps:
 *   1. Atomically swap state:review → state:spawning.
 *   2. Post a disposition comment noting the follow-up.
 *
 * The fan-out engine will trigger on the spawning transition as before.
 */
export async function dispositionToSpawning(parentIdentifier, authToken) {
    const result = {
        applied: false,
        targetState: "spawning",
        parentIdentifier,
    };
    const issue = await fetchIssueWithLabels(parentIdentifier, authToken);
    if (!issue) {
        result.error = "Failed to fetch issue labels";
        return result;
    }
    const reviewLabel = issue.labels.find((l) => l.name === "state:review");
    if (!reviewLabel) {
        result.error = "No state:review label found on issue";
        return result;
    }
    const spawningLabelId = await findOrCreateLabel(issue.teamId, "state:spawning", authToken);
    if (!spawningLabelId) {
        result.error = "Failed to resolve state:spawning label";
        return result;
    }
    const newLabelIds = [
        ...issue.labels.filter((l) => l.id !== reviewLabel.id).map((l) => l.id),
        spawningLabelId,
    ];
    const updated = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
    if (!updated) {
        result.error = "Label swap mutation returned non-success";
        return result;
    }
    // Post disposition comment
    await postComment(issue.internalId, `[Disposition] Researcher identified gaps — routing review → spawning for follow-up children.`, authToken);
    result.applied = true;
    log.info(`review: ${parentIdentifier} review → spawning (follow-up gaps)`);
    return result;
}
/**
 * Determine if the disposition should trigger for a given workflow + state + command.
 *
 * Returns the target disposition state ("done" | "spawning") when the command
 * maps to a known disposition, or null if:
 *   - The workflow is not ux-audit
 *   - The current state is not review
 *   - The intent is "escape" (falls through to the standard atomic swap path)
 *   - The intent is unrecognized
 *
 * Callers that receive null should delegate to the standard atomic label swap
 * logic — the disposition engine does not handle those paths.
 */
export function resolveDisposition(workflowId, currentState, intent) {
    if (workflowId !== "ux-audit")
        return null;
    if (currentState !== "review")
        return null;
    if (intent === "approve")
        return "done";
    if (intent === "request-rework")
        return "spawning";
    return null;
}
//# sourceMappingURL=review.js.map