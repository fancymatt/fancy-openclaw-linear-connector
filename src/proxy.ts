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
import { checkEnforcementRules, bodyHasCapability } from "./escalation-gate.js";
import { checkWorkflowRules, checkRawMutationInterception, applyStateTransition, buildStateTransitionReminder, fetchWorkflowLabels, fetchTeamStateLabelIds, getCurrentState, getWorkflowId, loadWorkflowDefById, resolveMetaIntent, resolveTransitionDelegate, verifyCommentSatisfiedBy, fetchTicketVerification, type TransitionFeedback, type TransitionApplyResult } from "./workflow-gate.js";
import type { ObservationStore, ReasonCode } from "./store/observation-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import type { MutationAuditStore, MutationAuditInput, ChangeType } from "./store/mutation-audit-store.js";
import { getAgent, getAgentByProxyToken } from "./agents.js";
import type { NoActivityDetector } from "./bag/no-activity-detector.js";
import { tryNormalizeSessionKey } from "./session-key.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "proxy");
const LINEAR_API_URL = "https://api.linear.app/graphql";

// G-16/AI-1548: per-ticket command lock (first-wins).
// Tracks ticket IDs whose commands are currently in-flight. A second concurrent
// command for the same ticket is rejected immediately — it never reaches B1 and
// never forwards. The lock is acquired synchronously (before any await) so the
// in-flight flag is visible to all other handlers that enter handleProxyRequest
// before the first command yields to the event loop.
const inFlightTickets = new Set<string>();

async function runWithTicketLock(
  ticketId: string,
  fn: () => Promise<void>,
  onConflict: () => void,
): Promise<void> {
  if (inFlightTickets.has(ticketId)) {
    onConflict();
    return;
  }
  inFlightTickets.add(ticketId);
  try {
    await fn();
  } finally {
    inFlightTickets.delete(ticketId);
  }
}

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
 * Best-effort extraction of a human-readable ticket identifier (e.g. "AI-1838")
 * from GraphQL variables. Used for the proxy audit log so records match the
 * webhook-side identifier. Returns null when only a UUID is available.
 */
