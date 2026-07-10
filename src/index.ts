import 'dotenv/config';
import express, { Request, Response, NextFunction } from "express";
import { createWebhookRouter } from "./webhook/index.js";
import { handleProxyRequest } from "./proxy.js";
import { handleProxyUploadRequest } from "./proxy-upload.js";
import { startTokenRefresh } from "./token-refresh.js";
import { getAgents, watchAgentsFile } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { handleOAuthCallback } from "./oauth-callback.js";
import { EventStore } from "./store/event-store.js";
import { NudgeStore } from "./store/nudge-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { ObservationStore } from "./store/observation-store.js";
import { registerObservationWritePath, getObservationWritePathState } from "./store/observation-write-path.js";
import { ManagingStateStore } from "./store/managing-state-store.js";
import { AgentQueue } from "./queue/index.js";
import { deliverToAgent, deliverMessageToAgent, type DeliveryConfig, DeliveryThrottle, DispatchDeliveryScheduler } from "./delivery/index.js";
import { buildWorkflowAwareDeliveryMessage } from "./delivery/build-message.js";
import { PendingWorkBag, SessionTracker, DispatchAckTracker, DispatchWatchdog, NoActivityDetector, StuckDelegateDetector, HoldRetryTracker, resignalPendingTickets, replayPendingBag, ManagingPoller } from "./bag/index.js";
import { sendWakeUpSignal, type WakeUpConfig } from "./bag/wake-up.js";
import { getTicketNoActivityTimeoutMs, getWorkflowRegistryLiveness, loadWorkflowRegistry } from "./workflow-gate.js";
import { getDefStateMigrationLiveness, registerDefStateMigrationRunner } from "./def-state-migration.js";
import { normalizeSessionKey } from "./session-key.js";
import { applyEngagementStatus } from "./engagement-status.js";
import { createAdminRouter } from "./admin.js";
import { buildSnapshot, writeSnapshot, appendDigestEntry, fetchLinearTicketState, recoverTicket, STALE_CLASS_NAMES, type StaleSnapshot, type ForensicsConfig } from "./bag/stale-session-forensics.js";
import { registerDistillationCron } from "./cron/p4-metrics-distillation.js";
import { registerRescueSweepCron } from "./cron/rescue-sweep-cron.js";
import { registerG20CanaryCron } from "./cron/g20-canary-runner.js";
import { registerBootstrapReconciliationCron } from "./bootstrap-reconciliation-sweep.js";
import { registerDelegationReconciliationCron, runDelegationReconciliationSweep } from "./delegation-reconciliation-sweep.js";
import { getAlertBus } from "./alerts/alert-bus.js";
import { registerSlaSweepCron } from "./sla-sweep.js";
import { registerOobReconcileCron } from "./oob-reconcile-sweep.js";
import { MutationAuditStore } from "./store/mutation-audit-store.js";
import { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { getRegisteredCrons } from "./cron/registry.js";
import { getRescueSweepState } from "./rescue-sweep-state.js";
import { registerFirstActionWatchdogCron } from "./first-action-watchdog.js";
import { getFirstActionWatchdogState } from "./first-action-watchdog-state.js";
import { LINEAR_API_URL } from "./linear-helpers.js";
import { getCapabilityPolicy } from "./escalation-gate.js";
import { notify, type AlertSeverity } from "./alerts/alert-bus.js";
import { onAlert as onConfigHealthAlert } from "./config-health.js";
import { startRegistryPolicyCheck } from "./registry-policy.js";
import { resolveStartupCommit } from "./startup-commit.js";
import { getAccessToken, getAgent, getLinearUserIdForAgent } from "./agents.js";
import { loadUniversalCanon, getCanonLiveness } from "./policy/universal-canon.js";
import { loadRoster, getRoutingFunctionaryLiveness } from "./department-roster.js";
import { createGuidanceRouter, getDocsLiveness } from "./docs/guidance-router.js";
import type { StaleSessionDetail } from "./bag/session-tracker.js";
import crypto from "crypto";
import path from "path";

const log = componentLogger(createLogger(), "server");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3100;
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME ?? "fancymatt";

// ── Startup commit (exposed via /health for deploy verification) ─────
let startupCommit: string = "unknown";
function setStartupCommit(hash: string) { startupCommit = hash; }
function getStartupCommit(): string { return startupCommit; }

/**
 * Constant-time secret comparison to prevent timing attacks.
 */
function verifySecret(header: string, secret: string): boolean {
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) {
    // Still compare to keep constant time — compare against self then fail
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function secretFromBasicAuthorization(authorization: string): string | null {
  const encoded = authorization.slice("Basic ".length).trim();
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
}

function adminSecretFromRequest(req: Request): string | null {
  const header = req.headers["x-admin-secret"];
  if (typeof header === "string") return header;
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  if (authorization?.startsWith("Basic ")) return secretFromBasicAuthorization(authorization);
  return null;
}

function requireAdminSecret(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ success: false, error: "ADMIN_SECRET is not configured" });
    return false;
  }
  const actual = adminSecretFromRequest(req);
  if (!actual || !verifySecret(actual, expected)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function parseJsonBody<T extends object>(req: Request): T | null {
  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8")) as T;
  }
  if (typeof req.body === "object" && req.body !== null) {
    return req.body as T;
  }
  return null;
}

export interface CreateAppOptions {
  /** Override PendingWorkBag database path (for testing). */
  bagDbPath?: string;
  /** Override AgentQueue database path (for testing). */
  agentQueueDbPath?: string;
  /** Override OperationalEventStore database path (for testing). */
  operationalEventsDbPath?: string;
  /** Override ObservationStore database path (for testing). */
  observationsDbPath?: string;
  /** Override ManagingStateStore database path (for testing). */
  managingStateDbPath?: string;
  /** Override EnrolledTicketsStore database path (for testing). */
  enrolledTicketsDbPath?: string;
  /** Override MutationAuditStore database path (for testing). AI-1838. */
  mutationAuditDbPath?: string;
  /** Override DispatchIdempotencyStore database path (for testing). AI-1918. */
  idempotencyDbPath?: string;
  /** Override forensics diagnostics base directory (for testing, AI-1953). */
  forensicsDiagnosticsDir?: string;
  /**
   * Test hook: override wake-up delivery for resignal/hold-retry dispatches.
   * When provided, replaces the real sendWakeUpSignal so tests don't hit the
   * live hooks URL. Also used as isTicketActionable bypass when provided.
   */
  sendWakeUp?: (agentId: string, ticketIds: string[]) => Promise<void>;
}

