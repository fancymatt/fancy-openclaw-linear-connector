import crypto from "crypto";
import { Router, Request, Response } from "express";
import { verifyLinearSignatureMulti, parseWebhookSecrets } from "./signature.js";
import { normalizeLinearEvent } from "./normalize.js";
import type { LinearEvent } from "./schema.js";
import { EventStore } from "../store/event-store.js";
import { NudgeStore } from "../store/nudge-store.js";
import type { OperationalEventInput, OperationalEventStore } from "../store/operational-event-store.js";
import { routeEvent, routeEventAll, unresolvedRoutingCandidates } from "../router.js";
import { createSessionAndEmitThought, emitResponse } from "../agent-session.js";
import { deliverToAgent, DeliveryThrottle, type DeliveryConfig } from "../delivery/index.js";
import type { RouteResult } from "../types.js";
import { normalizeSessionKey } from "../session-key.js";
import { buildAgentMap, getAgent, getAccessToken, getOpenclawAgentName, getAgents } from "../agents.js";
import { checkAgentLiveness, type LivenessConfig } from "../liveness.js";
import { emitDelegateUnavailable } from "../escalation.js";
import { checkRoleGuardAndBlock, type LinearUserIdResolver } from "../routing-guard.js";
import { fetchWorkflowLabels, enrollIfMissing } from "../workflow-gate.js";
import { AgentQueue } from "../queue/index.js";
import { PendingWorkBag, SessionTracker, resignalPendingTickets } from "../bag/index.js";
import { type WakeUpConfig } from "../bag/wake-up.js";
import { createLogger, componentLogger } from "../logger.js";
import { isLinearIssueStillRoutedToAgent, isTerminalIssueEvent, issueIdentifierFromEvent } from "../linear-actionable.js";
import { onChildTerminal } from "../barrier.js";
import { maybeBootstrapWorkflow } from "../workflow-bootstrap.js";
import { notify } from "../alerts/alert-bus.js";

const log = componentLogger(createLogger(), "webhook");

export type { LinearEvent } from "./schema.js";
export { verifyLinearSignature } from "./signature.js";
export { normalizeLinearEvent } from "./normalize.js";

/**
 * Creates the Express router for the Linear webhook endpoint.
 *
 * The router expects that the parent Express app has been configured to
 * preserve the raw body buffer on `req.rawBody` via `express.raw()` for this
 * route — signature validation requires the exact bytes as received.
 *
 * Environment variables consumed:
 *   LINEAR_WEBHOOK_SECRETS — comma-separated list of HMAC secrets (new, supports private teams)
 *   LINEAR_WEBHOOK_SECRET  — single HMAC secret (legacy, backward compatible)
 */
const NUDGE_DEDUP_WINDOW_MS = parseInt(process.env.NUDGE_DEDUP_WINDOW_MS ?? "120000", 10);

