/**
 * POST /proxy/set-state — steward/human-only atomic state rewind (AI-1546, G-6).
 *
 * Atomically sets label + native Linear state + delegate in a single mutation.
 * Operates from any source state, including terminals (done, escape).
 * Gate: caller must hold human:escalate capability (steward/human only).
 */

import type { Request, Response } from "express";
import { componentLogger, createLogger } from "./logger.js";
import { bodyHasCapability } from "./escalation-gate.js";
import { getAgent, getAgentByProxyToken } from "./agents.js";
import {
  loadWorkflowRegistry,
  getWorkflowId,
  resolveNativeStateId,
  fetchIssueWithLabels,
  findOrCreateLabel,
  issueUpdateAtomic,
} from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "set-state");

function stripBearer(auth: string): string {
  return auth.replace(/^Bearer\s+/i, "").trim();
}

export async function handleSetStateRequest(req: Request, res: Response): Promise<void> {
  const rawAuthorization = req.headers["authorization"];
  if (!rawAuthorization) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const authHeader = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;

  const brokerAgent = getAgentByProxyToken(stripBearer(authHeader));
  const authorization = brokerAgent ? brokerAgent.accessToken : authHeader;
  const bodyId = brokerAgent
    ? brokerAgent.name
    : ((req.headers["x-openclaw-agent"] as string | undefined) ?? "unknown");

  // Parse and validate body fields (req.body may be a Buffer from express.raw middleware).
  let body: Record<string, unknown>;
  if (Buffer.isBuffer(req.body)) {
    try {
      body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
    } catch {
      body = {};
    }
  } else if (typeof req.body === "object" && req.body !== null) {
    body = req.body as Record<string, unknown>;
  } else {
    body = {};
  }

  const issueId = typeof body.issueId === "string" && body.issueId ? body.issueId : null;
  const targetState = typeof body.targetState === "string" && body.targetState ? body.targetState : null;
  const delegateName = typeof body.delegate === "string" && body.delegate ? body.delegate : null;

  if (!issueId || !targetState || !delegateName) {
    res.status(400).json({ error: "Missing required fields: issueId, targetState, delegate" });
    return;
  }

  // AC2: unconditional steward-only gate (human:escalate required regardless of ticket type).
  const hasEscalate = await bodyHasCapability(bodyId, "human:escalate");
  if (!hasEscalate) {
    res.status(403).json({ error: `set-state requires 'human:escalate' capability (steward/human only)` });
    return;
  }

  // Resolve delegate to a known agent with a Linear user ID.
  const delegateAgent = getAgent(delegateName);
  if (!delegateAgent?.linearUserId) {
    res.status(422).json({ error: `Unknown delegate agent: '${delegateName}'` });
    return;
  }
  const delegateLinearUserId = delegateAgent.linearUserId;

  // Fetch issue to get internalId, teamId, and current labels.
  // AC4-c: fail with 502 immediately if the issue fetch fails — no mutation attempted.
  let issue: { internalId: string; teamId: string; labels: Array<{ id: string; name: string }> };
  try {
    const fetched = await fetchIssueWithLabels(issueId, authorization);
    if (!fetched) {
      log.warn(`set-state: issue fetch returned null for ${issueId}`);
      res.status(502).json({ error: "Failed to fetch issue from Linear" });
      return;
    }
    issue = fetched;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`set-state: issue fetch threw for ${issueId}: ${msg}`);
    res.status(502).json({ error: `Issue fetch failed: ${msg}` });
    return;
  }

  // AC3-d: must be a workflow ticket (wf:* label required to know which state labels to use).
  const labelNames = issue.labels.map((l) => l.name);
  const workflowId = getWorkflowId(labelNames);
  if (!workflowId) {
    res.status(422).json({ error: "set-state requires a workflow ticket (wf:* label missing)" });
    return;
  }

  // Resolve workflow definition to find the target state's native_state.
  const registry = await loadWorkflowRegistry();
  const def = registry.get(workflowId);
  if (!def) {
    res.status(422).json({ error: `No workflow definition registered for '${workflowId}'` });
    return;
  }

  const targetStateDef = def.states.find((s) => s.id === targetState);
  if (!targetStateDef) {
    res.status(422).json({ error: `Unknown target state '${targetState}' in workflow '${workflowId}'` });
    return;
  }

  // Resolve semantic native_state → Linear workflow state UUID.
  let nativeStateId: string | null = null;
  if (targetStateDef.native_state) {
    nativeStateId = await resolveNativeStateId(issue.teamId, targetStateDef.native_state, authorization);
  }

  // Build new label set: drop the old state:* label, add state:<targetState>.
  const oldStateLabel = issue.labels.find((l) => /^state:/i.test(l.name));
  const keepLabelIds = issue.labels
    .filter((l) => l !== oldStateLabel)
    .map((l) => l.id);

  const newStateLabelName = `state:${targetState}`;
  const newStateLabelId = await findOrCreateLabel(issue.teamId, newStateLabelName, authorization);
  if (!newStateLabelId) {
    res.status(502).json({ error: `Failed to find/create label '${newStateLabelName}'` });
    return;
  }

  const newLabelIds = [...keepLabelIds, newStateLabelId];

  // AC1/AC4: single atomic mutation — labels + stateId + delegateId together or not at all.
  const success = await issueUpdateAtomic(
    issue.internalId,
    newLabelIds,
    authorization,
    delegateLinearUserId,
    nativeStateId,
  );

  if (!success) {
    log.warn(`set-state: atomic mutation failed for ${issueId} → ${targetState}`);
    res.status(502).json({ error: "Atomic state transition failed (Linear API returned failure)" });
    return;
  }

  log.info(`set-state: ${issueId} → ${targetState} delegate=${delegateName}`);
  res.status(200).json({ targetState, delegate: delegateName });
}