export function createApp(options?: CreateAppOptions) {
  // Reset module-level singleton so per-test AC_RECORDS_PATH is picked up.
  clearAcRecordStore();
  const app = express();
  app.set("trust proxy", true);

  // Create stores early — needed before route registration.
  const observationStore = new ObservationStore(options?.observationsDbPath);

  // AI-2036 AC1.5/AC1.6: register the observation write path here, on the same
  // code path that hands the store to the proxy's transition options below.
  // The registry entry — surfaced at /health.observations — therefore exists if
  // and only if production bootstrap really wired it, which is the check that
  // AI-1773/AI-1775 shipped without. `subscribed` records the second half: the
  // transition handler in workflow-gate receives this exact instance.
  registerObservationWritePath(observationStore, { subscribed: true });

  // Raw body capture for webhook signature validation.
  app.use(
    "/",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    },
  );

  // GraphQL proxy — v0 transparent pass-through (Phase 0B, design.md §4.6).
  // Intercepts every Linear CLI call from Nakazawa agents; forwards unchanged
  // for now. Future phases add per-step instruction injection and command
  // validation. ILL fleet runs the main branch and is unaffected.
  // AI-1860: per-app authorization snapshot map — fresh per createApp() call so
  // test isolation is guaranteed and snapshots never outlive the app instance.
  const commandAuthSnapshots = new Map<string, { snapshotDelegateId: string | null; snapshotState: string | null; expiresAt: number }>();

  app.post("/proxy/graphql", (req, res) => handleProxyRequest(req, res, {
    observationStore,
    operationalEventStore,
    noActivityDetector,
    enrolledTicketsStore,
    mutationAuditStore,
    commandAuthSnapshots,
    onProxyCall: (agentId, ticketId) => {
      // Any proxy call = implicit acknowledgment. Prevents the dispatch watchdog from
      // re-signaling agents that are working silently (e.g. sessions_yield during image gen).
      const acknowledged = ackTracker.acknowledge(agentId, ticketId);
      if (acknowledged > 0) {
        noActivityDetector.clearWarned(agentId, ticketId);
        log.info(`proxy-auto-ack agent=${agentId} ticket=${ticketId}`);
      }
    },
  }));

  // Upload proxy — AI-1767. Agents can't fetch uploads.linear.app directly
  // because their lpx_ proxy token is rejected by Linear. This endpoint
  // resolves the real token from the proxy token and fetches the asset.
  app.get("/proxy/upload", (req, res) => handleProxyUploadRequest(req, res));

  // Health check — returns 503 when the agent roster is empty so the
  // Docker healthcheck (and any load balancer) pulls the container out of
  // rotation instead of silently serving an empty-roster instance. This was
  // the exact failure mode of the v1.5.0 deploy (AI-1767): the image booted,
  // /health returned 200, but 0 of 28 agents were loaded → fleet-wide 401s
  // and dropped webhooks.
  app.get("/health", async (_req: Request, res: Response) => {
    const agents = getAgents();
    const healthy = agents.length > 0;

    // AI-2008 AC3: loud dispatch-undeliverable surfacing. Every dispatch that
    // exhausted its bounded retries is a first-class operational event; project
    // the recent ones into /health.warnings so an undelivered wake is visible
    // without log access, naming ticket/state/delegate/gateway.
    const undeliverable = operationalEventStore.query({
      outcome: "dispatch-undeliverable",
      limit: 100,
    });
    const warnings = undeliverable.map((e) => {
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      return {
        kind: "dispatch-undeliverable",
        ticket: (detail.ticket as string | undefined) ?? e.key ?? null,
        state: (detail.state as string | undefined) ?? e.workflowState ?? null,
        delegate: (detail.delegate as string | undefined) ?? e.agent ?? null,
        gateway: (detail.gateway as string | undefined) ?? null,
        attempts: e.attemptCount ?? null,
        occurredAt: e.occurredAt,
      };
    });

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      // AI-2008: operational warnings surfaced at /health (dispatch-undeliverable
      // and any future first-class warning class). Always an array.
      warnings,
      // AI-2008 AC1 + AI-1808 addendum: dispatch delivery-ack / retry scheduler
      // liveness sourced from the real DispatchDeliveryScheduler. schedulerActive
      // is true only after the driver is armed at bootstrap (start()), and false
      // if it was never wired — not a hardcoded literal. pendingRetries is the
      // live count of in-flight backoff waits in the delivery layer. The
      // "armed at the production entry point" proof lives in the dist/index.js
      // subprocess test (ai-2008-bootstrap-wiring).
      dispatchDelivery: {
        ...dispatchDeliveryScheduler.liveness(),
        undeliverable: undeliverable.length,
      },
      service: "fancy-openclaw-linear-connector",
      deployment: DEPLOYMENT_NAME,
      commit: getStartupCommit(),
      agents: agents.length,
      agentNames: agents.map((a) => a.name),
      // AI-1810: live scheduling state. Every periodic/background driver
      // registers at the moment its timer is created; an expected driver
      // missing from this list means it shipped without bootstrap wiring
      // (the AI-1773/AI-1775 dead-code-in-prod failure mode).
      crons: getRegisteredCrons(),
      // AI-2036 AC1.6: observation write-path liveness. `wired`/`subscribed` are
      // true only because bootstrap called registerObservationWritePath() — never
      // hardcoded — and `rows` is read from the live table, so a broken schema
      // shows up as null. Visible at ac-validate without waiting for a reviewer
      // to reject something. `skippedByReason` names every silent failure the
      // old code swallowed.
      observations: getObservationWritePathState(),
      // AI-1857 AC3: rescue-sweep last-run visibility — "did it run" without log access.
      rescueSweep: getRescueSweepState(),
      // AI-2009 AC7: first-action watchdog liveness — scheduled + armedCount,
      // observable at ac-validate without waiting for a deadline breach.
      firstActionWatchdog: getFirstActionWatchdogState(),
      // AI-1848 (Pillar 2 D1): universal policy canon liveness — confirms
      // the canon file loaded and its version, observable at ac-validate
      // without waiting for a dispatch trigger.
      universalCanon: getCanonLiveness(),
      // AI-1849 (Pillar 2 D2): docs endpoint liveness — confirms /docs is registered.
      docs: getDocsLiveness(),
      // AI-1479 (Phase 6.5 / H-4): routing-functionary liveness — confirms the
      // department roster loaded at bootstrap and the functionary is active in
      // the live dispatch path (routeEventAll), observable at ac-validate without
      // waiting for a webhook to arrive.
      routingFunctionary: getRoutingFunctionaryLiveness(),
      // AI-1918: dispatch idempotency liveness — confirms the dedup/stale-guard
      // layer is active, observable at ac-validate without waiting for a real
      // duplicate event.
      dispatchIdempotency: {
        active: true,
        suppressedDuplicates: idempotencyStore.counters.suppressedDuplicates,
        droppedStale: idempotencyStore.counters.droppedStale,
        delegateChangeCleared: idempotencyStore.counters.delegateChangeCleared,
        ttlExpiredAdmits: idempotencyStore.counters.ttlExpiredAdmits,
      },
      // AI-1872: workflow registry liveness — exposes the loaded workflow defs
      // (id → {version, states}) so ac-validate can confirm the updated def
      // is live without waiting for a dispatch trigger.
      workflowRegistry: await getWorkflowRegistryLiveness(),
      // AI-1914 AC6: def-load state-migration liveness — confirms the migration
      // check ran on load (migratedCount 0 allowed), observable at ac-validate
      // without waiting for a def change.
      workflowMigrations: getDefStateMigrationLiveness(),
    });
  });

  // AI-1849 (Pillar 2 D2): docs endpoint — serves instance-config docs to
  // authenticated agents using their lpx proxy token (read-only, no admin secret).
  app.use("/docs", createGuidanceRouter());

  // OAuth callback — handles Linear app authorization flow
  // Both paths supported: /callback (legacy) and /oauth/callback (registered with Linear)
  app.get("/callback", handleOAuthCallback);
  app.get("/oauth/callback", handleOAuthCallback);

  // Webhook routes — pass the event store from the dedup module

  const eventStore = new EventStore();
  const nudgeStore = new NudgeStore();
  const operationalEventStore = new OperationalEventStore(options?.operationalEventsDbPath);
  const enrolledTicketsStore = new EnrolledTicketsStore(options?.enrolledTicketsDbPath);
  const mutationAuditStore = new MutationAuditStore(options?.mutationAuditDbPath);
  const idempotencyStore = new DispatchIdempotencyStore(options?.idempotencyDbPath);
  const agentQueue = new AgentQueue(options?.agentQueueDbPath);
  const bag = new PendingWorkBag(options?.bagDbPath);
  const wakeConfig = {
    nodeBin: process.execPath,
    hooksUrl: process.env.OPENCLAW_HOOKS_URL,
    hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
    hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
    hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
    timeoutMs: process.env.NODE_ENV === "test" ? 50 : undefined,
    maxRetries: process.env.NODE_ENV === "test" ? 0 : undefined,
  };
  const wakeConfigForAgent = (agentIdLookup: string): WakeUpConfig => {
    const cfg = getAgent(agentIdLookup);
    const rawToken = getAccessToken(agentIdLookup) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    const linearAuthToken = rawToken
      ? (/^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`)
      : undefined;
    return {
      ...wakeConfig,
      hooksUrl: cfg?.hooksUrl ?? wakeConfig.hooksUrl,
      hooksToken: cfg?.hooksToken ?? wakeConfig.hooksToken,
      linearAuthToken,
      // AI-2008: route every real workflow wake through the acknowledged
      // retry/loud-failure layer. Evaluated at dispatch time, so referencing the
      // scheduler declared below is safe.
      deliveryScheduler: dispatchDeliveryScheduler,
      gateway: cfg?.host ?? "local",
    };
  };
  const resignalOptions = {
    sendWakeUp: options?.sendWakeUp
      ? (agentId: string, ticketIds: string[]) => options.sendWakeUp!(agentId, ticketIds)
      : (agentId: string, ticketIds: string[]) => sendWakeUpSignal(agentId, ticketIds, wakeConfigForAgent(agentId)),
    // When a test sendWakeUp is provided, also bypass the Linear API routing check.
    ...(options?.sendWakeUp ? { isTicketActionable: () => true as boolean | Promise<boolean> } : {}),
  };
  const forensicsConfig: ForensicsConfig = {
    diagnosticsDir: process.env.STALE_SESSION_DIAGNOSTICS_DIR,
    openclawHome: process.env.OPENCLAW_HOME,
    loopThreshold: process.env.STALE_LOOP_THRESHOLD ? parseInt(process.env.STALE_LOOP_THRESHOLD, 10) : undefined,
    humanAssigneeLinearId: process.env.STALE_HUMAN_ASSIGNEE_LINEAR_ID,
  };

  /**
   * Process a single stale session: capture forensics, classify, recover ticket.
   */
  async function processStaleSession(stale: StaleSessionDetail): Promise<void> {
    log.warn(
      `Stale session: ${stale.agentId} [${stale.sessionKey}] ` +
      `(started ${Math.round((Date.now() - stale.startedAt) / 60_000)}min ago, timeout ${Math.round(stale.timeoutMs / 60_000)}min)`
    );

    // 1. Build forensic snapshot
    const snapshot = buildSnapshot(stale, forensicsConfig);

    // 2. Fetch current Linear ticket state for comparison
    const linearState = await fetchLinearTicketState(stale.sessionKey, stale.agentId);
    if (linearState) {
      snapshot.linearTicket.stateAtTimeout = linearState.state?.name ?? null;
      snapshot.linearTicket.commentCountAtTimeout = linearState.comments?.nodes?.length ?? 0;
    }

    // 3. Write snapshot to disk
    const diagPath = writeSnapshot(snapshot, forensicsConfig);
    snapshot.diagnosticPath = diagPath;

    // 4. Append to digest JSONL
    appendDigestEntry(snapshot, forensicsConfig);

    // 5. Log classification
    log.warn(
      `Stale session classified: ${stale.agentId} [${stale.sessionKey}] → ${snapshot.classification} (${STALE_CLASS_NAMES[snapshot.classification]})`
    );

    operationalEventStore.append({
      outcome: "stale-resignaled",
      agent: stale.agentId,
      key: stale.sessionKey,
      sessionKey: stale.sessionKey,
      deliveryMode: "stale-session-drain",
      attemptCount: stale.pendingTickets.length,
      detail: {
        classification: snapshot.classification,
        diagnosticPath: diagPath,
        toolCallCount: snapshot.toolCallSummary.totalCalls,
        stopReason: snapshot.lastAssistantMessage?.stopReason,
        errorCount: snapshot.errors.length,
      },
    });

    // 6. Recover the Linear ticket
    const recovery = await recoverTicket(snapshot, stale.agentId, forensicsConfig);
    if (!recovery.success) {
      log.error(`Recovery failed for ${stale.sessionKey}: ${recovery.detail}`);
    } else if (recovery.rePoke) {
      // AI-1578 (AC2): C4 first stall — recoverTicket retained the delegate and
      // changed no state. Re-wake the SAME delegate to resume + run its verb,
      // rather than letting the ticket sit orphaned.
      const ticketId = snapshot.metadata.ticketId;
      const sessionKey = normalizeSessionKey(ticketId);
      const rePokeMsg =
        `Your session for ${ticketId.replace(/^linear-/, "")} stalled before producing output. ` +
        `Resume now and run the pending transition verb to hand off. Do NOT reply HEARTBEAT_OK.`;
      log.info(`Stale C4 re-poke: re-waking ${stale.agentId} for ${ticketId}`);
      const delivered = await deliverMessageToAgent(stale.agentId, sessionKey, rePokeMsg, wakeConfigForAgent(stale.agentId));
      operationalEventStore.append({
        outcome: delivered.dispatched ? "stale-c4-repoke" : "stale-c4-repoke-failed",
        agent: stale.agentId,
        key: sessionKey,
        sessionKey,
        deliveryMode: "stale-c4-repoke",
        attemptCount: 1,
        errorSummary: delivered.dispatched ? null : "C4 re-poke delivery failed",
      });
    }

    // 7. Re-signal pending tickets (if any)
    if (stale.pendingTickets.length > 0) {
      log.info(`Stale session drain: re-signaling ${stale.agentId} for ${stale.pendingTickets.length} ticket(s)`);
      const sent = await resignalPendingTickets(stale.agentId, stale.pendingTickets, bag, sessionTracker, wakeConfigForAgent(stale.agentId), { markActive: true, ...resignalOptions });
      operationalEventStore.append({
        outcome: "stale-resignaled",
        agent: stale.agentId,
        key: stale.pendingTickets[0] ?? null,
        sessionKey: stale.pendingTickets[0] ?? null,
        deliveryMode: "stale-session-resignal",
        attemptCount: stale.pendingTickets.length,
        detail: { requested: stale.pendingTickets.length, sent },
      });
    }
  }

  const sessionTracker = new SessionTracker(undefined, async (staleSessions) => {
    for (const stale of staleSessions) {
      try {
        await processStaleSession(stale);
      } catch (err) {
        log.error(`Stale session processing failed for ${stale.agentId} [${stale.sessionKey}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  const throttle = new DeliveryThrottle();

  // ── v1.2: Dispatch acknowledgment tracking + early no-activity detection ──
  const ackTracker = new DispatchAckTracker(
    options?.bagDbPath ? path.join(path.dirname(options.bagDbPath), "dispatch-acks.db") : undefined,
  );

  // ── AI-2008: acknowledged dispatch delivery + bounded retry + loud failure ──
  // The armed front door every real workflow wake routes through (attached to
  // wakeConfigForAgent below). deliverWithAck records an outcome per attempt,
  // retries on failure, and emits a dispatch-undeliverable warning on
  // exhaustion — so no workflow dispatch remains fire-and-forget (AC1). Its
  // liveness feeds /health.dispatchDelivery; start() arms the driver and
  // registers it in the cron registry (AI-1808 dead-code-in-prod guard).
  const dispatchDeliveryScheduler = new DispatchDeliveryScheduler({
    eventStore: operationalEventStore,
    ackTracker,
  });
  dispatchDeliveryScheduler.start();

  /**
   * Post a comment on a Linear ticket via the GraphQL API.
   * Used by NoActivityDetector to notify when dispatches fail silently.
   */
  async function postLinearComment(agentId: string, ticketId: string, message: string): Promise<boolean> {
    const identifier = ticketId.replace(/^linear-/, "");
    // Steward token FIRST: these are system diagnostics about a failing agent.
    // Posting them with the agent's own token (a) attributes "manual
    // intervention required" to the agent it's about — live confusion on
    // AI-1759 — and (b) counts as agent-authored Linear activity, flipping
    // engagement and acknowledging the very dispatch being reported dead.
    // Agent token remains a fallback so a steward-token outage can't silence
    // the failure path. (Original bug here: $issueId declared ID! where
    // Linear expects String — every call 400'd silently until 2026-07-04.)
    const tokenCandidates: Array<{ source: string; token: string | undefined }> = [
      { source: "steward:astrid", token: getAccessToken("astrid") },
      { source: agentId, token: getAccessToken(agentId) },
      { source: "env", token: process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY },
    ];
    let lastError = "no Linear token available";
    for (const { source, token } of tokenCandidates) {
      if (!token) continue;
      const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
      try {
        const issueRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: authHeader },
          body: JSON.stringify({
            query: `query($id: String!) { issue(id: $id) { id } }`,
            variables: { id: identifier },
          }),
        });
        const issueBody = (await issueRes.json()) as {
          data?: { issue?: { id: string } | null };
          errors?: Array<{ message?: string }>;
        };
        const issueId = issueBody.data?.issue?.id;
        if (!issueId) {
          lastError = `issue lookup failed via ${source}: ${issueBody.errors?.[0]?.message ?? `no issue for '${identifier}'`}`;
          continue;
        }
        const commentRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: authHeader },
          body: JSON.stringify({
            query: `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`,
            variables: { issueId, body: message },
          }),
        });
        const commentBody = (await commentRes.json()) as {
          data?: { commentCreate?: { comment?: { id: string } | null } | null };
          errors?: Array<{ message?: string }>;
        };
        if (commentBody.data?.commentCreate?.comment?.id) return true;
        lastError = `commentCreate via ${source} returned ${commentRes.status}: ${commentBody.errors?.[0]?.message ?? "no comment id in response"}`;
      } catch (err) {
        lastError = `comment via ${source} threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // Never silent: a failure-path comment that can't post is itself a failure signal.
    log.error(`Linear comment failed for ${identifier}: ${lastError}`);
    try {
      operationalEventStore.append({
        outcome: "comment-post-failed",
        agent: agentId,
        key: normalizeSessionKey(ticketId),
        detail: { error: lastError.slice(0, 300) },
      });
    } catch { /* observability must not block */ }
    notify({
      severity: "warning",
      source: "dispatch",
      title: "failure-path Linear comment could not be posted",
      agent: agentId,
      ticket: ticketId,
      detail: lastError.slice(0, 300),
    });
    return false;
  }

  /**
   * AI-1510: drive the non-authoritative engagement-status overlay (To Do →
   * Thinking → Doing) using the delegate agent's vaulted token. Fire-and-forget;
   * fail-open inside the helper so a status flip never blocks dispatch/session-end.
   */
  function flipEngagementStatus(agentId: string, ticketId: string, semantic: "thinking" | "doing" | "todo"): void {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    const agentLinearUserId = getLinearUserIdForAgent(agentId);
    void applyEngagementStatus(ticketId, semantic, token, agentLinearUserId);
    const outcomeMap = { thinking: "engagement-thinking", doing: "engagement-doing", todo: "engagement-todo" } as const;
    try {
      operationalEventStore.append({
        outcome: outcomeMap[semantic],
        agent: agentId,
        key: normalizeSessionKey(ticketId),
        type: "engagement",
      });
    } catch {
      // fire-and-forget: never block on observability
    }
  }

  const watchdog = new DispatchWatchdog(
    { bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig, wakeConfigForAgent, resignalOptions },
  );
  watchdog.start();

  const noActivityDetector = new NoActivityDetector(
    { sessionTracker, ackTracker, bag, operationalEventStore, wakeConfig, wakeConfigForAgent, resignalOptions, postLinearComment, getFailMsForTicket: (_agentId: string, ticketId: string) => getTicketNoActivityTimeoutMs(ticketId) },
  );
  noActivityDetector.start();

  // ── Stuck-delegate detector (AI-1578 / AI-1451) ──────────────────────
  // Re-prompts delegates who posted a completion comment but never ran the
  // transition verb — the connector-native signal for "work landed but the
  // verb is missing" (the connector has no GitHub/PR awareness, so the
  // delegate's own completion comment is the observable "I'm done" signal).
  // Retains the delegate and re-pokes rather than orphaning. Per-agent wake
  // routing (wakeConfigForAgent) so containerized dev agents resolve their
  // own hooks endpoint.
  const stuckDelegateDetector = new StuckDelegateDetector({
    sessionTracker,
    bag,
    ackTracker,
    operationalEventStore,
    deliveryConfig: wakeConfig,
    sendWake: async (agentOpenclawName, ticketId, prompt) => {
      const result = await deliverMessageToAgent(
        agentOpenclawName,
        normalizeSessionKey(ticketId),
        prompt,
        wakeConfigForAgent(agentOpenclawName),
      );
      return result.dispatched;
    },
  });
  stuckDelegateDetector.start();

  // ── AI-1533: Hold-retry tracker ──────────────────────────────────────
  // Detects sessions that end gracefully without a state-advancing transition
  // (transient-error holds) and re-dispatches them within a bounded grace window.
  const holdRetryTracker = new HoldRetryTracker();

  // ── Managing-state stewardship poller ────────────────────────────────
  // Wakes agents on a cadence to review Managing-state tickets (parent /
  // externally-blocked work the agent has claimed responsibility for but
  // can't push forward right now). Per-ticket interval is set via a
  // `Managing-interval: <duration>` marker in the issue description;
  // default is 30 minutes.
  const managingStateStore = new ManagingStateStore(options?.managingStateDbPath);
  const managingPoller = new ManagingPoller({
    store: managingStateStore,
    operationalEventStore,
    resolveDeliveryConfig: wakeConfigForAgent,
  });
  managingPoller.start();

  // Operator nudge endpoint — sends a short instruction into an already-active
  // agent session. Phase 1 is local/Nakazawa only; no cross-gateway routing.
  app.post("/nudge", async (req: express.Request, res: express.Response) => {
    if (!requireAdminSecret(req, res)) return;

    let body: { agent?: string; ticketId?: string; message?: string } | null;
    try {
      body = parseJsonBody(req);
    } catch {
      res.status(400).json({ success: false, error: "Malformed JSON" });
      return;
    }

    const requestedAgent = body?.agent?.trim();
    const ticketId = body?.ticketId?.trim();
    if (!requestedAgent || !ticketId) {
      res.status(400).json({ success: false, error: "agent and ticketId are required" });
      return;
    }

    const agentConfig = getAgents().find((agent) =>
      agent.name === requestedAgent || agent.openclawAgent === requestedAgent,
    );
    const candidates = [...new Set([
      requestedAgent,
      agentConfig?.name,
      agentConfig?.openclawAgent,
    ].filter((value): value is string => Boolean(value)))];
    const activeAgent = candidates.find((agentId) => sessionTracker.isActive(agentId));
    if (!activeAgent) {
      res.status(404).json({ success: false, error: "No active session found" });
      return;
    }

    const sessionId = sessionTracker.getActiveSessionKey(activeAgent);
    if (!sessionId) {
      res.status(404).json({ success: false, error: "No active session found" });
      return;
    }

    const normalizedTicketId = normalizeSessionKey(ticketId).replace(/^linear-/, "");
    const message = body?.message?.trim() ||
      `Recheck ${normalizedTicketId} and continue work. Run linear consider-work ${normalizedTicketId}.`;
    const delivered = await deliverMessageToAgent(activeAgent, sessionId, message, wakeConfig);
    operationalEventStore.append({
      outcome: delivered ? "delivered" : "delivery-failed",
      type: "operator-nudge",
      agent: activeAgent,
      key: normalizeSessionKey(ticketId),
      sessionKey: sessionId,
      deliveryMode: "operator-nudge",
      attemptCount: 1,
      errorSummary: delivered ? null : "Nudge delivery failed",
    });
    if (!delivered) {
      res.status(502).json({ success: false, error: "Nudge delivery failed" });
      return;
    }
    res.json({ success: true, sessionId, agent: activeAgent });
  });

  // ── AC1 (AI-1560): Pull-pickup engagement endpoints ──────────────────────
  // Agents that claim work via `linear queue --next` (self-pull) never go
  // through the connector's dispatch path, so the Thinking/Doing hooks never
  // fire. These endpoints let the agent signal the same lifecycle as a
  // connector-dispatched ticket.
  //
  // POST /pull-ack   — agent read/claimed the ticket → Thinking
  // POST /pull-ack-activity — agent authored first activity → Doing

  function parsePullBody(req: express.Request, res: express.Response): { agentId: string; ticketId: string } | null {
    let body: { agentId?: string; ticketId?: string } | null;
    try {
      body = parseJsonBody(req);
    } catch {
      res.status(400).json({ error: "Malformed JSON" });
      return null;
    }
    if (!body?.agentId || !body?.ticketId) {
      res.status(400).json({ error: "agentId and ticketId are required" });
      return null;
    }
    return { agentId: body.agentId, ticketId: body.ticketId };
  }

  app.post("/pull-ack", (req: express.Request, res: express.Response) => {
    const secret = process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-session-end-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    const parsed = parsePullBody(req, res);
    if (!parsed) return;
    const { agentId, ticketId } = parsed;
    ackTracker.recordDispatch(agentId, ticketId);
    flipEngagementStatus(agentId, ticketId, "thinking");
    res.json({ ok: true });
  });

  app.post("/pull-ack-activity", (req: express.Request, res: express.Response) => {
    const secret = process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-session-end-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    const parsed = parsePullBody(req, res);
    if (!parsed) return;
    const { agentId, ticketId } = parsed;
    ackTracker.acknowledge(agentId, ticketId);
    flipEngagementStatus(agentId, ticketId, "doing");
    res.json({ ok: true });
  });

  // Management console (Phase 3): React SPA + JSON API, session or secret auth.
  app.use("/admin", createAdminRouter({ agentQueue, bag, sessionTracker, operationalEventStore, observationStore, ackTracker, deploymentName: DEPLOYMENT_NAME, enrolledTicketsStore, forensicsDiagnosticsDir: options?.forensicsDiagnosticsDir, mutationAuditStore, wakeConfigForAgent }));

  app.use("/", createWebhookRouter(
    eventStore,
    nudgeStore,
    agentQueue,
    bag,
    sessionTracker,
    throttle,
    operationalEventStore,
    (agentId, ticketId) => {
      ackTracker.recordDispatch(agentId, ticketId);
      // AI-1510: agent has read the ticket via the connector → Thinking.
      flipEngagementStatus(agentId, ticketId, "thinking");
    },
    (agentId, ticketId) => {
      const acknowledged = ackTracker.acknowledge(agentId, ticketId);
      if (acknowledged > 0) {
        noActivityDetector.clearWarned(agentId, ticketId);
      }
      // AI-1533: mark transition seen so session-end won't hold-retry this ticket.
      holdRetryTracker.recordTransition(agentId, ticketId);
      // AI-1510: agent authored Linear activity → actively working → Doing.
      flipEngagementStatus(agentId, ticketId, "doing");
    },
    // AI-1538: register a pending dispatch expectation at delivery-commit so a
    // swallowed delivery self-heals via the watchdog.
    (agentId, ticketId) => ackTracker.ensurePending(agentId, ticketId),
    enrolledTicketsStore,
    mutationAuditStore,
    idempotencyStore,
  ));

  // ── v1.1: Session-end callback endpoint ──────────────────────────────
  // The gateway (via plugin) calls this when an agent's session ends.
  // The connector then checks the bag and sends another wake-up if needed.
  // Auth: x-session-end-secret header must match SESSION_END_SECRET env.
  app.post("/session-end", async (req: express.Request, res: express.Response) => {
    // Auth check — shared secret via constant-time compare
    const secret = process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-session-end-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    } else {
      log.warn("SESSION_END_SECRET not set — /session-end is unauthenticated (set env var for production)");
    }

    // Parse body — parent express.raw() middleware captures it as Buffer
    let body: { agentId?: string };
    try {
      if (Buffer.isBuffer(req.body)) {
        body = JSON.parse(req.body.toString("utf8"));
      } else if (typeof req.body === "object" && req.body !== null) {
        body = req.body;
      } else {
        res.status(400).json({ error: "Invalid body" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Malformed JSON" });
      return;
    }

    const { agentId } = body;
    if (!agentId) {
      res.status(400).json({ error: "agentId is required" });
      return;
    }
    log.info(`Session-end callback received for ${agentId}`);
    // AI-1510: capture the agent's active ticket keys BEFORE endSession clears
    // them, so we can reset native status → To Do for each ticket the agent is
    // releasing. (This handler ends ALL of the agent's sessions.)
    const endedKeys = sessionTracker.getActiveSessionKeys(agentId);

    // AI-1533: Identify hold-retry candidates BEFORE acknowledging dispatches so
    // we can still read dispatch ages from the ackTracker.
    // A "hold" is a session that ended gracefully with no state-advancing transition.
    // We re-dispatch these once (up to maxAttempts) so transient errors self-heal.
    const pendingAckEntries = ackTracker.getPendingTimedOut(0);
    const dispatchAgeByTicket = new Map<string, number>(
      pendingAckEntries
        .filter((e) => e.agentId === agentId)
        .map((e) => [
          e.ticketId,
          Date.now() - new Date(e.dispatchedAt.replace(" ", "T") + "Z").getTime(),
        ]),
    );
    const holdCandidates = endedKeys.filter((key) => {
      const normalizedKey = normalizeSessionKey(key);
      const dispatchAge = dispatchAgeByTicket.get(normalizedKey);
      // If there's no ack entry for this session, it wasn't a tracked dispatch — skip.
      if (dispatchAge === undefined) return false;
      return holdRetryTracker.shouldRetryHold(agentId, normalizedKey, dispatchAge);
    });
    // Update hold-retry state for all ended sessions.
    for (const key of endedKeys) {
      const normalizedKey = normalizeSessionKey(key);
      if (holdRetryTracker.hasTransition(agentId, normalizedKey)) {
        // Healthy run: transition was seen — reset attempt count for the next dispatch.
        holdRetryTracker.clearTicket(agentId, normalizedKey);
      } else {
        // Hold or no-dispatch: clear only the transition flag; preserve attempt count.
        holdRetryTracker.clearTransition(agentId, normalizedKey);
      }
    }

    const queuedTickets = sessionTracker.endSession(agentId);
    // Reset engagement status to To Do for each released ticket — but only if no
    // successor (post-handoff delegate) already holds it. Handoff dispatches the
    // successor's startSession synchronously, so this guard is reliable.
    for (const key of endedKeys) {
      if (!sessionTracker.isTicketActiveForAnyAgent(key, agentId)) {
        flipEngagementStatus(agentId, key, "todo");
      }
    }
    // Re-arm any tickets that were deferred because the agent was at capacity.
    noActivityDetector.checkDeferredOnSessionEnd(agentId).catch((err) => {
      log.error(`checkDeferredOnSessionEnd failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Acknowledge dispatches for this agent — the session completed (even briefly).
    ackTracker.acknowledge(agentId);
    // Clear no-activity warnings for any sessions that just ended.
    noActivityDetector.clearWarned(agentId, "*");
    // Also drain any dispatched-but-unconfirmed bag entries for this agent.
    // These were dispatched on HTTP 200 but not confirmed as processed.
    const bagTickets = bag.getPendingTickets(agentId).map(e => e.ticketId);
    if (bagTickets.length > 0) bag.clearAgent(agentId);
    // Normalize queued tickets so dedup works correctly vs already-normalized bag IDs.
    const queuedNormalized = (queuedTickets ?? []).map(t => normalizeSessionKey(t));
    const regularPending = [...new Set([...queuedNormalized, ...bagTickets])];

    // AI-1533: Compute hold-retry tickets that aren't already in regular pending.
    const holdIds = holdCandidates.map((key) => normalizeSessionKey(key));
    const newHoldIds = holdIds.filter((id) => !regularPending.includes(id));
    if (newHoldIds.length > 0) {
      for (const holdId of newHoldIds) {
        const attempt = holdRetryTracker.incrementHoldAttempt(agentId, holdId);
        log.info(
          `[hold-retry] Re-dispatching ${agentId} [${holdId}] after graceful hold ` +
          `(attempt ${attempt}/${holdRetryTracker.config.maxAttempts})`,
        );
        operationalEventStore.append({
          outcome: "hold-retry-dispatch",
          agent: agentId,
          key: holdId,
          sessionKey: holdId,
          deliveryMode: "hold-retry",
          attemptCount: attempt,
          detail: { maxAttempts: holdRetryTracker.config.maxAttempts },
        });
      }
    }

    // AI-1574: drain nudge-store coalesced events that were suppressed inside the
    // dedup window of the session that just ended. These are state-transition
    // dispatches (e.g. review→filing for the same delegate) that arrived while
    // the prior session was still within the 120s coalesce window. The session
    // ended before the window expired, so they were never re-fired. Clear the
    // nudge record so the re-signal below goes through without hitting the window.
    const coalescedTickets = nudgeStore
      ? nudgeStore.getCoalescedTickets(agentId)
          .filter((t) => !regularPending.includes(t) && !newHoldIds.includes(t))
      : [];
    for (const t of coalescedTickets) {
      nudgeStore!.clearNudge(agentId, t);
      log.info(`Session-end: clearing coalesced nudge for ${agentId} [${t}] — will re-signal`);
    }

    const allPending = [...new Set([...regularPending, ...newHoldIds, ...coalescedTickets])];
    operationalEventStore.append({
      outcome: "session-ended", agent: agentId, deliveryMode: "session-end-callback",
      detail: { queuedTickets: queuedTickets ?? [], bagTickets, regularPending, holdRetry: newHoldIds, coalescedTickets, allPending }
    });

    if (regularPending.length > 0) {
      // Re-signal: agent has work waiting. Send one signal per ticket so each
      // issue is delivered into its own canonical per-ticket session key.
      try {
        await resignalPendingTickets(agentId, regularPending, bag, sessionTracker, wakeConfigForAgent(agentId), { markActive: true, ...resignalOptions });
      } catch (err) {
        log.error(`Session-end re-signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (newHoldIds.length > 0) {
      // Re-dispatch hold-retry tickets with ack tracking so the watchdog monitors them.
      try {
        await resignalPendingTickets(agentId, newHoldIds, bag, sessionTracker, wakeConfigForAgent(agentId), {
          markActive: true,
          ...resignalOptions,
          onDispatched: (aid, tid) => ackTracker.recordDispatch(aid, tid),
        });
      } catch (err) {
        log.error(`Session-end hold-retry re-signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    res.json({ ok: true, pendingTickets: allPending.length });
  });

  // ── v1.1: Metrics endpoint ───────────────────────────────────────────
  // Auth: x-metrics-secret header must match METRICS_SECRET env.
  // Falls back to SESSION_END_SECRET if METRICS_SECRET is not set.
  app.get("/metrics", (req: express.Request, res: express.Response) => {
    const secret = process.env.METRICS_SECRET ?? process.env.SESSION_END_SECRET;
    if (secret) {
      const header = req.headers["x-metrics-secret"];
      if (typeof header !== "string" || !verifySecret(header, secret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    } else {
      log.warn("METRICS_SECRET not set — /metrics is unauthenticated (set env var for production)");
    }
    const activeSessions = sessionTracker.getActiveAgents();
    res.json({
      bag: bag.getStats(),
      agentStats: bag.getAgentStats(),
      activeSessions,
      activeSessionDetails: activeSessions.map((agentId) => sessionTracker.getActiveSessionInfo(agentId)),
    });
  });

  // AI-1914 AC1/AC6: def-load state-migration runner. On boot, auto-migrate any
  // governed ticket stranded at a removed state per its def's `migrations` map
  // (label swap + re-dispatch to the target owner). Registered here so it is
  // reachable from the production entry point (createApp), with load-time
  // liveness surfaced at /health.workflowMigrations. Fetches nothing unless a
  // registered def actually declares a migration map.
  const migrationAuthToken =
    getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const migrationWakeFn = async (agentName: string, ticketIdentifier: string) => {
    const sessionKey = normalizeSessionKey(ticketIdentifier);
    const agentCfg = getAgent(agentName);
    const deliveryConfig: DeliveryConfig = {
      nodeBin: process.execPath,
      hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
      hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
      hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
      hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
    };
    const actionText = `${ticketIdentifier} was migrated to a new workflow state (its previous state was removed by a def change)`;
    const message =
      (await buildWorkflowAwareDeliveryMessage(ticketIdentifier, migrationAuthToken, actionText)) ??
      actionText;
    await deliverMessageToAgent(agentName, sessionKey, message, deliveryConfig);
  };
  registerDefStateMigrationRunner({
    authToken: migrationAuthToken,
    loadRegistry: () => loadWorkflowRegistry(),
    operationalEventStore,
    wakeFn: migrationWakeFn,
  });

  return { app, agentQueue, bag, sessionTracker, operationalEventStore, enrolledTicketsStore, observationStore, wakeConfig, wakeConfigForAgent, resignalOptions, ackTracker, dispatchDeliveryScheduler, watchdog, noActivityDetector, holdRetryTracker, managingPoller, managingStateStore, mutationAuditStore, idempotencyStore };
}

/**
 * Recover queue backlog left behind by prior process state. For each agent
 * with active or queued items, walk the queue via complete() in a loop —
 * each call marks the active row completed and promotes the next queued.
 * Items are delivered as they're promoted. Errors per item are logged and
 * the drain continues so one bad item can't strand the rest.
 */
async function drainBacklog(agentQueue: AgentQueue): Promise<void> {
  const agents = agentQueue.agentsWithBacklog();
  if (agents.length === 0) {
    log.info("Startup drain: no backlog to recover.");
    return;
  }
  const deliveryConfig = {
    nodeBin: process.execPath,
    hooksUrl: process.env.OPENCLAW_HOOKS_URL,
    hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
    hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
    hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
  };
  log.info(`Startup drain: recovering backlog for ${agents.length} agent(s): ${agents.join(", ")}`);
  for (const agentId of agents) {
    let drained = 0;
    let next = agentQueue.complete(agentId);
    while (next) {
      log.info(`Startup drain: delivering recovered task for ${agentId} [${next.sessionKey}]`);
      try {
        await deliverToAgent(next, deliveryConfig);
      } catch (err) {
        log.error(`Startup drain: delivery failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      drained++;
      next = agentQueue.complete(agentId);
    }
    log.info(`Startup drain: ${agentId} drained ${drained} task(s).`);
  }
}

// Only start listening when this file is the entry point, not when imported by tests
const isEntryPoint = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isEntryPoint) {
  const agents = getAgents();

  // AI-1767: Empty-roster startup guard. The v1.5.0 Docker deploy booted
  // with 0 of 28 agents (misconfigured AGENTS_FILE mount) and silently served
  // 401s + dropped webhooks fleet-wide. An empty roster is never a valid
  // operating state — refuse to start so a broken deploy fails loudly and
  // the orchestrizer (systemd / Docker restart policy) doesn't keep reviving
  // a zombie instance.
  if (agents.length === 0) {
    const agentsPath = process.env.AGENTS_FILE ?? path.resolve(process.cwd(), "agents.json");
    const msg = `Fatal: agent roster is empty (AGENTS_FILE=${agentsPath}). Refusing to start — check that the agents file exists and is mounted correctly.`;
    log.error(msg);
    notify({
      severity: "critical",
      source: "agents",
      title: "Connector refusing to start — empty agent roster",
      detail: msg,
      dedupKey: "agents|empty-roster",
    });
    process.exit(1);
  }

  log.info(`Starting connector [${DEPLOYMENT_NAME}] with ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ")}`);

  // AI-1848 (Pillar 2 D1): load the universal policy canon at bootstrap so
  // /health can report liveness immediately (fail-open: missing file is a
  // WARN, not a crash). The file is re-read per-dispatch for hot-reload.
  await loadUniversalCanon();

  // AI-1479 (Phase 6.5 / H-4): load the department roster at bootstrap so the
  // routing functionary is active in the live dispatch path (routeEventAll) and
  // /health can report liveness immediately (fail-open: a missing/broken roster
  // is a WARN and leaves mechanical routing + no-route paging untouched).
  await loadRoster();

  // Watch agents.json for external changes — no restart needed to add agents
  watchAgentsFile();

  // Phase 2 (rebuild): assert agents.json ⇄ capability-policy agreement at
  // startup and on every registry hot-reload. Drift alerts, never crashes.
  startRegistryPolicyCheck();

  // Start token refresh for all configured agents
  if (agents.length > 0) {
    startTokenRefresh();
  }

  const { app, agentQueue, bag, sessionTracker, operationalEventStore, observationStore, wakeConfig, wakeConfigForAgent, resignalOptions, ackTracker, watchdog, noActivityDetector, mutationAuditStore, enrolledTicketsStore, idempotencyStore } = createApp();

  // P4-3: periodic distillation of reject metrics into skill-workshop proposals
  registerDistillationCron(observationStore);
  // AI-1566: periodic rescue sweep — detect and repair dormant/malformed wf:* tickets
  registerRescueSweepCron();

  // AI-1775: periodic reconciliation sweep — heal wf:* tickets that never
  // enrolled (dropped Issue-update webhook). Safety net for the bootstrap path.
  // The wakeFn delivers a workflow-aware wake to the healed delegate via the
  // same delivery primitive the webhook bootstrap path uses (buildWorkflowAware
  // DeliveryMessage + deliverMessageToAgent), so a healed ticket is not just
  // labeled-and-delegated but actually surfaced to its owner.
  const reconciliationAuthToken =
    getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const reconciliationWakeFn = async (agentName: string, ticketIdentifier: string) => {
    const sessionKey = normalizeSessionKey(ticketIdentifier);
    const agentCfg = getAgent(agentName);
    const deliveryConfig: DeliveryConfig = {
      nodeBin: process.execPath,
      hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
      hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
      hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
      hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
    };
    const actionText = `You were delegated ${ticketIdentifier}`;
    const message =
      (await buildWorkflowAwareDeliveryMessage(ticketIdentifier, reconciliationAuthToken, actionText)) ??
      actionText;
    await deliverMessageToAgent(agentName, sessionKey, message, deliveryConfig);
  };

  registerBootstrapReconciliationCron({
    authToken: reconciliationAuthToken,
    wakeFn: reconciliationWakeFn,
  });

  // AI-1807: delegation reconciliation sweep — detect and heal stranded
  // delegation wakes caused by webhook-ingress gaps. Complements AI-1775
  // (bootstrap sweep) and the rescue/stuck-delegate/no-activity detectors.
  registerDelegationReconciliationCron({
    authToken: reconciliationAuthToken,
    operationalEventStore,
    wakeFn: reconciliationWakeFn,
  });

  // AI-2009: first-action watchdog — arm a per-state deadline at dispatch
  // delivery and, on breach, walk the remediation ladder (re-dispatch →
  // unreachable + ops alert → optional capability-policy re-route). Unlike the
  // reconciliation sweeps above (which heal broken ticket SHAPE — lost delegate,
  // drifted labels), this catches well-formed dispatches that were delivered to
  // the right owner and then simply sat: the wake that never landed, the agent
  // that bounced, the revision round-trip that was dropped.
  //
  // The data plane is derived from the durable enrolled-tickets mirror
  // (delegate/state/entered-at) cross-referenced with the operational event
  // store (first visible owner action). Registered here at bootstrap so it is
  // reachable from the production entry point (AI-1810 registry ⇒ /health.crons).
  const firstActionCapabilityPolicy = await getCapabilityPolicy()
    .then((p) => ({ bodies: p.bodies, roles: p.roles }))
    .catch(() => undefined);
  const firstActionAgentNames = new Set(getAgents().map((a) => a.name.toLowerCase()));
  registerFirstActionWatchdogCron({
    authToken: reconciliationAuthToken,
    workflowDefPath: process.env.WORKFLOW_DEFS_DIR ?? process.env.WORKFLOW_DEF_DIR,
    capabilityPolicy: firstActionCapabilityPolicy,
    listTickets: async () => {
      const rows = enrolledTicketsStore.getAll();
      return rows
        .filter((row) => row.terminal !== 1 && row.state && row.state !== "done")
        .map((row) => {
          const delegate = row.delegate ?? "";
          // Only AI agents in the roster are watched; a null delegate or a
          // non-roster (human) assignee is excluded from nudging (AC3).
          const humanAssigned = !delegate || !firstActionAgentNames.has(delegate.toLowerCase());
          const deliveredMs = Date.parse(row.entered_state_at);
          // First visible owner action: earliest operational event authored by
          // the delegate at/after the ticket entered its current state.
          let firstOwnerActionAtMs: number | null = null;
          if (delegate) {
            const events = operationalEventStore.query({
              key: `linear-${row.ticket_id}`,
              since: row.entered_state_at,
              limit: 200,
            });
            const actionTimes = events
              .filter((e) => e.agent && e.agent.toLowerCase() === delegate.toLowerCase())
              .map((e) => Date.parse(e.occurredAt))
              .filter((ms) => Number.isFinite(ms));
            if (actionTimes.length > 0) firstOwnerActionAtMs = Math.min(...actionTimes);
          }
          return {
            ticket: row.ticket_id,
            workflow: row.workflow,
            state: row.state,
            delegate,
            humanAssigned,
            labels: [`wf:${row.workflow}`, `state:${row.state}`],
            dispatchDeliveredAtMs: Number.isFinite(deliveredMs) ? deliveredMs : Date.now(),
            dispatchUpdatedAt: row.entered_state_at,
            firstOwnerActionAtMs,
          };
        });
    },
    // Rung 1: a genuine fresh wake. Clear the idempotency rows for (ticket,
    // agent) so the re-dispatch is admitted rather than swallowed as a
    // duplicate (AI-1969 admit semantics), then deliver via the same primitive
    // the reconciliation sweeps use.
    redispatch: async ({ ticket, agent }) => {
      try {
        idempotencyStore.clearAgentRows(`linear-${ticket}`, agent);
      } catch {
        /* best-effort — a missing row must not block the wake */
      }
      await reconciliationWakeFn(agent, ticket);
      return { admitted: true };
    },
    // On breach, verify the mirror row against authoritative Linear state
    // before firing any rung. Done/canceled/deleted/demoted tickets are healed
    // in the mirror and their ladders dropped — a stale row must never surface
    // as "delegate unreachable". A live ticket whose state label drifted from
    // the mirror is corrected; the fresh entered_state_at re-arms a clean
    // ladder on the next sweep.
    crossCheck: async (t) => {
      const query = `query($id: String!) { issue(id: $id) { id state { type } labels { nodes { name } } } }`;
      let issue: { state?: { type?: string } | null; labels?: { nodes?: Array<{ name: string }> } } | null;
      try {
        const res = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: reconciliationAuthToken },
          body: JSON.stringify({ query, variables: { id: t.ticket } }),
        });
        const data = (await res.json()) as { data?: { issue?: typeof issue } };
        if (data.data === undefined) return "unknown"; // auth/transport error — fail open
        issue = data.data?.issue ?? null;
      } catch {
        return "unknown";
      }
      if (!issue) {
        enrolledTicketsStore.markTerminal(t.ticket, "watchdog-crosscheck-deleted");
        return "stale";
      }
      const labels = issue.labels?.nodes ?? [];
      const stateType = issue.state?.type;
      const stateLabel = labels.find((l) => l.name.startsWith("state:"))?.name.slice("state:".length);
      if (stateType === "completed" || stateType === "canceled" || stateLabel === "done") {
        enrolledTicketsStore.markTerminal(t.ticket, "watchdog-crosscheck-terminal");
        return "stale";
      }
      if (!labels.some((l) => l.name.startsWith("wf:"))) {
        enrolledTicketsStore.demoteEnrolled(t.ticket);
        return "stale";
      }
      if (stateLabel && stateLabel !== t.state) {
        enrolledTicketsStore.recordTransition({
          ticketId: t.ticket,
          toState: stateLabel,
          delegate: t.delegate,
          eventKind: "watchdog-reconciled",
        });
        return "stale";
      }
      return "live";
    },
    // Rung 2: alert the ops channel with ticket/state/delegate for the on-call.
    notify: (alert) =>
      notify({
        severity: "warning",
        source: "first-action-watchdog",
        title: alert.title,
        detail: `${alert.ticket} (${alert.state}) — delegate ${alert.delegate} unreachable after ${alert.rungsFired} rung(s)`,
        dedupKey: `first-action-watchdog|${alert.ticket}|${alert.state}`,
      }),
    // Rung 3: re-route to the fallback body by waking it directly. The delegate
    // reassignment itself is left to the steward — the ladder never mutates
    // workflow state — but the fallback body is surfaced immediately.
    reroute: async ({ ticket, toAgent }) => {
      await reconciliationWakeFn(toAgent, ticket);
    },
  });

  // AI-1807 AC5: POST /redispatch — on-demand delegation reconciliation.
  // ADMIN_SECRET-gated. Supports single-ticket and time-window batch modes.
  app.post("/redispatch", async (req: express.Request, res: express.Response) => {
    if (!requireAdminSecret(req, res)) return;

    let body: { ticketId?: string | string[]; since?: string; until?: string } | null;
    try {
      body = parseJsonBody(req);
    } catch {
      res.status(400).json({ success: false, error: "Malformed JSON" });
      return;
    }

    // Parse ticket identifiers: single string or array
    let ticketIdentifiers: string[] | undefined;
    if (body?.ticketId) {
      ticketIdentifiers = Array.isArray(body.ticketId)
        ? body.ticketId.map(String)
        : [String(body.ticketId)];
    }

    try {
      const result = await runDelegationReconciliationSweep({
        authToken: reconciliationAuthToken,
        operationalEventStore,
        alertBus: getAlertBus(),
        wakeFn: reconciliationWakeFn,
        ticketIdentifiers,
        since: body?.since,
        until: body?.until,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // AI-1773: periodic SLA sweep — detect governed tickets whose time in
  // their current state exceeds the per-state `sla:` value. Emits a
  // warning-level alert + steward wake per new breach (deduped via SQLite).
  // Managed children are excluded (barrier.ts predicate owns them).
  const defaultWorkflowDefPath = "config/workflows.yaml";
  const slaWorkflowDefPath = process.env.WORKFLOW_DEFS_DIR ?? process.env.WORKFLOW_DEF_PATH ?? defaultWorkflowDefPath;
  const slaDataDir = process.env.DATA_DIR ?? "data";
  const slaBreachStorePath = process.env.SLA_BREACH_STORE_PATH ?? path.join(slaDataDir, "sla-breaches.db");
  const slaAuthToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const slaCadenceMs = process.env.SLA_SWEEP_CADENCE_MS ? parseInt(process.env.SLA_SWEEP_CADENCE_MS, 10) : undefined;

  if (slaAuthToken) {
    const slaWakeAgent = async (identifier: string) => {
      const sessionKey = normalizeSessionKey(identifier);
      const agentCfg = getAgent("ai");
      const deliveryConfig: DeliveryConfig = {
        nodeBin: process.execPath,
        hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
        hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
        hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
        hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
      };
      const actionText = `SLA breach detected for ${identifier}`;
      const message =
        (await buildWorkflowAwareDeliveryMessage(identifier, slaAuthToken, actionText)) ??
        actionText;
      await deliverMessageToAgent("ai", sessionKey, message, deliveryConfig);
    };

    const slaTimer = registerSlaSweepCron({
      authToken: slaAuthToken,
      workflowDefPath: slaWorkflowDefPath,
      breachStorePath: slaBreachStorePath,
      cadenceMs: slaCadenceMs,
      notify: (alert) =>
        notify({
          ...alert,
          severity: alert.severity as AlertSeverity,
          dedupKey: `sla-sweep|${alert.ticket}`,
        }),
      wakeAgent: slaWakeAgent,
    });
    log.info(`AI-1773: SLA sweep cron registered (cadence=${slaCadenceMs ?? 300_000}ms, store=${slaBreachStorePath}, defs=${slaWorkflowDefPath})`);
  } else {
    log.warn("AI-1773: SLA sweep cron NOT registered — no Linear auth token available");
  }

  // G-20: scheduled gate-silently-off canary (AI-1552, §5.1)
  registerG20CanaryCron();

  // AI-1838: out-of-band mutation reconcile sweep. Detects state/label/delegate
  // changes that bypassed the proxy gate (raw token → api.linear.app direct).
  registerOobReconcileCron(mutationAuditStore, operationalEventStore);

  // Config-health healthy→unhealthy is the loudest structural signal we have
  // (bad policy/workflow/agents.json = engine fail-closed for workflow tickets).
  onConfigHealthAlert((status) => {
    const failing = Object.values(status.artifacts)
      .filter((artifact) => !artifact.healthy)
      .map((artifact) => `${artifact.kind}: ${artifact.lastError ?? "unhealthy"}`)
      .join("; ");
    notify({
      severity: "critical",
      source: "config-health",
      title: "config artifact unhealthy — engine is fail-closed for workflow tickets",
      detail: failing || undefined,
      dedupKey: "config-health|unhealthy",
    });
  });

  // Crash-path visibility. Behavior is unchanged (uncaught exceptions still
  // terminate; systemd restarts us) — we just make the death rattle audible.
  process.on("uncaughtException", (err) => {
    notify({ severity: "critical", source: "process", title: "uncaughtException — connector is going down", detail: err.stack ?? err.message });
    log.error(`uncaughtException: ${err.stack ?? err.message}`);
    setTimeout(() => process.exit(1), 2000).unref();
  });
  process.on("unhandledRejection", (reason) => {
    notify({ severity: "critical", source: "process", title: "unhandledRejection", detail: String(reason instanceof Error ? reason.stack : reason) });
    log.error(`unhandledRejection: ${String(reason)}`);
  });

  const server = app.listen(PORT, () => {
    log.info(`fancy-openclaw-linear-connector [${DEPLOYMENT_NAME}] listening on port ${PORT} (pid=${process.pid})`);
    // Startup alert (warning → pushes): restart audit trail, deploy
    // verification, and crash-loop indicator (repeat bursts fold + count).
    // AI-1841: prefer the dist/DEPLOY_COMMIT stamp over git HEAD — the shared
    // working tree may be on a feature branch and its HEAD is not what runs.
    resolveStartupCommit().then(({ commit, source }) => {
      setStartupCommit(commit);
      notify({
        severity: "warning",
        source: "lifecycle",
        title: `connector started — commit ${commit} (${source}), ${getAgents().length} agents, port ${PORT}`,
        dedupKey: "lifecycle|startup",
      });
    });
    // Recover any backlog left behind by prior process state (v1.0 queue).
    drainBacklog(agentQueue).catch((err) => {
      log.error(`Startup drain failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Replay persisted pending-bag work left behind by a prior process restart.
    replayPendingBag(bag, sessionTracker, wakeConfig, operationalEventStore, {
      ...resignalOptions,
      wakeConfigForAgent,
      onDispatched: (agentId, ticketId) => ackTracker.recordDispatch(agentId, ticketId),
    }).catch((err) => {
      log.error(`Startup replay failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // Graceful shutdown — drain in-flight connections before exit
  function shutdown(signal: string) {
    log.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      log.info("Server closed. Exiting.");
      process.exit(0);
    });
    // Force exit after 8s if drain stalls (systemd SendSIGKILL fires at 10s)
    setTimeout(() => {
      log.warn("Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 8000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