function errorSummary(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendOperationalEvent(store: OperationalEventStore | undefined, input: OperationalEventInput): void {
  if (!store) return;
  try { store.append(input); } catch (err) { log.error(`Operational event write failed: ${errorSummary(err)}`); }
}

/**
 * Rebuild WS1 (2026-07-03, pilot finding): Comment webhooks carry no delegate,
 * so "a comment wakes the ticket's delegate" NEVER worked — every plain
 * comment no-routed (verified live: AI-1755/AI-1756). Before routing, fetch
 * the issue's delegate/assignee and graft them onto event.data so the
 * standard sync router path (delegate → assignee → mention) applies.
 * Fail-open: on any error the event routes as before (mentions still work).
 */
export async function enrichCommentEventForRouting(event: LinearEvent): Promise<void> {
  if (event.type !== "Comment") return;
  const data = (event as { data?: Record<string, unknown> }).data;
  if (!data || data.delegate || data.assignee) return;
  const issueId = (data.issueId as string) || ((data.issue as Record<string, unknown> | undefined)?.id as string);
  if (!issueId) return;
  const token = (() => {
    for (const a of getAgents()) {
      const t = getAccessToken(a.name);
      if (t) return t;
    }
    return undefined;
  })();
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: token.startsWith("Bearer") ? token : `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        query: `query CommentRouting($id: String!) { issue(id: $id) { delegate { id } assignee { id } } }`,
        variables: { id: issueId },
      }),
    });
    const json = (await res.json()) as { data?: { issue?: { delegate?: { id: string } | null; assignee?: { id: string } | null } } };
    const issue = json.data?.issue;
    if (issue?.delegate?.id) data.delegate = { id: issue.delegate.id };
    if (issue?.assignee?.id) data.assignee = { id: issue.assignee.id };
    if (issue?.delegate?.id || issue?.assignee?.id) {
      log.info(`Comment routing enrichment: issue ${issueId} delegate=${issue?.delegate?.id ?? "none"} assignee=${issue?.assignee?.id ?? "none"}`);
    }
  } catch (err) {
    log.warn(`Comment routing enrichment failed (fail-open): ${errorSummary(err)}`);
  }
}

function acknowledgeAgentAuthoredActivity(
  event: LinearEvent,
  onAgentActivity?: (agentId: string, ticketId: string) => void,
): void {
  if (!onAgentActivity) return;
  // Only genuine human-visible authored content (comments, agent session events)
  // triggers the Doing-flip. Issue state/label updates are connector facet writes
  // that must not echo back as activity signals (AI-1564).
  if (event.type !== "Comment" && event.type !== "AgentSessionEvent") return;
  const actorId = event.actor?.id;
  if (!actorId) return;

  const agentName = buildAgentMap()[actorId];
  if (!agentName) return;

  const identifier = issueIdentifierFromEvent(event);
  if (!identifier) return;

  const agentId = getOpenclawAgentName(agentName);
  const ticketId = normalizeSessionKey(identifier);
  onAgentActivity(agentId, ticketId);
  log.info(`Agent-authored Linear activity acknowledged: ${agentId} [${ticketId}]`);
}

/** Wrap deliverToAgent with the global concurrent-dispatch semaphore. */
async function deliverWithSlot(
  route: RouteResult,
  config: DeliveryConfig,
  throttle?: DeliveryThrottle,
): Promise<Awaited<ReturnType<typeof deliverToAgent>>> {
  if (throttle) await throttle.acquireSlot();
  try {
    return await deliverToAgent(route, config);
  } finally {
    if (throttle) throttle.releaseSlot();
  }
}

export function createWebhookRouter(
  eventStore?: EventStore,
  nudgeStore?: NudgeStore,
  agentQueue?: AgentQueue,
  bag?: PendingWorkBag,
  sessionTracker?: SessionTracker,
  throttle?: DeliveryThrottle,
  operationalEventStore?: OperationalEventStore,
  onDispatched?: (agentId: string, ticketId: string) => void,
  onAgentActivity?: (agentId: string, ticketId: string) => void,
  onDeliveryCommitted?: (agentId: string, ticketId: string) => void,
): Router {
  const router = Router();

  if (NUDGE_DEDUP_WINDOW_MS > 0) {
    log.info(`Nudge dedup enabled: ${NUDGE_DEDUP_WINDOW_MS}ms window`);
  }

  router.get("/", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
  });

  router.post(
    "/",
    async (req: Request, res: Response): Promise<void> => {
      const secrets = parseWebhookSecrets();

      // ── 1. Debug: log relevant headers ──────────────────────────────────
      log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);
      log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
      log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);
      appendOperationalEvent(operationalEventStore, { outcome: "received", type: typeof req.headers["linear-event"] === "string" ? req.headers["linear-event"] : null, detail: { headers: req.headers } });

      // ── 2. Get raw body ────────────────────────────────────────────────────
      const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
      log.info(`Raw body length: ${rawBody?.length || 0} bytes`);

      // ── 3. Signature validation (skip if no secret configured) ────────────
      if (secrets.length > 0) {
        const signature = req.headers["x-linear-signature"] ?? req.headers["linear-signature"];
        if (!signature || typeof signature !== "string") {
          appendOperationalEvent(operationalEventStore, { outcome: "signature-rejected", errorSummary: "Missing signature header" });
          res.status(400).json({
            error: "Missing signature header",
          });
          return;
        }

        if (!rawBody) {
          res.status(400).json({ error: "Empty or unreadable request body" });
          return;
        }

        const signatureValid = verifyLinearSignatureMulti(rawBody, signature as string, secrets);
      log.info(`Signature validation result: ${signatureValid ? "valid" : "invalid"}`);
        if (!signatureValid) {
          appendOperationalEvent(operationalEventStore, { outcome: "signature-rejected", errorSummary: "Invalid signature" });
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      } else {
        log.warn("No LINEAR_WEBHOOK_SECRETS or LINEAR_WEBHOOK_SECRET set — skipping signature validation");
      }

      // ── 4. Parse JSON payload ─────────────────────────────────────────────
      let payload: unknown;
      try {
        const body = rawBody ?? Buffer.from(JSON.stringify(req.body));
        payload = JSON.parse(body.toString("utf8"));
      log.info("JSON parsed successfully");
      } catch {
        res.status(400).json({ error: "Malformed JSON payload" });
        return;
      }

      // ── 6. Normalize event ────────────────────────────────────────────────
      let event: LinearEvent;
      try {
        event = normalizeLinearEvent(payload);
      log.info(`Event normalized: type=${event.type}`);
        appendOperationalEvent(operationalEventStore, { outcome: "normalized", type: event.type, detail: { action: event.action } });
      } catch (err) {
        res.status(400).json({
          error: "Invalid payload structure",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // ── 7. Deduplication ──────────────────────────────────────────────────
      const deliveryId =
        (req.headers["x-linear-delivery"] as string | undefined) ??
        crypto.createHash("sha256").update(rawBody ?? Buffer.from(JSON.stringify(payload))).digest("hex");

      if (eventStore?.isDuplicate(deliveryId)) {
      log.info(`Checking duplicate for delivery: ${deliveryId}`);
        appendOperationalEvent(operationalEventStore, { outcome: "duplicate", type: event.type, key: deliveryId });
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // ── 8. Acknowledge immediately ────────────────────────────────────────
      res.status(200).json({ ok: true });

      // Record event for dedup & restart recovery
      eventStore?.recordEvent(deliveryId, payload as object);

      // ── 9. Route to agent ─────────────────────────────────────────────────
      log.info(`Normalized event: type=${event.type} hasData=${"data" in event} dataKeys=${event.data ? Object.keys(event.data as object).join(',') : 'none'}`);

      if (isTerminalIssueEvent(event)) {
        const identifier = issueIdentifierFromEvent(event);
        if (identifier) {
          const sessionKey = normalizeSessionKey(identifier);
          const removedBag = bag?.removeTicketForAllAgents(sessionKey) ?? 0;
          const removedQueued = sessionTracker?.removePendingTicket(sessionKey) ?? 0;
          log.info(
            `Terminal issue event for ${sessionKey}: pruned ${removedBag} pending bag entr${removedBag === 1 ? "y" : "ies"}` +
            ` and ${removedQueued} queued signal${removedQueued === 1 ? "" : "s"}; skipping agent dispatch`,
          );
          appendOperationalEvent(operationalEventStore, { outcome: "terminal-pruned", type: event.type, key: sessionKey, sessionKey, detail: { removedBag, removedQueued } });

          // Phase 5 / B-3: Barrier (N→1) — event-driven parent auto-advance.
          // When a child reaches a terminal state, check if all siblings are
          // terminal and auto-advance the parent managing → review.
          // Fail-open: barrier errors are logged and never block the terminal prune.
          const barrierToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
          if (barrierToken) {
            onChildTerminal(identifier, barrierToken).then((result) => {
              if (result?.transitioned) {
                log.info(`Barrier: auto-advanced parent of ${identifier} managing → review`);
              }
            }).catch((err) => {
              log.warn(`Barrier check failed for terminal child ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        } else {
          log.info("Terminal issue event without identifier; skipping agent dispatch");
        }
        return;
      }

      acknowledgeAgentAuthoredActivity(event, onAgentActivity);

      // AI-1584: Enrollment gap repair — heal wf:* tickets that lack state:* label.
      // Fires on every Issue event (create or update). Fail-open: never blocks routing.
      if (event.type === "Issue") {
        const enrollToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
        const enrollData = event.data as Record<string, unknown> | null;
        const enrollIssueId = enrollData?.id as string | undefined;
        if (enrollToken && enrollIssueId) {
          const enrollIdentifier = (enrollData?.identifier as string | undefined) ?? enrollIssueId;
          enrollIfMissing(enrollIssueId, enrollToken, (heal) => {
            // AI-1585 / AC2: structured audit event for the reconciliation heal.
            appendOperationalEvent(operationalEventStore, {
              outcome: "enrollment-healed",
              type: event.type,
              key: enrollIdentifier,
              sessionKey: normalizeSessionKey(enrollIdentifier),
              detail: { workflowId: heal.workflowId, entryState: heal.entryState },
            });
          }).then((result) => {
            if (result.enrolled) {
              log.info(`Enrollment gap healed: stamped state:${result.entryState} on ${enrollIssueId}`);
            }
          }).catch((err) => {
            log.warn(`enrollIfMissing failed for ${enrollIssueId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      // AgentSessionEvent — create session for Linear UI widget
      if (event.type === "AgentSessionEvent") {
        // Create a Linear agent session to show "Agent working" widget
        // This is separate from OpenClaw agent routing
        const data = (event.data as Record<string, unknown> | undefined) ?? {};
        const sessionData = (data.agentSession as Record<string, unknown> | undefined) ?? {};
        const issueData = (sessionData.issue as Record<string, unknown> | undefined) ?? {};
        const issueId = issueData.id as string | undefined;
        if (!issueId) {
          log.warn("AgentSessionEvent has no issue data - skipping session creation");
          return;
        }
        // Extract agent name from event data (for session creation)
        const agentName = (sessionData.user as { name?: string } | undefined)?.name || "unknown";
        let agentSessionId: string | null = null;
        try {
          const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
            identifier: issueData.identifier as string | undefined,
            title: issueData.title as string | undefined,
            description: issueData.description as string | undefined,
          });
          agentSessionId = sessionResult.sessionId;
        } catch (err) {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Pre-routing: workflow bootstrap hook (AI-1565) ─────────────────────
      // Fires before the delegate-based router so a wf:* label-add with no
      // delegate can bootstrap the ticket into its entry state and set the
      // first-owner delegate — which then fires the normal dispatch path.
      const bootstrapToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? (() => {
        // Fallback: use any agent's OAuth token (needed when there's no
        // generic service token in the env — e.g. ILL Tokyo deployment).
        const agents = getAgents();
        for (const a of agents) {
          const t = getAccessToken(a.name);
          if (t) return t;
        }
        return undefined;
      })();
      if (bootstrapToken) {
        try {
          const bootstrapResult = await maybeBootstrapWorkflow(event, bootstrapToken);
          if (bootstrapResult) {
            log.info(`Workflow bootstrap: ${bootstrapResult.action} (wf:${bootstrapResult.workflowId ?? "unknown"})`);
            const bootstrapOutcome = bootstrapResult.action === "bootstrapped" ? "bootstrap-bootstrapped" : "bootstrap-demoted";
            appendOperationalEvent(operationalEventStore, { outcome: bootstrapOutcome, type: event.type });

            // AI-fix: after bootstrap, deliver a workflow-aware wake to the
            // newly-assigned delegate so they know what to do.
            if (bootstrapResult.action === "bootstrapped" && bootstrapResult.delegateAgentName && bootstrapResult.ticketIdentifier) {
              const wakeSessionKey = normalizeSessionKey(bootstrapResult.ticketIdentifier);
              const wakeRoute: RouteResult = {
                agentId: bootstrapResult.delegateAgentName,
                sessionKey: wakeSessionKey,
                priority: 0,
                routingReason: "delegate",
                event,
              };
              const agentCfg = getAgent(bootstrapResult.delegateAgentName);
              const wakeDeliveryConfig: DeliveryConfig = {
                nodeBin: process.execPath,
                hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
                hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
                hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
                hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
              };
              try {
                if (throttle) {
                  await throttle.wait(wakeRoute.agentId);
                  throttle.record(wakeRoute.agentId);
                }
                const wakeResult = await deliverWithSlot(wakeRoute, wakeDeliveryConfig, throttle);
                log.info(
                  `Bootstrap wake delivered to ${bootstrapResult.delegateAgentName} for ${bootstrapResult.ticketIdentifier} (runId=${wakeResult.runId ?? "ok"})`,
                );
                appendOperationalEvent(operationalEventStore, {
                  outcome: wakeResult.runId ? "bootstrap-wake-dispatched" : "bootstrap-wake-delivered",
                  type: event.type,
                  agent: bootstrapResult.delegateAgentName,
                  key: wakeSessionKey,
                  sessionKey: wakeSessionKey,
                  deliveryMode: "bootstrap-wake",
                  attemptCount: 1,
                  runId: wakeResult.runId ?? null,
                });
                if (onDispatched) onDispatched(bootstrapResult.delegateAgentName, wakeSessionKey);
              } catch (err) {
                log.error(
                  `Bootstrap wake delivery failed for ${bootstrapResult.delegateAgentName}: ${err instanceof Error ? err.message : String(err)}`,
                );
                appendOperationalEvent(operationalEventStore, {
                  outcome: "bootstrap-wake-failed",
                  type: event.type,
                  agent: bootstrapResult.delegateAgentName,
                  key: wakeSessionKey,
                  sessionKey: wakeSessionKey,
                  deliveryMode: "bootstrap-wake",
                  attemptCount: 1,
                  errorSummary: errorSummary(err),
                });
              }
            }
            return;
          }
        } catch (err) {
          log.warn(`Workflow bootstrap failed (fail-safe): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await enrichCommentEventForRouting(event);
      const routes = routeEventAll(event);
      if (routes.length === 0) {
        log.info(`No agent target for event type=${event.type} action=${"action" in event ? event.action : "?"}`);
        const noRouteData = (event as { data?: Record<string, unknown> }).data;
        const noRouteTicket =
          (noRouteData?.identifier as string) ||
          (noRouteData?.issueIdentifier as string) ||
          (noRouteData?.issueId as string) ||
          (noRouteData?.id as string) ||
          null;
        appendOperationalEvent(operationalEventStore, {
          outcome: "no-route",
          type: event.type,
          key: noRouteTicket ? `linear-${noRouteTicket}` : null,
          errorSummary: `No agent target for ${event.type}${noRouteTicket ? ` (${noRouteTicket})` : ""}`,
        });
        // Audit finding #1: this was the fully-silent "assigned it and nothing
        // happened" case — a delegate/assignee/mention matching no registered
        // agent left no artifact anywhere. Now it pushes — but only when the
        // event actually named someone we couldn't resolve. Events with no
        // routing candidates at all (IssueLabel/Project/... entity writes,
        // unassigned issues, plain comments, AgentSessionEvent UI widgets)
        // no-route by construction and stay log+store only.
        const unresolved = unresolvedRoutingCandidates(event);
        if (unresolved.length > 0) {
          notify({
            severity: "warning",
            source: "routing",
            title: "no-route: event named a delegate/assignee/mention unknown to agents.json",
            detail: `type=${event.type} action=${"action" in event ? event.action : "?"} unresolved=${unresolved.join(",")}`,
            ticket: issueIdentifierFromEvent(event) ?? undefined,
          });
        }
        return;
      }

      // Dispatch each route through the full guard pipeline, sequentially.
      // Multi-route events (mention fan-out, audit #3) are rare; sequential
      // keeps per-agent throttle and bag semantics simple. A failure in one
      // route's dispatch must not starve the remaining routes.
      for (const dispatchTarget of routes) {
        try {
          await dispatchRoute(dispatchTarget);
        } catch (err) {
          log.error(`dispatchRoute failed for ${dispatchTarget.agentId} [${dispatchTarget.sessionKey}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;

      async function dispatchRoute(route: RouteResult): Promise<void> {
      // ── 9a. Stale-route guard ───────────────────────────────────────────
      // Linear webhook payloads are snapshots. Before waking an agent from a
      // delegate/assignee event, re-check Linear's current issue state so an
      // accidental delegation that was already corrected does not let the old
      // agent take ownership or mutate the ticket later.
      const ticketId = route.sessionKey;
      if (!(await isLinearIssueStillRoutedToAgent(ticketId, route.agentId, route.routingReason))) {
        appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "stale-route" });
        return;
      }

      // ── 9b. Nudge deduplication + coalescing ─────────────────────────────
      // Suppress rapid-fire duplicate events for the same agent+ticket.
      if (NUDGE_DEDUP_WINDOW_MS > 0 && nudgeStore) {
        const info = nudgeStore.getCoalesceInfo(route.agentId, ticketId, NUDGE_DEDUP_WINDOW_MS);
        if (info.suppressed) {
          log.info(`Nudge dedup: coalescing delivery for ${route.agentId} [${ticketId}] — within ${NUDGE_DEDUP_WINDOW_MS}ms window`);
          nudgeStore.recordCoalesced(route.agentId, ticketId, event.type, "action" in event ? event.action : undefined);
          appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "nudge-dedup" });
          return;
        }
        // Window expired — drain coalesced count before delivering
        const coalescedCount = nudgeStore.drainCoalescedCount(route.agentId, ticketId);
        nudgeStore.recordNudge(route.agentId, ticketId);
        if (coalescedCount > 0) {
          log.info(`Nudge dedup: delivering for ${route.agentId} [${ticketId}] with ${coalescedCount} coalesced event(s)`);
          route.coalescedCount = coalescedCount;
        }
      }

      const agentName = route.agentId;
      log.info(`Routed event to ${agentName} [${route.sessionKey}]`);
      appendOperationalEvent(operationalEventStore, { outcome: "routed", type: event.type, agent: agentName, key: route.sessionKey, sessionKey: route.sessionKey, deliveryMode: bag && sessionTracker ? "pending-bag" : agentQueue ? "agent-queue" : "direct" });

      // ── 9c. AI-1428: Pre-flight liveness check + role-guard ────────────
      // Before dispatching to an agent, verify it's reachable. If not,
      // emit DELEGATE_UNAVAILABLE instead of silently stalling.
      // Also check role-guard for implementation-state tickets.
      const livenessConfig: LivenessConfig = {
        hooksUrl: process.env.OPENCLAW_HOOKS_URL,
        hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
      };
      const agentLivenessCfg = getAgent(route.agentId);
      if (agentLivenessCfg?.hooksUrl) livenessConfig.hooksUrl = agentLivenessCfg.hooksUrl;
      if (agentLivenessCfg?.hooksToken) livenessConfig.hooksToken = agentLivenessCfg.hooksToken;

      const liveness = await checkAgentLiveness(route.agentId, livenessConfig);
      if (!liveness.available) {
        // Agent unreachable — emit DELEGATE_UNAVAILABLE escalation.
        log.warn(
          `DELEGATE_UNAVAILABLE: ${route.agentId} is unreachable (${liveness.reason}: ${liveness.detail ?? "unknown"}) — skipping delivery for ${ticketId}`,
        );
        appendOperationalEvent(operationalEventStore, {
          outcome: "delivery-failed",
          type: event.type,
          agent: agentName,
          key: ticketId,
          sessionKey: ticketId,
          deliveryMode: "delegate-unavailable",
          attemptCount: 1,
          errorSummary: `DELEGATE_UNAVAILABLE: ${liveness.reason}: ${liveness.detail ?? "unknown"}`,
        });
        await emitDelegateUnavailable(
          ticketId.replace(/^linear-/, ""),
          route.agentId,
          `${liveness.reason}: ${liveness.detail ?? "unknown"}`,
        );
        // No delivery was sent — roll back the dedup priming so a later genuine
        // dispatch to this agent+ticket inside the window is not swallowed (AI-1538).
        nudgeStore?.clearNudge(route.agentId, ticketId);
        // Do NOT deliver — return immediately.
        return;
      }

      // Role-guard (AI-1459 enforcement mode): check whether the target agent
      // fills the owner_role for the ticket's current workflow state.
      // If blocked: skip delivery — the guard has posted a comment and
      // attempted delegate correction.
      const issueIdentifier = ticketId.replace(/^linear-/, "");
      const roleGuardToken =
        getAccessToken(route.agentId) ??
        process.env.LINEAR_OAUTH_TOKEN ??
        process.env.LINEAR_API_KEY;
      if (roleGuardToken) {
        try {
          const guardLabels = await fetchWorkflowLabels(issueIdentifier, roleGuardToken);
          // Provide a resolver so the guard can auto-correct the delegate
          // without needing to import agents.ts directly (avoids the test
          // compile-time dependency on fancy-openclaw-linear-skill-cli).
          const linearUserIdResolver: LinearUserIdResolver = (bodyName: string) => {
            const agents = getAgents();
            const agent = agents.find(
              (a) => a.name.toLowerCase() === bodyName.toLowerCase() ||
                     (a as { openclawAgent?: string }).openclawAgent?.toLowerCase() === bodyName.toLowerCase()
            );
            return (agent as { linearUserId?: string } | undefined)?.linearUserId ?? null;
          };
          const guardResult = await checkRoleGuardAndBlock(route.agentId, issueIdentifier, guardLabels, linearUserIdResolver);
          if (guardResult.blocked) {
            log.warn(
              `routing-guard: dispatch blocked for ${route.agentId} [${issueIdentifier}] — ${guardResult.reason ?? "role mismatch"}; ` +
              (guardResult.correctedTo ? `corrected to ${guardResult.correctedTo}` : "delegate cleared")
            );
            appendOperationalEvent(operationalEventStore, {
              outcome: "delivery-failed",
              type: event.type,
              agent: agentName,
              key: ticketId,
              sessionKey: ticketId,
              deliveryMode: "role-guard-blocked",
              attemptCount: 1,
              errorSummary: `routing-guard blocked: ${guardResult.reason ?? "role mismatch"}`,
            });
            // No delivery was sent — roll back the dedup priming so the genuine
            // dispatch to the agent that legitimately becomes the delegate is not
            // swallowed as a "duplicate" of this blocked attempt (AI-1538).
            nudgeStore?.clearNudge(route.agentId, ticketId);
            return;
          }
        } catch (err) {
          log.warn(`Role-guard check failed for ${issueIdentifier}: ${err instanceof Error ? err.message : String(err)} — continuing`);
        }
      }

      // Delivery is now committed: the event routed to a delegate that passed
      // the stale-route, liveness, and role-guard checks. Register a pending
      // dispatch expectation BEFORE the actual send so that if the delivery is
      // later swallowed (nudge-dedup) or sent through a path that records no
      // ack, the watchdog still sees an unacknowledged dispatch and re-signals
      // it (AI-1538). ensurePending uses attempt_count=0 + ON CONFLICT DO
      // NOTHING, so the happy path's counter is unchanged.
      onDeliveryCommitted?.(agentName, ticketId);

      // ── 10. Create agent session + emit thought ───────────────────────────
      const data = event.data as Record<string, unknown> | null;
      const issueId = data?.id as string | undefined;
      let agentSessionId: string | null = null;

      if (issueId && event.type === "Issue") {
        try {
          const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
            identifier: data?.identifier as string | undefined,
            title: data?.title as string | undefined,
            description: data?.description as string | undefined,
          });
          agentSessionId = sessionResult.sessionId;
        } catch (err) {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── v1.1: Pull-based wake-up via PendingWorkBag ─────────────────────
      // Add to bag (deduped by ticket ID). Send wake-up signal only if
      // agent has no active session. Bursts collapse to 1 signal.
      if (bag && sessionTracker) {
        const normalizedTicketId = normalizeSessionKey(ticketId);
        bag.add(agentName, normalizedTicketId, event.type, route.routingReason);
        // Purge stale bag entries for this ticket from all other agents. When a
        // delegate changes, the previous holder's bag entry must be removed so it
        // doesn't receive a spurious consider-work wake for a ticket it no longer owns.
        if (route.routingReason === "delegate" || route.routingReason === "assignee") {
          const purgedStale = bag.removeTicketForOtherAgents(agentName, normalizedTicketId);
          if (purgedStale > 0) {
            log.info(`Bag: purged stale entries for ${normalizedTicketId} from ${purgedStale} other agent(s)`);
          }
        }
        appendOperationalEvent(operationalEventStore, { outcome: "bag-added", type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId, deliveryMode: "pending-bag" });

        const wakeConfig: WakeUpConfig = {
          nodeBin: process.execPath,
          hooksUrl: process.env.OPENCLAW_HOOKS_URL,
          hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
          hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
          hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
          timeoutMs: process.env.NODE_ENV === "test" ? 50 : undefined,
          maxRetries: process.env.NODE_ENV === "test" ? 0 : undefined,
        };

        // Per-agent override: prefer the agent's own hooksUrl/hooksToken from
        // agents.json so dispatches reach the right gateway/container instead of
        // always hitting OPENCLAW_HOOKS_URL (which may belong to a different fleet).
        const wakeConfigForAgent = (agentIdLookup: string): WakeUpConfig => {
          const cfg = getAgent(agentIdLookup);
          return {
            ...wakeConfig,
            hooksUrl: cfg?.hooksUrl ?? wakeConfig.hooksUrl,
            hooksToken: cfg?.hooksToken ?? wakeConfig.hooksToken,
          };
        };

        // Before honoring in-memory active-session locks, synchronously expire
        // stale sessions. The interval-based cleanup is only a backstop; webhook
        // traffic should not wait up to another minute behind an already-expired
        // lock, and stale cleanup must re-signal queued work instead of stranding it.
        const staleSessions = sessionTracker.cleanupStale();
        for (const stale of staleSessions) {
          log.info(`Webhook stale-session drain: re-signaling ${stale.agentId} for ${stale.pendingTickets.length} ticket(s)`);
          await resignalPendingTickets(stale.agentId, stale.pendingTickets, bag, sessionTracker, wakeConfigForAgent(stale.agentId), { markActive: true, onDispatched });
        }

        if (sessionTracker.isActiveForTicket(agentName, normalizedTicketId)) {
          // Same ticket already has an active session: deliver directly into it.
          // Waiting for /session-end here would strand same-ticket conversational updates.
          log.info(`Bag: active same-ticket session for ${agentName} [${normalizedTicketId}], delivering immediately`);
          try {
            if (throttle) {
              log.info(`Dispatch throttle: waiting for ${agentName} (same-ticket active)`);
              await throttle.wait(route.agentId);
              throttle.record(route.agentId);
            }
            const sameTicketResult = await deliverWithSlot(route, wakeConfigForAgent(route.agentId), throttle);
            bag.removeTicket(agentName, normalizedTicketId);
            appendOperationalEvent(operationalEventStore, {
              outcome: sameTicketResult.runId ? "dispatch-accepted" : "delivered",
              type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId,
              deliveryMode: "active-same-ticket", attemptCount: 1, runId: sameTicketResult.runId ?? null
            });
          } catch (err) {
            log.error(`Same-ticket active delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
            appendOperationalEvent(operationalEventStore, { outcome: "delivery-failed", type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId, deliveryMode: "active-same-ticket", attemptCount: 1, errorSummary: errorSummary(err) });
            sessionTracker.queueSignal(agentName, [normalizedTicketId]);
          }
          return;
        }

        // No active session for this specific ticket key. Dispatch a wake-up
        // immediately — even if the agent has other active sessions for other
        // tickets. Each ticket gets its own independent per-ticket session.
        const pending = bag.getPendingTickets(agentName);
        const pendingIds = pending.map((e) => e.ticketId);
        log.info(`Bag: sending wake-up signal(s) to ${agentName} with ${pendingIds.length} ticket(s)`);
        const dispatchResults = await resignalPendingTickets(agentName, pendingIds, bag, sessionTracker, wakeConfigForAgent(agentName), { markActive: true, onDispatched });
        const dispatched = dispatchResults.filter(r => r.dispatched).length;
        const firstRunId = dispatchResults.find(r => r.runId)?.runId ?? null;
        appendOperationalEvent(operationalEventStore, {
          outcome: dispatched > 0 ? "dispatch-accepted" : "delivery-failed",
          type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId,
          deliveryMode: "wake-up", attemptCount: pendingIds.length, runId: firstRunId,
          errorSummary: dispatched > 0 ? null : "No wake-up signals dispatched"
        });
        return;
      }

      // ── v1.0 fallback: Agent queue with ticket-level coalescing ─────────
      if (agentQueue) {
        const queueResult = agentQueue.enqueueOrCoalesce(route);
        if (queueResult.action === "active-busy") {
          log.info(`Agent queue: ${route.agentId} already has active task for [${ticketId}] — skipping`);
          appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "agent-queue-active-busy" });
          return;
        }
        if (queueResult.action === "coalesced") {
          log.info(`Agent queue: coalesced queued event for ${route.agentId} [${ticketId}]`);
          appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "agent-queue-coalesced" });
          return;
        }
        if (queueResult.action === "queued") {
          log.info(`Agent queue: queued event for ${route.agentId} [${ticketId}] (active task for different ticket)`);
          appendOperationalEvent(operationalEventStore, { outcome: "queued", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "agent-queue" });
          return;
        }
        log.info(`Agent queue: delivering immediately for ${route.agentId} [${ticketId}]`);
      }

      // Deliver to OpenClaw agent via delivery module
      const agentCfg = getAgent(route.agentId);
      const deliveryConfig = {
        nodeBin: process.execPath,
        hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
        hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
        hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
        hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
      };
      try {
        if (throttle) {
          log.info(`Dispatch throttle: waiting for ${agentName}`);
          await throttle.wait(route.agentId);
          throttle.record(route.agentId);
        }
        const directResult = await deliverWithSlot(route, deliveryConfig, throttle);
        appendOperationalEvent(operationalEventStore, { outcome: directResult.runId ? "dispatch-accepted" : "delivered", type: event.type, agent: agentName, key: ticketId, sessionKey: ticketId, deliveryMode: "direct", attemptCount: 1, runId: directResult.runId ?? null });
        // Direct deliveries (incl. comment-routed wakes into an existing
        // session) must register the dispatch and flip engagement → Thinking
        // like every other delivery path. Observed on AI-1768 (2026-07-04
        // 07:13): a revision comment woke the delegate but the ticket sat at
        // To Do with no ack expectation — invisible pickup, unwatched dispatch.
        if (directResult.runId && onDispatched) onDispatched(agentName, ticketId);
      } catch (err) {
        log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        appendOperationalEvent(operationalEventStore, { outcome: "delivery-failed", type: event.type, agent: agentName, key: ticketId, sessionKey: ticketId, deliveryMode: "direct", attemptCount: 1, errorSummary: errorSummary(err) });
      } finally {
        if (agentQueue) {
          let next = agentQueue.complete(route.agentId);
          while (next) {
            log.info(`Agent queue: promoting next task for ${route.agentId} [${next.sessionKey}]`);
            try {
              if (throttle) {
                log.info(`Dispatch throttle: waiting for ${route.agentId} (drain)`);
                await throttle.wait(route.agentId);
                throttle.record(route.agentId);
              }
              const drainResult = await deliverWithSlot(next, deliveryConfig, throttle);
              appendOperationalEvent(operationalEventStore, { outcome: drainResult.runId ? "dispatch-accepted" : "delivered", type: next.event.type, agent: route.agentId, key: next.sessionKey, sessionKey: next.sessionKey, deliveryMode: "agent-queue-drain", attemptCount: 1, runId: drainResult.runId ?? null });
            } catch (err) {
              log.error(`Agent queue: failed to deliver promoted task for ${route.agentId}: ${err instanceof Error ? err.message : String(err)}`);
              appendOperationalEvent(operationalEventStore, { outcome: "delivery-failed", type: next.event.type, agent: route.agentId, key: next.sessionKey, sessionKey: next.sessionKey, deliveryMode: "agent-queue-drain", attemptCount: 1, errorSummary: errorSummary(err) });
            }
            next = agentQueue.complete(route.agentId);
          }
        }
      }
      } // dispatchRoute
    },
  );

  return router;
}