function extractIssueIdentifier(body: GraphQLRequestBody | null): string | null {
  if (!body) return null;
  const vars = body.variables ?? {};
  for (const key of ["identifier", "issueIdentifier"]) {
    const v = (vars as Record<string, unknown>)[key];
    if (typeof v === "string" && /^[A-Z]+-\d+$/.test(v)) return v;
  }
  // Check if the id field is actually an identifier (not a UUID)
  for (const key of ["id", "issueId"]) {
    const v = (vars as Record<string, unknown>)[key];
    if (typeof v === "string" && /^[A-Z]+-\d+$/.test(v)) return v;
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
 * True when the mutation is an `issueUpdate` (the only mutation that carries a
 * label delta / state change). Reads and other mutations are left untouched.
 */
function isIssueUpdateMutation(body: GraphQLRequestBody | null): boolean {
  return !!body?.query && /\bissueUpdate\s*\(/.test(body.query);
}

/**
 * AI-1612: strip `state:*` label deltas from a forwarded intent-bearing
 * `issueUpdate` mutation so the proxy becomes the sole writer of the workflow
 * state label.
 *
 * Governed transition verbs set `omitStateId: true` (no native write) but still
 * carry the `state:*` flip via `addedLabelIds`/`removedLabelIds`. If that delta
 * lands upstream and `applyStateTransition` then fail-closes (e.g. it cannot
 * resolve the next delegate), the result is a half-applied transition: the label
 * moved but the delegate is stranded. By removing the state-label IDs here,
 * `applyStateTransition` — which re-derives the full correct label set itself in
 * one atomic mutation — is the only thing that ever moves the state label, so a
 * fail-closed transition is a true no-op.
 *
 * Only `state:*` label IDs are removed; any non-state label deltas pass through
 * untouched. Returns the count of stripped IDs (for logging).
 */
function issueUpdateInput(body: GraphQLRequestBody | null): Record<string, unknown> | undefined {
  const input = (body?.variables as Record<string, unknown> | undefined)?.input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
}

/**
 * True when the mutation carries a non-empty `state:*`-eligible label delta
 * (`addedLabelIds`/`removedLabelIds`). Used to skip the team-label resolution
 * round-trip entirely for mutations that have no label delta to strip.
 */
function carriesLabelDelta(body: GraphQLRequestBody | null): boolean {
  const input = issueUpdateInput(body);
  if (!input) return false;
  return ["addedLabelIds", "removedLabelIds"].some(
    (k) => Array.isArray(input[k]) && (input[k] as unknown[]).length > 0,
  );
}

/**
 * AI-1843: Map a workflow intent to the set of change types its
 * `applyStateTransition` will produce. The OOB reconcile sweep matches
 * webhook-observed changes against proxy records by exact `change_type`, so
 * the proxy must append one audit record per change type the transition will
 * trigger — not a single hard-coded `"state"` record.
 *
 * Every validated workflow transition applies an atomic mutation that changes:
 *   - the `state:*` label  → webhook fires `label`
 *   - the native stateId     → webhook fires `state`
 *   - the delegateId         → webhook fires `delegate` (set to a user, or
 *                              cleared to null on terminal states)
 *
 * Over-recording is harmless: unmatched proxy records sit idle. Under-recording
 * causes false-positive OOB flags (the bug this fixes — a `handoff-work` that
 * changes state + delegate produced only a `state` proxy record, so the
 * webhook's `delegate` change had no match and was flagged as out-of-band).
 *
 * For non-intent proxy ops (null intent), fall back to `"state"` only — those
 * are raw/unknown mutations and we have no transition model for them.
 */
function intentToChangeTypes(intent: string | null): ChangeType[] {
  if (!intent) return ["state"];
  return ["state", "label", "delegate"];
}

function stripStateLabelDeltas(body: GraphQLRequestBody | null, stateLabelIds: Set<string>): number {
  if (!body || stateLabelIds.size === 0) return 0;
  const input = issueUpdateInput(body);
  if (!input) return 0;
  let stripped = 0;
  for (const key of ["addedLabelIds", "removedLabelIds"]) {
    const arr = input[key];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((id) => !(typeof id === "string" && stateLabelIds.has(id)));
    stripped += arr.length - filtered.length;
    if (filtered.length === 0) {
      delete input[key];
    } else if (filtered.length !== arr.length) {
      input[key] = filtered;
    }
  }
  return stripped;
}

/**
 * AI-1857: Strip null delegateId/assigneeId from an intent-bearing issueUpdate input.
 * The proxy owns delegate management; CLIs must not directly null these fields.
 */
function stripNullDelegateAssigneeFields(body: GraphQLRequestBody | null): void {
  const input = issueUpdateInput(body);
  if (!input) return;
  if (input.delegateId === null) delete input.delegateId;
  if (input.assigneeId === null) delete input.assigneeId;
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

// AI-1860: TTL for per-command authorization snapshots.
const COMMAND_AUTH_SNAPSHOT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface CommandAuthSnapshot {
  /** The caller's Linear user ID snapshotted at command start (used as effective delegateId). */
  snapshotDelegateId: string | null;
  expiresAt: number;
}

export interface ProxyDeps {
  /** Optional observation store for recording feedback observations (P4-1). */
  observationStore?: ObservationStore;
  /** Optional operational event store for audit events (G-13a). */
  operationalEventStore?: OperationalEventStore;
  /** AI-1664: Optional no-activity detector — proxy calls with a resolvable ticket ID satisfy the timer. */
  noActivityDetector?: NoActivityDetector;
  /** AI-1799: enrolled-tickets mirror — transitions write to the board mirror. */
  enrolledTicketsStore?: EnrolledTicketsStore;
  /** AI-1838: mutation audit store — proxy-forwarded mutations recorded for out-of-band reconcile. */
  mutationAuditStore?: MutationAuditStore;
  /**
   * AI-1860: per-app authorization snapshot map for multi-step governed commands.
   * Keyed by `${agentId}:${issueId}:${intent}` — stores the caller's Linear user ID
   * verified as delegate at command start. Subsequent mutations reuse this snapshot
   * instead of re-fetching, preventing self-blocking after a post-transition delegate change.
   */
  commandAuthSnapshots?: Map<string, CommandAuthSnapshot>;
  /**
   * Called on the first proxy call from an agent for a ticket — auto-acknowledges the
   * dispatch so the watchdog doesn't re-signal an agent that is actively working but
   * hasn't sent an explicit pull-ack (e.g. during sessions_yield). The callback is
   * idempotent; calling it multiple times for the same agent+ticket is harmless.
   */
  onProxyCall?: (agentId: string, ticketId: string) => void;
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

  // AI-1664: proxy call with a resolvable ticket identifier counts as evidence of agent starting.
  // Prefer the body issueId if it normalizes (e.g. "AI-1664"); fall back to the Target header.
  // UUID-only calls (no normalizable ID, no Target header) do not affect the timer.
  {
    const proxyTicketId = (issueId && tryNormalizeSessionKey(issueId) !== null)
      ? issueId
      : (target && tryNormalizeSessionKey(target) !== null ? target : null);
    if (proxyTicketId) {
      deps?.noActivityDetector?.recordProxyActivity(agentId, proxyTicketId);
      // Auto-ack: any proxy call from an agent for a ticket counts as evidence that
      // the agent is working. This prevents the watchdog from re-signaling agents
      // that are in sessions_yield (no explicit pull-ack-activity is ever sent).
      deps?.onProxyCall?.(agentId, proxyTicketId);
    }
  }

  // AI-1583: enforcement and the B2 writer apply to mutations only. A read can
  // never change workflow state, but reads issued mid-command inherit the sticky
  // intent header — gating them produced spurious delegate-only blocks.
  const isMutation = isMutationRequest(body);

  // Phase 2 / slice 1 + Phase 3 B1: evaluate enforcement rules before forwarding.
  if (intent && isMutation) {
    // AI-1397: version floor — reject workflow mutations from stale CLIs.
    // Stateless check; stays outside the per-ticket lock.
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

    // G-16/AI-1548: per-ticket command serialisation.
    // The lock must be acquired synchronously (before any await) so a second
    // concurrent request on the same ticket sees the updated queue tail and waits.
    // Enforcement (B1), forward, and B2 all run inside the lock so the second
    // command re-validates against the state written by the first.
    const runCommand = async (): Promise<void> => {
      // AI-1498: capture the ticket's workflow state BEFORE forwarding.
      let sourceStateOverride: string | undefined;

      // Resolve meta-intents (continue-workflow, request-revision) to actual workflow
      // command names before any enforcement layer sees them. The original intent is
      // preserved in the header for logging; effectiveIntent drives all validation and
      // state transition logic.
      let effectiveIntent = intent!;
      if ((intent === 'continue-workflow' || intent === 'request-revision') && issueId) {
        const metaResult = await resolveMetaIntent(intent, issueId, authorization);
        if ('error' in metaResult) {
          log.warn(`meta-intent-block agent=${agentId} intent=${intent}${ticketCtx}: ${metaResult.error}`);
          res.status(200).json({ errors: [{ message: metaResult.error }] });
          return;
        }
        effectiveIntent = metaResult.resolved;
        log.info(`meta-intent-resolved agent=${agentId} ${intent}→${effectiveIntent}${ticketCtx}`);
      }

      // AI-1914 AC2: `migrate-state` — sanctioned, non-lossy steward migration of a
      // ticket stranded at a removed state (the case with no def `migrations` map).
      // Capability-gated to workflow:break-glass and audited like escape. The target
      // state is carried in X-Openclaw-Migrate-Target and must be a live-def state.
      // This is the sanctioned counterpart to the AC4 raw-path fail-close: it fully
      // handles the request (authorize → validate target → forward → audit) and does
      // not fall through to the normal transition-legality path (migrate-state is not
      // a def transition, and the ticket's current state is by definition defunct).
      if (effectiveIntent === "migrate-state") {
        const migrateTarget = (req.headers["x-openclaw-migrate-target"] as string | undefined) ?? null;

        // Capability gate — mirror the break-glass identity gate: name the caller
        // and the capability so the denial is unambiguous (AC5).
        let hasBreakGlass = false;
        try {
          hasBreakGlass = await bodyHasCapability(agentId, "workflow:break-glass");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`migrate-state-audit agent=${agentId} authorized=false result=identity-check-failed${ticketCtx}: ${msg}`);
          res.status(200).json({ errors: [{ message: `[Proxy] migrate-state rejected: capability check failed (${msg}). Only a steward (workflow:break-glass) may migrate a stranded ticket.` }] });
          return;
        }
        if (!hasBreakGlass) {
          log.warn(`migrate-state-audit agent=${agentId} authorized=false${ticketCtx} target=${migrateTarget ?? "(none)"}`);
          res.status(200).json({ errors: [{ message: `[Proxy] migrate-state rejected: caller '${agentId}' does not hold workflow:break-glass. Only the steward may migrate a stranded ticket to a live state.` }] });
          return;
        }

        // Target must be a state in the live def for this ticket's workflow.
        let def: Awaited<ReturnType<typeof loadWorkflowDefById>> = null;
        try {
          const labels = await fetchWorkflowLabels(issueId ?? "", authorization);
          const workflowId = getWorkflowId(labels);
          def = workflowId ? await loadWorkflowDefById(workflowId) : null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`migrate-state-target-check-failed agent=${agentId}${ticketCtx}: ${msg}`);
          res.status(200).json({ errors: [{ message: `[Proxy] migrate-state rejected: could not resolve the workflow def to validate the target (${msg}).` }] });
          return;
        }
        if (!migrateTarget || !def || !def.states.some((s) => s.id === migrateTarget)) {
          log.warn(`migrate-state-block agent=${agentId}${ticketCtx} target=${migrateTarget ?? "(none)"}: not a live-def state`);
          res.status(200).json({ errors: [{ message: `[Proxy] migrate-state rejected: target '${migrateTarget ?? "(missing)"}' is not a state in the live workflow def. Migrate only to a state that exists in the current def.` }] });
          return;
        }

        // Authorized + valid target — audit like escape and forward the migration.
        log.warn(`migrate-state-audit agent=${agentId} authorized=true${ticketCtx} target=${migrateTarget}`);
        deps?.operationalEventStore?.append({ outcome: "def-state-migrated", type: "def-state-migration", agent: agentId, key: issueId ?? undefined, detail: { target: migrateTarget, via: "steward-verb" } });

        let migrateRes: globalThis.Response;
        try {
          migrateRes = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authorization },
            body: JSON.stringify(body),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`migrate-state upstream request failed: ${msg}`);
          res.status(200).json({ errors: [{ message: `Linear API unreachable: ${msg}. No state was changed.`, extensions: { code: "UPSTREAM_TIMEOUT" } }] });
          return;
        }
        const migrateText = await migrateRes.text();
        res.status(migrateRes.status).set("Content-Type", "application/json").send(migrateText);
        return;
      }

      // G-13a (AI-1551): identity gate — break-glass restricted to steward/human bodies.
      if (breakGlassOverride) {
        let isAuthorized = false;
        try {
          const { bodyHasCapability } = await import("./escalation-gate.js");
          isAuthorized = await bodyHasCapability(agentId, "workflow:break-glass");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`break-glass-audit agent=${agentId} authorized=false result=identity-check-failed${ticketCtx} intent=${intent}: ${msg}`);
          res.status(200).json({ errors: [{ message: `[Proxy] Break-glass rejected: identity check failed (${msg}). Only stewards may use break-glass.` }] });
          return;
        }
        if (!isAuthorized) {
          log.warn(`break-glass-audit agent=${agentId} authorized=false${ticketCtx} intent=${intent}`);
          res.status(200).json({ errors: [{ message: `[Proxy] Break-glass rejected: caller '${agentId}' is not the recovery steward. Only the steward (workflow:break-glass) may use break-glass.` }] });
          return;
        }
        log.warn(`break-glass-audit agent=${agentId} authorized=true${ticketCtx} intent=${intent}`);
      }

      const p2rejection = await checkEnforcementRules(effectiveIntent, issueId, authorization, agentId);
      if (p2rejection) {
        log.warn(`enforcement-block agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${p2rejection}`);
        res.status(200).json({ errors: [{ message: p2rejection }] });
        return;
      }

      // G-13a: emit audit event for authorized break-glass use.
      if (breakGlassOverride) {
        deps?.operationalEventStore?.append({ outcome: "break-glass-used", agent: agentId, key: issueId ?? undefined });
      }

      // AI-1769 AC2: a dedup-suppressed comment may satisfy requires_comment via
      // the X-Openclaw-Comment-Satisfied-By header — the CLI points at the
      // existing comment that already carries the feedback, and the proxy
      // verifies it (issue match, recency, authorship) before honoring it.
      let requestHasComment = extractCommentBody(body) !== null;
      const satisfiedByHeader = (req.headers["x-openclaw-comment-satisfied-by"] as string | undefined) ?? null;
      if (!requestHasComment && satisfiedByHeader && issueId) {
        requestHasComment = await verifyCommentSatisfiedBy(issueId, satisfiedByHeader, authorization, callerLinearUserId);
        if (requestHasComment) {
          log.info(`comment-satisfied-by accepted agent=${agentId} intent=${effectiveIntent}${ticketCtx} comment=${satisfiedByHeader}`);
        } else {
          log.warn(`comment-satisfied-by rejected agent=${agentId} intent=${effectiveIntent}${ticketCtx} comment=${satisfiedByHeader}`);
        }
      }
      // AI-1860: look up any existing authorization snapshot for this (agent, ticket, intent).
      // A snapshot is stored on the first successful checkWorkflowRules pass and reused for
      // subsequent mutations in the same multi-step governed command so the delegate check
      // is not re-evaluated against post-transition state.
      const snapshotKey = issueId ? `${agentId}:${issueId}:${effectiveIntent}` : null;
      let snapshotDelegateId: string | null | undefined = undefined;
      if (snapshotKey && deps?.commandAuthSnapshots) {
        const existing = deps.commandAuthSnapshots.get(snapshotKey);
        if (existing && Date.now() < existing.expiresAt) {
          snapshotDelegateId = existing.snapshotDelegateId;
          log.info(`auth-snapshot-hit agent=${agentId} intent=${effectiveIntent}${ticketCtx}`);
        }
      }

      const p3rejection = await checkWorkflowRules(effectiveIntent, issueId, authorization, agentId, target, callerLinearUserId, artifactRefHeader, breakGlassOverride, intent !== effectiveIntent, requestHasComment, snapshotDelegateId);
      if (p3rejection) {
        log.warn(`workflow-block agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${p3rejection}`);
        // AI-1857 AC4: include gate-verification snapshot so CLI can verify "no partial state was written"
        const gateDeclineResponse: Record<string, unknown> = { errors: [{ message: p3rejection }] };
        if (issueId) {
          try {
            gateDeclineResponse._gateVerification = await fetchTicketVerification(issueId, authorization);
          } catch {
            // fail-open: don't suppress the rejection if verification fetch fails
          }
        }
        res.status(200).json(gateDeclineResponse);
        return;
      }

      // AI-1860: first successful authorization — store snapshot so subsequent mutations
      // in this multi-step command are not blocked by a post-transition delegate change.
      if (snapshotKey && deps?.commandAuthSnapshots && snapshotDelegateId === undefined) {
        deps.commandAuthSnapshots.set(snapshotKey, {
          snapshotDelegateId: callerLinearUserId ?? null,
          expiresAt: Date.now() + COMMAND_AUTH_SNAPSHOT_TTL_MS,
        });
        log.info(`auth-snapshot-stored agent=${agentId} intent=${effectiveIntent}${ticketCtx}`);
      }

      // AI-1977: delegateOverride is computed inside the issueId block below
      // (from the delegate pre-resolution), but needs to survive for use in the
      // applyStateTransition call further down, which is outside that block.
      let delegateOverride: string | null | undefined;

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

        // AI-1612: make the proxy the sole writer of the workflow state label.
        // Strip the `state:*` label delta from the forwarded issueUpdate so the
        // CLI's pre-write can't land ahead of applyStateTransition. If that apply
        // later fail-closes, the transition is then a true no-op (state label and
        // delegate both unchanged) instead of a half-applied stranding.
        // Fail-closed: if state-label IDs can't be resolved, block the mutation.
        // Previously fail-open here meant a strip failure could silently allow
        // label bypass (labels land in Linear, delegate never updated by applyStateTransition).
        if (isIssueUpdateMutation(body) && carriesLabelDelta(body)) {
          try {
            const stateLabelIds = await fetchTeamStateLabelIds(issueId, authorization);
            const stripped = stripStateLabelDeltas(body, stateLabelIds);
            if (stripped > 0) {
              log.info(`state-label-strip agent=${agentId} intent=${effectiveIntent}${ticketCtx}: stripped ${stripped} state:* label delta(s) — applyStateTransition is sole writer`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`state-label-strip failed agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${msg} — blocking (fail-closed)`);
            res.status(200).json({ errors: [{ message: `[Proxy] '${effectiveIntent}' blocked: workflow label safety check failed (${msg}). Try again or contact a steward.` }] });
            return;
          }
        }

        // AI-1857: Strip null delegateId/assigneeId from forwarded intent-bearing mutations.
        // The proxy manages delegates; partial semantic-verb application (e.g. complete)
        // bundles these null clears, which must not reach Linear directly.
        if (isIssueUpdateMutation(body)) {
          stripNullDelegateAssigneeFields(body);
        }

        // AI-1977: Pre-resolve the delegateId and inject it into the forwarded mutation
        // BEFORE the forward, so webhook #1 carries the correct delegate from the start.
        // Previously applyStateTransition set the delegate as a separate API call after
        // the forward, meaning webhook #1 fired with the OLD delegate — the new delegate
        // was invisible until webhook #2 (which sometimes never arrived or was misrouted).
        //
        // This block:
        //   1. Resolves the delegate using the same def-driven logic as applyStateTransition
        //   2. Injects it into the forwarded issueUpdate mutation (input.delegateId)
        //   3. Captures the result for applyStateTransition's delegateOverride option
        //
        // If resolution fails (multi-body, no target), we skip injection and let
        // applyStateTransition handle it the old way.
        if (isIssueUpdateMutation(body) && issueId && effectiveIntent !== 'migrate-state') {
          try {
            const preLabels = sourceStateOverride
              ? [] // we already have pre-forward labels
              : await fetchWorkflowLabels(issueId, authorization);
            const wfLabels = sourceStateOverride ? [] : preLabels;
            const wfId = sourceStateOverride
              ? await (async () => {
                  const fetched = await fetchWorkflowLabels(issueId, authorization);
                  return getWorkflowId(fetched);
                })()
              : getWorkflowId(wfLabels);
            if (wfId) {
              const def = await loadWorkflowDefById(wfId);
              if (def) {
                const currentStateName = sourceStateOverride ?? getCurrentState(preLabels);
                if (currentStateName) {
                  const stateNode = def.states.find((s) => s.id === currentStateName);
                  const matchedTransition = stateNode?.transitions?.find(
                    (t) => t.command === effectiveIntent,
                  );
                  if (matchedTransition) {
                    const resolved = await resolveTransitionDelegate(
                      matchedTransition.to,
                      matchedTransition,
                      def,
                      issueId,
                      target ?? undefined,
                    );
                    if (resolved !== undefined) {
                      delegateOverride = resolved;
                      // Inject into the forwarded mutation's input.
                      const input = issueUpdateInput(body);
                      if (input) {
                        input.delegateId = resolved;
                        log.info(
                          `delegate-pre-resolve agent=${agentId} intent=${effectiveIntent}${ticketCtx}: injected delegateId=${resolved} into forwarded mutation`,
                        );
                      }
                    }
                  }
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`delegate-pre-resolve failed agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${msg} — skipping injection`);
          }
        }

        // Layer 2 on intent path: run field-level interception after stripping.
        // Layer 2 normally runs only when no intent header is present, but an agent
        // can exploit that gap by piggy-backing label/state fields onto a valid intent
        // mutation. Running it here — after strip has removed legitimate state:* deltas
        // — catches anything that survived (strip failure, non-state label manipulation).
        // commentCreate is excluded: workflow commands legitimately use it.
        const intentPathRawRejection = await checkRawMutationInterception(
          body, issueId, authorization, agentId, callerLinearUserId, /* skipCommentCreate */ true, /* skipLabelFields */ true
        );
        if (intentPathRawRejection) {
          log.warn(`raw-mutation-block-on-intent-path agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${intentPathRawRejection}`);
          res.status(200).json({ errors: [{ message: intentPathRawRejection }] });
          return;
        }
      }

      let upstreamRes: globalThis.Response;
      try {
        upstreamRes = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authorization },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`upstream request failed: ${msg}`);
        res.status(200).json({
          errors: [{
            message: `Linear API unreachable: ${msg}. No state was changed.`,
            extensions: { code: "UPSTREAM_TIMEOUT" },
          }],
        });
        return;
      }

      const responseText = await upstreamRes.text();
      log.info(`response agent=${agentId} op=${opName} status=${upstreamRes.status}`);

      if (!upstreamRes.ok) {
        const status = upstreamRes.status;
        log.warn(`upstream-error agent=${agentId} op=${opName}${ticketCtx} status=${status}`);
        if (status === 429) {
          const retryAfterHeader = upstreamRes.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
          res.status(200).json({
            errors: [{
              message: `Linear rate limit exceeded. No state was changed. Retry after ${retryAfterSeconds}s.`,
              extensions: { code: "UPSTREAM_RATE_LIMITED", retryAfterSeconds },
            }],
          });
        } else {
          res.status(200).json({
            errors: [{
              message: `Linear API returned ${status}. No state was changed.`,
              extensions: { code: "UPSTREAM_ERROR", httpStatus: status },
            }],
          });
        }
        return;
      }

      // Phase 3 B2: apply state:* label transition after a successful forward.
      // Phase 4 / P4-1: record feedback observation for feedback transitions.
      // AI-1809: the transition outcome is no longer swallowed — it is attached
      // to the agent's response as a machine-readable `_workflowTransition`
      // field. A stderr-only warning beside a success payload is how AI-1773
      // was stranded half-applied (comment landed, label/delegate did not).
      if (upstreamRes.ok) {
        // AI-1838/AI-1843: record proxy-forwarded mutation for out-of-band reconcile.
        // The reconcile sweep matches these proxy records against webhook-observed
        // changes by exact change_type; a webhook change with no matching proxy op
        // is out-of-band. A workflow transition (e.g. handoff-work) changes state
        // label + native stateId + delegate atomically, producing multiple webhook
        // events — one per field. We must append one audit record per change type
        // so each webhook observation finds a matching proxy record.
        if (deps?.mutationAuditStore && issueId) {
          try {
            const auditIdentifier = extractIssueIdentifier(body) ?? issueId;
            const fieldLabel = effectiveIntent ? `intent:${effectiveIntent}` : `op:${opName}`;
            const auditRecords: MutationAuditInput[] = intentToChangeTypes(effectiveIntent).map((ct) => ({
              source: "proxy",
              ticket: auditIdentifier,
              ticketUuid: issueId,
              changeType: ct,
              field: fieldLabel,
              agent: agentId,
              intent: effectiveIntent,
              opName,
            }));
            if (auditRecords.length === 1) {
              deps.mutationAuditStore.append(auditRecords[0]);
            } else {
              deps.mutationAuditStore.appendBatch(auditRecords);
            }
          } catch (auditErr) {
            log.warn(`mutation audit proxy-op record failed (non-blocking): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        }

        let transitionResult: TransitionApplyResult | null = null;
        try {
          let feedback: TransitionFeedback | undefined;
          if (feedbackCategoryHeader && (effectiveIntent === "request-changes" || effectiveIntent === "reject" || effectiveIntent === "ac-fail")) {
            const fromBodyHeader = (req.headers["x-openclaw-from-body"] as string | undefined) ?? null;
            feedback = {
              fromBody: fromBodyHeader,
              reasonCode: feedbackCategoryHeader as ReasonCode,
              freeText: extractCommentBody(body),
            };
          }
          transitionResult = await applyStateTransition(effectiveIntent, issueId, authorization, {
            bodyId: agentId,
            observationStore: deps?.observationStore,
            feedback,
            artifactRef: artifactRefHeader,
            sourceStateOverride,
            cliTarget: target ?? undefined,
            enrolledTicketsStore: deps?.enrolledTicketsStore,
            operationalEventStore: deps?.operationalEventStore,
            delegateOverride,
          });
          if (transitionResult.status === "failed") {
            log.error(`state-transition FAILED agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${transitionResult.code}${transitionResult.detail ? ` — ${transitionResult.detail}` : ""}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`state-transition threw agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${msg}`);
          transitionResult = { status: "failed", code: "transition-exception", detail: msg };
        }

        // Layer 1 (AI-1387): proactive legal-verb re-injection at completion.
        let workflowReminder: string | null = null;
        try {
          workflowReminder = await buildStateTransitionReminder(effectiveIntent, issueId, authorization);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`reminder-build failed agent=${agentId} intent=${effectiveIntent}${ticketCtx}: ${msg}`);
        }

        // Attach transition outcome for workflow tickets. Pure pass-through
        // outcomes (ad-hoc ticket, no issue id) stay unannotated so non-workflow
        // traffic keeps its exact upstream response shape.
        const attachTransition =
          transitionResult !== null &&
          transitionResult.code !== "ad-hoc" &&
          transitionResult.code !== "no-issue-id";

        if (workflowReminder || attachTransition) {
          try {
            const parsedResponse = JSON.parse(responseText);
            if (attachTransition) parsedResponse._workflowTransition = transitionResult;
            if (workflowReminder) parsedResponse._workflowReminder = workflowReminder;
            res.status(upstreamRes.status).set("Content-Type", "application/json").send(JSON.stringify(parsedResponse));
            return;
          } catch {
            // If response isn't valid JSON, fall through to send as-is.
          }
        }
      }

      res.status(upstreamRes.status).set("Content-Type", "application/json").send(responseText);
    };

    if (issueId) {
      await runWithTicketLock(issueId, runCommand, () => {
        log.warn(`concurrent-command-block agent=${agentId} intent=${intent}${ticketCtx}`);
        res.status(200).json({ errors: [{ message: `[Proxy] '${intent}' blocked: another command is currently in-flight for ${issueId}. Retry once it completes.` }] });
      });
    } else {
      await runCommand();
    }
    return;
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

  // Non-intent forward path (reads and raw non-workflow mutations).
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
    res.status(200).json({
      errors: [{
        message: `Linear API unreachable: ${msg}. No state was changed.`,
        extensions: { code: "UPSTREAM_TIMEOUT" },
      }],
    });
    return;
  }

  const responseText = await upstreamRes.text();
  log.info(`response agent=${agentId} op=${opName} status=${upstreamRes.status}`);

  if (!upstreamRes.ok) {
    const status = upstreamRes.status;
    log.warn(`upstream-error agent=${agentId} op=${opName}${ticketCtx} status=${status}`);
    if (status === 429) {
      const retryAfterHeader = upstreamRes.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
      res.status(200).json({
        errors: [{
          message: `Linear rate limit exceeded. No state was changed. Retry after ${retryAfterSeconds}s.`,
          extensions: { code: "UPSTREAM_RATE_LIMITED", retryAfterSeconds },
        }],
      });
    } else {
      res.status(200).json({
        errors: [{
          message: `Linear API returned ${status}. No state was changed.`,
          extensions: { code: "UPSTREAM_ERROR", httpStatus: status },
        }],
      });
    }
    return;
  }


  res
    .status(upstreamRes.status)
    .set("Content-Type", "application/json")
    .send(responseText);
}
