/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement) + Phase 3 B1 (workflow-def-driven validation)
 * + Phase 3 B2 (atomic state-label transition application)
 * + Layer 2 raw mutation interception (AI-1387)
 * + AI-1402 default-deny + needs-human block + unknown-caller fail-closed,
 * design.md §4.2, §4.6, §11, §13, §16.
 * + Phase 6.5 / H-1 fail-closed + break-glass + config-health (AI-1476).
 *
 * Enforcement order (defense in depth):
 *   1. Phase 2 escalation-gate — capability rule table (needs-human steward-only).
 *   2. Phase 3 B1 workflow-gate — full legal-move validation against dev-impl.yaml,
 *      including delegate-only enforcement (AI-1397).
 *   3. Layer 2 raw mutation interception (AI-1387) — blocks direct status/assignee
 *      changes on workflow tickets that bypass the intent-header path.
 *   4. Phase 6.5 config-health — rejects wf:* commands when config is degraded (§16.0).
 * All must pass for the request to be forwarded.
 *
 * Break-glass (§4.4 lifted): X-Openclaw-Break-Glass header allows a steward to
 * bypass enforcement when config is degraded, preventing permanent queue wedging.
 *
 * After a successful forward, Phase 3 B2 applies the state:* label transition
 * atomically (single issueUpdate mutation). Seam: proxy-side, not CLI-side — the
 * state change is coupled to the validated forward so an agent cannot skip it.
 * Transition failures are fail-open: logged but never propagate to the response.
 *
 * AI-1397 version floor: workflow mutations from CLIs below MIN_WORKFLOW_CLI_VERSION
 * are rejected. Missing version header is warned but allowed (backward compat).
 */

import type { Request, Response } from "express";
import { componentLogger, createLogger } from "./logger.js";
import { checkEnforcementRules } from "./escalation-gate.js";
import { checkWorkflowRules, checkRawMutationInterception, applyStateTransition, buildStateTransitionReminder, fetchWorkflowLabels, getCurrentState, type TransitionFeedback } from "./workflow-gate.js";
import type { ObservationStore, ReasonCode } from "./store/observation-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import { getAgent, getAgentByProxyToken } from "./agents.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "proxy");
const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Minimum CLI version required to issue workflow mutations (AI-1397).
 * CLIs below this version lack proxy-side delegate guards and advancement
 * guards, so they must be rejected before any enforcement can be bypassed.
 * Override via PROXY_MIN_CLI_VERSION env for testing. Evaluated at request
 * time so tests can override the env var after module load.
 */
function minWorkflowCliVersion(): string {
  return process.env.PROXY_MIN_CLI_VERSION ?? "0.3.0";
}

