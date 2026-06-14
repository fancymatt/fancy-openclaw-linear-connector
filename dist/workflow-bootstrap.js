/**
 * AI-1565: Pre-routing workflow bootstrap hook.
 *
 * When a wf:* label is added to a ticket with no state:* label, applies the
 * entry state from the workflow def and sets the first-owner delegate — no
 * human/agent action required.
 *
 * Reverse (demote): when wf:* is removed and state:* labels remain, cleans
 * them up so the ticket reverts to ad-hoc.
 *
 * This hook runs before the delegate-based router so a label-only change
 * (no delegate, no assignee, no mention) can bootstrap the ticket.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "./logger.js";
import { loadWorkflowRegistry } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
import { findOrCreateLabel } from "./linear-helpers.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-bootstrap");
const LINEAR_API_URL = "https://api.linear.app/graphql";
// ── Agents loader ─────────────────────────────────────────────────────────────
async function loadAgents() {
    const filePath = process.env.AGENTS_PATH ?? path.resolve(process.cwd(), "agents.json");
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(raw);
        return data.agents ?? [];
    }
    catch {
        return [];
    }
}
async function fetchIssueContext(issueId, authToken) {
    const query = `
    query IssueWithLabels($id: String!) {
      issue(id: $id) {
        id
        team { id }
        labels { nodes { id name } }
        delegate { id }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: issueId } }),
        });
        const data = (await res.json());
        const issue = data.data?.issue;
        if (!issue)
            return null;
        return {
            id: issue.id,
            teamId: issue.team.id,
            labels: issue.labels.nodes,
        };
    }
    catch {
        return null;
    }
}
async function issueUpdateAtomic(internalId, labelIds, authToken, delegateId) {
    const hasDelegate = delegateId !== undefined;
    const inputParts = ["labelIds: $labelIds"];
    if (hasDelegate)
        inputParts.push("delegateId: $delegateId");
    const mutation = `
    mutation ApplyAtomicTransition($issueId: String!, $labelIds: [String!]!${hasDelegate ? ", $delegateId: String" : ""}) {
      issueUpdate(id: $issueId, input: { ${inputParts.join(", ")} }) {
        success
      }
    }
  `;
    const variables = { issueId: internalId, labelIds };
    if (hasDelegate)
        variables.delegateId = delegateId;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: mutation, variables }),
        });
        const data = (await res.json());
        return data.data?.issueUpdate?.success ?? false;
    }
    catch {
        return false;
    }
}
// ── Main hook ─────────────────────────────────────────────────────────────────
/**
 * Pre-routing bootstrap hook — runs before the delegate-based router.
 *
 * Returns a BootstrapResult if the bootstrap or demote path fired, null otherwise.
 * Never throws: all errors are caught and logged, failing safe.
 */
export async function maybeBootstrapWorkflow(event, authToken) {
    if (event.type !== "Issue" || event.action !== "update")
        return null;
    const issueEvent = event;
    const currentLabelIds = issueEvent.data.labelIds ?? [];
    const updatedFrom = issueEvent.updatedFrom;
    const previousLabelIds = updatedFrom?.labelIds ?? [];
    const currentSet = new Set(currentLabelIds);
    const previousSet = new Set(previousLabelIds);
    const addedIds = currentLabelIds.filter((id) => !previousSet.has(id));
    const removedIds = previousLabelIds.filter((id) => !currentSet.has(id));
    if (addedIds.length === 0 && removedIds.length === 0)
        return null;
    // Fetch current label names — needed to distinguish wf:* from state:* by ID.
    let issue = null;
    try {
        issue = await fetchIssueContext(issueEvent.data.id, authToken);
    }
    catch {
        return null;
    }
    if (!issue)
        return null;
    const currentWfLabelNode = issue.labels.find((n) => n.name.startsWith("wf:"));
    const currentStateLabels = issue.labels.filter((n) => n.name.startsWith("state:"));
    // ── Bootstrap path: a wf:* label was newly added ──────────────────────────
    if (addedIds.length > 0 && currentWfLabelNode && addedIds.includes(currentWfLabelNode.id)) {
        // Idempotency: if state:* is already present, this ticket is already in-flight.
        if (currentStateLabels.length > 0)
            return null;
        const workflowId = currentWfLabelNode.name.slice("wf:".length);
        let registry;
        try {
            registry = await loadWorkflowRegistry();
        }
        catch (err) {
            log.warn(`workflow-bootstrap: failed to load registry for '${workflowId}': ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
        const def = registry.get(workflowId);
        if (!def?.entry_state) {
            log.warn(`workflow-bootstrap: no def (or no entry_state) for workflow '${workflowId}' — skipping bootstrap`);
            return null;
        }
        const entryState = def.entry_state;
        const entryStateDef = def.states.find((s) => s.id === entryState);
        const ownerRole = entryStateDef?.owner_role;
        // Resolve first-owner delegate from capability policy.
        let delegateLinearUserId;
        if (ownerRole) {
            try {
                const bodies = await resolveBodiesForRole(ownerRole);
                if (bodies.length === 1) {
                    const agents = await loadAgents();
                    const agent = agents.find((a) => a.name === bodies[0]);
                    if (agent?.linearUserId) {
                        delegateLinearUserId = agent.linearUserId;
                    }
                    else {
                        log.warn(`workflow-bootstrap: body '${bodies[0]}' has no linearUserId — delegate not set`);
                    }
                }
            }
            catch (err) {
                log.warn(`workflow-bootstrap: role resolution failed for '${ownerRole}': ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // Find or create the entry state label.
        const stateLabelId = await findOrCreateLabel(issue.teamId, `state:${entryState}`, authToken);
        if (!stateLabelId) {
            log.warn(`workflow-bootstrap: could not resolve label 'state:${entryState}' — aborting bootstrap`);
            return null;
        }
        const newLabelIds = Array.from(new Set([...currentLabelIds, stateLabelId]));
        const success = await issueUpdateAtomic(issue.id, newLabelIds, authToken, delegateLinearUserId);
        if (!success) {
            log.warn(`workflow-bootstrap: issueUpdate returned non-success for ${issueEvent.data.id}`);
        }
        else {
            log.info(`workflow-bootstrap: bootstrapped ${issueEvent.data.id} → ${workflowId}:${entryState}, delegate=${delegateLinearUserId ?? "none"}`);
        }
        return { action: "bootstrapped", workflowId, entryState };
    }
    // ── Demote path: wf:* was removed, state:* labels remain ─────────────────
    if (removedIds.length > 0 && !currentWfLabelNode && currentStateLabels.length > 0) {
        const stateLabelIds = new Set(currentStateLabels.map((n) => n.id));
        const newLabelIds = currentLabelIds.filter((id) => !stateLabelIds.has(id));
        await issueUpdateAtomic(issue.id, newLabelIds, authToken);
        log.info(`workflow-bootstrap: demoted ${issueEvent.data.id} — removed [${currentStateLabels.map((n) => n.name).join(", ")}]`);
        return { action: "demoted" };
    }
    return null;
}
//# sourceMappingURL=workflow-bootstrap.js.map