/** Parse a semver string into [major, minor, patch] tuple, or null on failure. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Returns true when `a` is strictly less than `b`. */
function semverLt(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/** Strip an optional "Bearer " prefix so proxy-token lookup matches the raw value. */
function stripBearer(auth: string): string {
  return auth.replace(/^Bearer\s+/i, "").trim();
}

interface GraphQLRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function parseBody(req: Request): GraphQLRequestBody | null {
  try {
    if (Buffer.isBuffer(req.body)) {
      return JSON.parse(req.body.toString("utf8")) as GraphQLRequestBody;
    }
    if (typeof req.body === "object" && req.body !== null) {
      return req.body as GraphQLRequestBody;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Best-effort extraction of ticket identifier from GraphQL variables.
 * Returns the first non-empty string found in common ID variable names, or null.
 */
function extractIssueId(body: GraphQLRequestBody | null): string | null {
  if (!body) return null;
  const vars = body.variables ?? {};
  for (const key of ["id", "issueId", "identifier"]) {
    const v = (vars as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // AI-1347: the id may be inlined in the query text rather than passed as a
  // variable (e.g. `issueUpdate(id:"<uuid>", ...)` or `issueUpdate(id:$foo,...)`
  // with a non-standard variable name). Without this, a raw mutation that
  // inlines its id slips past the workflow gate because issueId resolves null.
  const q = body.query ?? "";
  const m = q.match(/issueUpdate\s*\(\s*id\s*:\s*(?:"([^"]+)"|\$(\w+))/);
  if (m) {
    if (m[1]) return m[1]; // inline literal
    if (m[2]) {
      const v = (vars as Record<string, unknown>)[m[2]];
      if (typeof v === "string" && v.length > 0) return v; // aliased variable
    }
  }
  return null;
}

/**
 * Build the ticket context string for log lines (empty string when no ID found).
 */
function extractTicketContext(body: GraphQLRequestBody | null): string {
  const id = extractIssueId(body);
  return id ? ` ticket=${id}` : "";
}

/**
 * Best-effort extraction of comment body from GraphQL mutation variables.
 * Returns the first non-empty string found in common comment variable names, or null.
 */
function extractCommentBody(body: GraphQLRequestBody | null): string | null {
  if (!body?.variables) return null;
  const vars = body.variables as Record<string, unknown>;
  // commentCreate mutation sends { input: { body: "..." } } or { body: "..." }
  const input = vars.input;
  if (input && typeof input === "object" && input !== null) {
    const inputObj = input as Record<string, unknown>;
    if (typeof inputObj.body === "string" && inputObj.body.length > 0) return inputObj.body;
  }
  if (typeof vars.body === "string" && (vars.body as string).length > 0) return vars.body as string;
  return null;
}

/**
 * AI-1583: True only when the request's GraphQL operation is a mutation.
 *
 * Workflow enforcement (and the B2 state-transition writer) must apply to
 * mutations only — a read can never change workflow state. But the CLI sets the
 * X-Openclaw-Linear-Intent header for the whole duration of a semantic command
 * (client.ts setProxyIntent), so reads issued mid-command inherit the intent.
 * The worst offender is updateIssue(), which ends with `return getIssue(...)` —
 * that trailing read carried the intent and was delegate-only blocked *after*
 * the mutation it just performed reassigned the delegate, surfacing a spurious
 * "not the current delegate" failure even though the transition succeeded.
 *
 * Gating enforcement on the operation type fixes this for every intent-bearing
 * read path without weakening mutation enforcement: a real state mutation always
 * uses a `mutation` operation and is still gated.
 */
function isMutationRequest(body: GraphQLRequestBody | null): boolean {
  if (!body?.query) return false;
  // Strip leading whitespace and `# ...` comment lines, then check the operation
  // keyword. The CLI's mutations all use `mutation <Name>(...)`; reads use
  // `query <Name>(...)` or anonymous `{ ... }` (both → false).
  const stripped = body.query.replace(/^(?:\s|#[^\n]*\n?)+/, "");
  return /^mutation\b/.test(stripped);
}

export interface ProxyDeps {
  /** Optional observation store for recording feedback observations (P4-1). */
  observationStore?: ObservationStore;
  /** Optional operational event store for audit events (G-13a). */
  operationalEventStore?: OperationalEventStore;
}

export async function handleProxyRequest(req: Request, res: Response, deps?: ProxyDeps): Promise<void> {
  const rawAuthorization = req.headers["authorization"];
  if (!rawAuthorization) {
    res.status(401).json({ errors: [{ message: "Missing Authorization header" }] });
    return;
  }
  const authHeader = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;

  // Broker model (AI-1382 follow-up): if the caller presents an opaque broker
  // proxy token, resolve the agent from it — authenticated identity, not the
  // spoofable X-Openclaw-Agent header — and swap in the vaulted real Linear
  // OAuth token for every Linear read and the upstream forward. Actions then
  // appear as that agent's real Linear app user. A proxy token is rejected by
  // api.linear.app, so an agent can no longer bypass the gate by hitting Linear
  // without the proxy. Legacy fallback: an unrecognized Authorization is
  // forwarded as-is, so direct-token agents keep working during migration.
  const brokerAgent = getAgentByProxyToken(stripBearer(authHeader));
  const authorization = brokerAgent ? brokerAgent.accessToken : authHeader;

  const agentId = brokerAgent
    ? brokerAgent.name
    : ((req.headers["x-openclaw-agent"] as string | undefined) ?? "unknown");
  const intent = (req.headers["x-openclaw-linear-intent"] as string | undefined) ?? null;
  const target = (req.headers["x-openclaw-linear-target"] as string | undefined) ?? null;
  const feedbackCategoryHeader = (req.headers["x-openclaw-feedback-category"] as string | undefined) ?? null;
  const artifactRefHeader = (req.headers["x-openclaw-artifact-ref"] as string | undefined) ?? null;
  const cliVersion = (req.headers["x-openclaw-linear-cli-version"] as string | undefined) ?? null;
  const breakGlassHeader = req.headers["x-openclaw-break-glass"];
  const breakGlassOverride = breakGlassHeader === "true" || breakGlassHeader === "1";
  const body = parseBody(req);
  const opName = body?.operationName ?? "(unnamed)";
  const issueId = extractIssueId(body);
  const ticketCtx = issueId ? ` ticket=${issueId}` : "";

  // AI-1397: resolve caller's Linear user ID from agent config for delegate enforcement.
  const callerLinearUserId = getAgent(agentId)?.linearUserId ?? null;

  log.info(`forward agent=${agentId} op=${opName}${ticketCtx}${intent ? ` intent=${intent}` : ""}${cliVersion ? ` cli=${cliVersion}` : ""}`);

  // AI-1498: capture the ticket's workflow state BEFORE forwarding. The CLI
  // advances the state:* label inside its own forwarded mutation, so the
  // post-forward applyStateTransition would otherwise read the destination
  // state and skip the native-stateId write. We snapshot the true source here.
  let sourceStateOverride: string | undefined;

  // AI-1583: enforcement and the B2 writer apply to mutations only. A read can
  // never change workflow state, but reads issued mid-command inherit the sticky
  // intent header — gating them produced spurious delegate-only blocks.
  const isMutation = isMutationRequest(body);

  // Phase 2 / slice 1 + Phase 3 B1: evaluate enforcement rules before forwarding.
  if (intent && isMutation) {
    // AI-1397: version floor — reject workflow mutations from stale CLIs.
    if (cliVersion) {
      const minVer = minWorkflowCliVersion();
      const parsed = parseSemver(cliVersion);
      const floor = parseSemver(minVer);
      if (parsed && floor && semverLt(parsed, floor)) {
        const msg = `[Proxy] CLI version ${cliVersion} is below the minimum required ${minVer}. Update fancy-openclaw-linear-skill-cli to proceed.`;
        log.warn(`version-floor-block agent=${agentId} cli=${cliVersion}${ticketCtx}: below ${minVer}`);
        res.status(200).json({ errors: [{ message: msg }] });
        return;
      }
    } else {
      log.warn(`version-header-missing agent=${agentId} intent=${intent}${ticketCtx} — update CLI to emit X-Openclaw-Linear-Cli-Version`);
    }

    // G-13a (AI-1551): identity gate — break-glass restricted to steward/human bodies.
    if (breakGlassOverride) {
      let isAuthorized = false;
      try {
        const { bodyHasCapability } = await import("./escalation-gate.js");
        isAuthorized = await bodyHasCapability(agentId, "human:escalate");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`break-glass-audit agent=${agentId} authorized=false result=identity-check-failed${ticketCtx} intent=${intent}: ${msg}`);
        res.status(200).json({ errors: [{ message: `[Proxy] Break-glass rejected: identity check failed (${msg}). Only stewards may use break-glass.` }] });
        return;
      }
      if (!isAuthorized) {
        log.warn(`break-glass-audit agent=${agentId} authorized=false${ticketCtx} intent=${intent}`);
        res.status(200).json({ errors: [{ message: `[Proxy] Break-glass rejected: caller '${agentId}' is not a steward or human. Only stewards may use break-glass.` }] });
        return;
      }
      log.warn(`break-glass-audit agent=${agentId} authorized=true${ticketCtx} intent=${intent}`);
    }

    const p2rejection = await checkEnforcementRules(intent, issueId, authorization, agentId);
    if (p2rejection) {
      log.warn(`enforcement-block agent=${agentId} intent=${intent}${ticketCtx}: ${p2rejection}`);
      res.status(200).json({ errors: [{ message: p2rejection }] });
      return;
    }

    const p3rejection = await checkWorkflowRules(intent, issueId, authorization, agentId, target, callerLinearUserId, artifactRefHeader, breakGlassOverride);
    if (p3rejection) {
      log.warn(`workflow-block agent=${agentId} intent=${intent}${ticketCtx}: ${p3rejection}`);
      res.status(200).json({ errors: [{ message: p3rejection }] });
      return;
    }

    // G-13a: emit audit event for authorized break-glass use.
    if (breakGlassOverride) {
      deps?.operationalEventStore?.append({ outcome: "break-glass-used", agent: agentId, key: issueId ?? undefined });
    }

    // AI-1498: snapshot the pre-forward workflow state for applyStateTransition.
    // Fail-open: on any fetch error leave it undefined and let applyStateTransition
    // fall back to the ticket's current state:* label (legacy behavior).
    if (issueId) {
      try {
        const preLabels = await fetchWorkflowLabels(issueId, authorization);
        sourceStateOverride = getCurrentState(preLabels) ?? undefined;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`source-state snapshot failed agent=${agentId} intent=${intent}${ticketCtx}: ${msg}`);
      }
    }
  } else if (!intent) {
    // Layer 2 (AI-1387): intercept raw status/assignee mutations on workflow tickets.
    // When no intent header is present but the mutation touches stateId or assigneeId,
    // the agent is bypassing workflow commands — reject with the legal verb set.
    // AI-1535: callerLinearUserId lets the interceptor apply delegate-only semantics
    // to raw delegateId writes (a non-delegate must not yank the delegate).
    const rawRejection = await checkRawMutationInterception(body, issueId, authorization, agentId, callerLinearUserId);
    if (rawRejection) {
      log.warn(`raw-mutation-block agent=${agentId}${ticketCtx}: ${rawRejection}`);
      res.status(200).json({ errors: [{ message: rawRejection }] });
      return;
    }
  }

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`upstream request failed: ${msg}`);
    res
      .status(502)
      .json({ errors: [{ message: `Linear API unreachable: ${msg}` }] });
    return;
  }

  const responseText = await upstreamRes.text();
  log.info(`response agent=${agentId} op=${opName} status=${upstreamRes.status}`);

  // Phase 3 B2: apply state:* label transition after a successful forward.
  // Phase 4 / P4-1: record feedback observation for feedback transitions.
  // Only runs when the command was validated (intent present, no P2/P3 block).
  // AI-1583: mutations only — a forwarded read must not re-trigger the writer.
  // Fail-open: errors are logged and never propagate to the agent's response.
  if (intent && isMutation && upstreamRes.ok) {
    try {
      // Build feedback context for observation recording.
      let feedback: TransitionFeedback | undefined;
      if (feedbackCategoryHeader && (intent === "request-changes" || intent === "reject" || intent === "ac-fail")) {
        const fromBodyHeader = (req.headers["x-openclaw-from-body"] as string | undefined) ?? null;
        feedback = {
          fromBody: fromBodyHeader,
          reasonCode: feedbackCategoryHeader as ReasonCode,
          freeText: extractCommentBody(body),
        };
      }
      await applyStateTransition(intent, issueId, authorization, {
        bodyId: agentId,
        observationStore: deps?.observationStore,
        feedback,
        artifactRef: artifactRefHeader,
        sourceStateOverride,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`state-transition failed agent=${agentId} intent=${intent}${ticketCtx}: ${msg}`);
    }

    // Layer 1 (AI-1387): proactive legal-verb re-injection at completion.
    // After a successful state transition, generate the legal commands for
    // the NEW state and include in the response body so the agent sees them
    // at the decision moment — not just at delegation time.
    // Injected into the response JSON as `_workflowReminder` since HTTP headers
    // cannot carry newlines.
    let workflowReminder: string | null = null;
    try {
      workflowReminder = await buildStateTransitionReminder(intent, issueId, authorization);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`reminder-build failed agent=${agentId} intent=${intent}${ticketCtx}: ${msg}`);
    }

    // If we have a reminder, inject it into the response body.
    if (workflowReminder) {
      try {
        const parsedResponse = JSON.parse(responseText);
        parsedResponse._workflowReminder = workflowReminder;
        res
          .status(upstreamRes.status)
          .set("Content-Type", "application/json")
          .send(JSON.stringify(parsedResponse));
        return;
      } catch {
        // If response isn't valid JSON, fall through to send as-is.
      }
    }
  }

  res
    .status(upstreamRes.status)
    .set("Content-Type", "application/json")
    .send(responseText);
}
