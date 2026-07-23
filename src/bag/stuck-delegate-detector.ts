/**
 * StuckDelegateDetector — re-prompt delegates who posted completion comments
 * without running the transition verb.
 *
 * Problem (AI-1451 / parent AI-1443): An implementer authors correct code,
 * posts a prose "B-1 Complete" comment, but never runs `linear submit`. The
 * ticket sits in `state:implementation`, assigned to the implementer, and
 * the next heartbeat rationalizes it as "waiting for review" → HEARTBEAT_OK.
 * The queue stalls silently.
 *
 * This detector closes the gap by:
 *   1. Periodically scanning for workflow tickets in non-terminal states
 *      where the delegate has gone idle (no session active for that ticket).
 *   2. For each candidate, checking whether a comment was posted by the
 *      delegate after the state was entered, but no transition verb has
 *      fired since.
 *   3. When the pattern matches, re-prompting the delegate with the exact
 *      legal-command block for the current state instead of allowing
 *      HEARTBEAT_OK.
 *
 * This is distinct from:
 *   - NoActivityDetector (sessions that never started)
 *   - StaleSessionForensics (sessions that timed out)
 *   - ManagingPoller (periodic stewardship wakes for managing state)
 *
 * This detector catches the "I said I'm done but forgot to press the button"
 * pattern — the delegate's session has ended naturally, but the state machine
 * is stuck because the transition verb was never run.
 *
 * Configuration (env vars, all optional):
 *   STUCK_DELEGATE_POLL_MS          — check interval (default: 5 min)
 *   STUCK_DELEGATE_IDLE_GRACE_MS    — how long a delegate must be idle before
 *                                     triggering (default: 3 min)
 *   STUCK_DELEGATE_MAX_PROMPTS      — max re-prompts per ticket (default: 2)
 */

import { createLogger, componentLogger } from "../logger.js";
import { getAccessToken, getAgents, isAgentLocal, isPolledForLinear, type AgentConfig } from "../agents.js";
import { loadWorkflowDef, getCurrentState, getWorkflowId, type WorkflowDef } from "../workflow-gate.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { SessionTracker } from "./session-tracker.js";
import type { PendingWorkBag } from "./pending-work-bag.js";
import { normalizeSessionKey } from "../session-key.js";
import { deliverMessageToAgent, type DeliveryConfig } from "../delivery/index.js";
import type { DispatchAckTracker } from "./dispatch-ack-tracker.js";

const log = componentLogger(createLogger(), "stuck-delegate-detector");

const DEFAULT_POLL_MS = 5 * 60 * 1000;       // 5 minutes
const DEFAULT_IDLE_GRACE_MS = 3 * 60 * 1000;  // 3 minutes
const DEFAULT_MAX_PROMPTS = 2;
const DEFAULT_SESSION_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// ── Configuration ────────────────────────────────────────────────────────────

export interface StuckDelegateConfig {
  /** How often to check for stuck delegates. Default: 5 min. */
  pollMs: number;
  /** How long a delegate must be idle before triggering. Default: 3 min. */
  idleGraceMs: number;
  /** Max re-prompts per ticket. Default: 2. */
  maxPrompts: number;
  /**
   * Treat a ticket as having an active session if a pending dispatch ack exists
   * within this threshold (ms). Guards against re-dispatching sessions that are
   * still running but whose in-memory SessionTracker was lost to a restart.
   * Default: 10 min. Set to 0 to disable.
   */
  sessionActiveThresholdMs: number;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface StuckDelegateDeps {
  sessionTracker: SessionTracker;
  bag: PendingWorkBag;
  operationalEventStore: OperationalEventStore;
  /** Delivery config for sending re-prompt messages to agents. */
  deliveryConfig: DeliveryConfig;
  /** Persisted dispatch ack tracker (SQLite). Survives restarts. Optional for backward compat. */
  ackTracker?: DispatchAckTracker;
  /** Deliver a re-prompt wake signal to the agent. */
  sendWake?: (agentOpenclawName: string, ticketId: string, prompt: string) => Promise<boolean>;
  /** Overridable for testing. */
  listAgents?: () => AgentConfig[];
  /** Overridable for testing. */
  now?: () => number;
  /** Overridable for testing. */
  fetchStuckCandidates?: (agent: AgentConfig) => Promise<StuckCandidate[]>;
  /** Overridable for testing — loads workflow def. */
  loadDef?: () => Promise<WorkflowDef>;
}

// ── Data types ───────────────────────────────────────────────────────────────

export interface StuckCandidate {
  identifier: string;
  currentState: string;
  labels: string[];
  delegateId: string;
  /** ISO timestamp of the most recent state:* label change (updatedFrom). */
  stateEnteredAt: string | null;
  /** ISO timestamps of comments posted by the delegate after state entry. */
  delegateComments: Array<{ id: string; createdAt: string; body: string }>;
  /** ISO timestamps of transition verbs detected (state transitions in Linear history). */
  transitionsAfterEntry: Array<{ from: string; to: string; at: string }>;
  /**
   * AI-2129: workflow id (from `wf:*` label), e.g. "dev-sprint". Optional for
   * backward compatibility with directly-constructed candidates.
   */
  workflowId?: string;
  /** AI-2129: total number of linked child issues (0 for leaf tickets). */
  totalChildren?: number;
  /**
   * AI-2129: number of child issues that are NOT in a terminal state. When a
   * workflow parent sits on an open barrier (e.g. a `wf:dev-sprint` parent at
   * `state:validation`) with ≥1 non-terminal child, the barrier is legitimately
   * open — the delegate has no legal transition to run, so a stuck re-prompt is
   * pure noise and must be suppressed.
   */
  nonTerminalChildCount?: number;
}

export interface StuckDelegateCycleResult {
  agentsChecked: number;
  candidatesChecked: number;
  stuckFound: number;
  rePromptsSent: number;
  skippedAlreadyPrompted: number;
  /** Candidates skipped because a pending dispatch ack suggests the session is still active. */
  skippedSessionActive: number;
  /**
   * AI-2129: candidates skipped because they are workflow parents sitting on an
   * open barrier (≥1 non-terminal child) — the barrier is legitimately open, so
   * the "stuck" pattern is a false positive.
   */
  skippedBarrierHeld: number;
  errors: number;
}

// ── Prompt-count store (in-memory, reset on restart) ─────────────────────────
// TODO: If ticket volume grows, persist PromptCounter to the bag DB so counts
// survive connector restarts. In-memory is fine for v1 — maxPrompts defaults to 2
// and a restart-only reset is acceptable.

/** Tracks how many times each ticket has been re-prompted. */
export class PromptCounter {
  private counts: Map<string, number> = new Map();

  increment(ticketId: string): number {
    const normalized = normalizeSessionKey(ticketId);
    const current = this.counts.get(normalized) ?? 0;
    const next = current + 1;
    this.counts.set(normalized, next);
    return next;
  }

  get(ticketId: string): number {
    return this.counts.get(normalizeSessionKey(ticketId)) ?? 0;
  }

  /** Clear prompt count for a ticket (e.g., when it transitions). */
  clear(ticketId: string): void {
    this.counts.delete(normalizeSessionKey(ticketId));
  }

  /** Clear all counts. */
  clearAll(): void {
    this.counts.clear();
  }
}

// ── Helper: parse env var ────────────────────────────────────────────────────

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

// ── Helper: child terminality (AI-2129) ──────────────────────────────────────

/** Terminal workflow `state:*` labels that satisfy a parent's N→1 barrier. */
const TERMINAL_CHILD_STATES = new Set(["done", "escape"]);
/** Native Linear state types that count as terminal (issue closed). */
const TERMINAL_NATIVE_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Is a child issue in a terminal state? A child satisfies the parent barrier if
 * its native Linear state is completed/canceled, or it carries a terminal
 * workflow `state:*` label (done/escape). Mirrors the barrier subsystem's
 * child-terminality contract (see barrier.ts) so suppression and auto-advance
 * agree on when a barrier is closed.
 */
function isChildTerminal(nativeStateType: string | null, labels: string[]): boolean {
  if (nativeStateType && TERMINAL_NATIVE_STATE_TYPES.has(nativeStateType)) return true;
  const workflowState = getCurrentState(labels);
  return workflowState !== null && TERMINAL_CHILD_STATES.has(workflowState);
}

// ── Build re-prompt message ──────────────────────────────────────────────────

/**
 * Build a targeted re-prompt for a stuck delegate. Includes the exact legal
 * commands for the current state, referencing the completion-comment-without-
 * transition failure mode.
 */
export function buildRePrompt(
  ticketId: string,
  currentState: string,
  def: WorkflowDef,
): string {
  const breakGlassCommand = def.break_glass?.command ?? "escape";
  const stateNode = def.states.find((s) => s.id === currentState);

  if (!stateNode || !stateNode.transitions?.length) {
    // Terminal or unknown state — shouldn't happen but be defensive
    log.warn(
      `Stuck-delegate: buildRePrompt reached terminal/unknown state fallback for ${ticketId} ` +
      `(state='${currentState}', stateNode=${stateNode ? "terminal" : "unknown"}). ` +
      `This should be unreachable — candidate filtering may be inconsistent.`,
    );
    return (
      `[Stuck-delegate detection] Ticket ${ticketId} is in state '${currentState}' but appears stuck. ` +
      `If you believe your work is complete, run \`linear escape ${ticketId}\` to break glass.`
    );
  }

  const commands = stateNode.transitions.map((t) => {
    let cmd = `linear ${t.command} ${ticketId}`;
    // Note: assignment targets would need to be resolved at runtime. For the
    // re-prompt we show the template form — the proxy will validate when run.
    return `\`${cmd}\` (→ ${t.to})`;
  });

  commands.push(`\`linear ${breakGlassCommand} ${ticketId}\` (break glass, legal from any state)`);

  return (
    `[Stuck-delegate detection] You posted a completion comment but ticket ${ticketId} is still ` +
    `in \`state:${currentState}\` — the state machine has NOT advanced. ` +
    `A comment is NOT a transition. You must run the transition verb to hand off.\n\n` +
    `Legal action(s) from \`${currentState}\`:\n` +
    commands.map((c) => `  - ${c}`).join("\n") +
    `\n\nRun the appropriate command now. Do NOT reply HEARTBEAT_OK.`
  );
}

// ── Main detector class ──────────────────────────────────────────────────────

export class StuckDelegateDetector {
  private timer?: ReturnType<typeof setInterval>;
  private config: StuckDelegateConfig;
  private deps: Required<Omit<StuckDelegateDeps, "ackTracker">>;
  /** Persisted ack tracker — optional, stored separately since it has no default fallback. */
  private ackTracker: DispatchAckTracker | undefined;
  private promptCounter: PromptCounter;
  /** Tracks when sessions ended per (agent, sessionKey) for idle-grace calculation. */
  private sessionEndedAt: Map<string, number> = new Map();

  constructor(deps: StuckDelegateDeps, config?: Partial<StuckDelegateConfig>) {
    this.config = {
      pollMs: config?.pollMs ?? parseEnvInt("STUCK_DELEGATE_POLL_MS", DEFAULT_POLL_MS),
      idleGraceMs: config?.idleGraceMs ?? parseEnvInt("STUCK_DELEGATE_IDLE_GRACE_MS", DEFAULT_IDLE_GRACE_MS),
      maxPrompts: config?.maxPrompts ?? parseEnvInt("STUCK_DELEGATE_MAX_PROMPTS", DEFAULT_MAX_PROMPTS),
      sessionActiveThresholdMs: config?.sessionActiveThresholdMs ?? parseEnvInt("STUCK_DELEGATE_SESSION_ACTIVE_MS", DEFAULT_SESSION_ACTIVE_THRESHOLD_MS),
    };
    this.ackTracker = deps.ackTracker;
    this.deps = {
      sessionTracker: deps.sessionTracker,
      bag: deps.bag,
      operationalEventStore: deps.operationalEventStore,
      deliveryConfig: deps.deliveryConfig,
      sendWake: deps.sendWake ?? defaultSendWakeFactory(deps.deliveryConfig),
      listAgents: deps.listAgents ?? (() => getAgents().filter(isAgentLocal).filter(isPolledForLinear)),
      now: deps.now ?? (() => Date.now()),
      fetchStuckCandidates: deps.fetchStuckCandidates ?? defaultFetchStuckCandidates,
      loadDef: deps.loadDef ?? loadWorkflowDef,
    };
    this.promptCounter = new PromptCounter();
  }

  start(): void {
    if (this.timer) return;
    log.info(
      `Stuck-delegate detector started — poll=${this.config.pollMs}ms ` +
      `idleGrace=${this.config.idleGraceMs}ms maxPrompts=${this.config.maxPrompts}`,
    );
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        log.error(
          `Stuck-delegate cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.config.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Clear the prompt counter for a ticket. Called when a successful
   * transition is detected (the ticket is no longer stuck).
   */
  clearPromptCount(ticketId: string): void {
    this.promptCounter.clear(ticketId);
  }

  /**
   * Run one detection cycle. For each agent, fetches workflow tickets in
   * non-terminal states where the delegate is idle, checks the stuck pattern,
   * and re-prompts as needed.
   */
  async runCycle(): Promise<StuckDelegateCycleResult> {
    const { listAgents, fetchStuckCandidates, loadDef, sessionTracker, bag, operationalEventStore, sendWake, now: getNow } = this.deps;
    const ackTracker = this.ackTracker;
    const agents = listAgents();
    const result: StuckDelegateCycleResult = {
      agentsChecked: 0,
      candidatesChecked: 0,
      stuckFound: 0,
      rePromptsSent: 0,
      skippedAlreadyPrompted: 0,
      skippedSessionActive: 0,
      skippedBarrierHeld: 0,
      errors: 0,
    };

    let def: WorkflowDef;
    try {
      def = await loadDef();
    } catch (err) {
      log.error(`Failed to load workflow def: ${err instanceof Error ? err.message : String(err)}`);
      result.errors++;
      return result;
    }

    for (const agent of agents) {
      result.agentsChecked++;

      let candidates: StuckCandidate[];
      try {
        candidates = await fetchStuckCandidates(agent);
      } catch (err) {
        result.errors++;
        log.error(
          `Stuck-delegate fetch failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const candidate of candidates) {
        result.candidatesChecked++;
        const ticketId = candidate.identifier;
        const sessionKey = normalizeSessionKey(ticketId);
        const openclawAgent = agent.openclawAgent ?? agent.name;

        // Skip if agent has an active session for this ticket — not idle yet
        if (sessionTracker.isActiveForTicket(openclawAgent, sessionKey)) {
          // Session is active — clear any stale "ended at" tracking
          this.sessionEndedAt.delete(`${openclawAgent}:${sessionKey}`);
          continue;
        }

        // AI-1650: Persisted dispatch-ack guard. After a connector restart,
        // the in-memory SessionTracker is empty, so isActiveForTicket() is
        // always false — even for sessions that are still actively running.
        // Check the SQLite-backed DispatchAckTracker for a recent pending
        // dispatch. If one exists within sessionActiveThresholdMs, the session
        // is likely still in progress — skip to avoid duplicate dispatch.
        if (ackTracker && this.config.sessionActiveThresholdMs > 0) {
          if (ackTracker.hasRecentPending(openclawAgent, sessionKey, this.config.sessionActiveThresholdMs)) {
            result.skippedSessionActive++;
            log.info(
              `Stuck-delegate: skipping ${ticketId} — recent pending dispatch within ${this.config.sessionActiveThresholdMs}ms ` +
              `suggests session is still active (agent=${openclawAgent})`,
            );
            continue;
          }
        }

        // Apply idle grace period: if the session recently ended, wait
        // When idleGraceMs is 0 (default for tests and aggressive detection),
        // skip the grace entirely and detect on first poll.
        if (this.config.idleGraceMs > 0) {
          const endedKey = `${openclawAgent}:${sessionKey}`;
          const now = getNow();
          const endedAt = this.sessionEndedAt.get(endedKey);
          if (endedAt === undefined) {
            // First poll seeing this ticket as idle — record the time and skip
            this.sessionEndedAt.set(endedKey, now);
            continue;
          } else if (now - endedAt < this.config.idleGraceMs) {
            // Still within grace period — skip
            continue;
          }
        }

        // Check the stuck pattern:
        // 1. Non-terminal state (verified by candidate query)
        // 2. Delegate posted a comment after entering this state
        // 3. No transition verb has fired since entering this state
        if (candidate.delegateComments.length === 0) {
          continue; // No completion comment — not the stuck pattern
        }

        if (candidate.transitionsAfterEntry.length > 0) {
          // A transition DID fire — clear prompt counter and skip
          this.promptCounter.clear(ticketId);
          continue;
        }

        // AI-2129: Barrier-held suppression. A workflow parent (e.g. a
        // `wf:dev-sprint` parent at `state:validation`) cannot advance while its
        // implementation children are still in flight — the N→1 barrier is
        // legitimately open, so the delegate has NO legal transition to run. The
        // "completion comment without transition" pattern is therefore a false
        // positive: the parent posts an identical "barrier still open" comment on
        // every wake and can never clear the detector, producing pure dispatch and
        // comment-noise waste (AI-2021 was re-dispatched ~5×). Suppress while ≥1
        // child is non-terminal. Once every child terminalizes the count drops to
        // 0 and normal dispatch resumes, so a genuinely-stuck validation sign-off
        // is not silently dropped (AC2). Leaf tickets (no children) are unaffected,
        // preserving ordinary stuck-delegate detection (AC3).
        if ((candidate.nonTerminalChildCount ?? 0) > 0) {
          result.skippedBarrierHeld++;
          log.info(
            `Stuck-delegate: skipping ${ticketId} — barrier-held parent, ` +
            `${candidate.nonTerminalChildCount}/${candidate.totalChildren ?? candidate.nonTerminalChildCount} ` +
            `children non-terminal (wf:${candidate.workflowId ?? "?"}, state:${candidate.currentState})`,
          );
          continue;
        }

        // Pattern matches: completion comment but no transition verb
        result.stuckFound++;

        // Check prompt cap
        const promptCount = this.promptCounter.get(ticketId);
        if (promptCount >= this.config.maxPrompts) {
          result.skippedAlreadyPrompted++;
          log.info(
            `Stuck-delegate: skipping ${ticketId} — already prompted ${promptCount} times (max=${this.config.maxPrompts})`,
          );
          continue;
        }

        // Build re-prompt
        const rePrompt = buildRePrompt(ticketId, candidate.currentState, def);

        // Send wake signal
        try {
          const sent = await sendWake(openclawAgent, ticketId, rePrompt);
          if (sent) {
            const newCount = this.promptCounter.increment(ticketId);
            result.rePromptsSent++;
            log.info(
              `Stuck-delegate: re-prompted ${openclawAgent} for ${ticketId} (prompt ${newCount}/${this.config.maxPrompts})`,
            );

            // Add to bag so downstream wake-up mechanisms can see it
            const pending = bag.getPendingTickets(openclawAgent);
            if (!pending.some((e) => e.ticketId === sessionKey)) {
              bag.add(openclawAgent, sessionKey, "Issue", "stuck-delegate-reprompt");
            }

            operationalEventStore.append({
              outcome: "stuck-delegate-reprompt",
              agent: openclawAgent,
              key: sessionKey,
              sessionKey,
              deliveryMode: "stuck-delegate-detector",
              attemptCount: newCount,
              detail: {
                ticketId,
                currentState: candidate.currentState,
                delegateComments: candidate.delegateComments.length,
                promptNumber: newCount,
              },
            });

            // Clear the idle tracker — a prompt was sent, don't re-trigger immediately
            this.sessionEndedAt.delete(`${openclawAgent}:${sessionKey}`);
          }
        } catch (err) {
          result.errors++;
          log.error(
            `Stuck-delegate wake failed for ${openclawAgent} / ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return result;
  }
}

// ── Default wake implementation ──────────────────────────────────────────────

/**
 * Create a default sendWake that delivers the re-prompt to the agent via
 * the standard delivery pipeline (HTTP hooks or CLI spawn).
 */
function defaultSendWakeFactory(
  deliveryConfig: DeliveryConfig,
): (agentOpenclawName: string, ticketId: string, prompt: string) => Promise<boolean> {
  return async (
    agentOpenclawName: string,
    ticketId: string,
    prompt: string,
  ): Promise<boolean> => {
    const sessionKey = normalizeSessionKey(ticketId);
    log.info(`Stuck-delegate wake: delivering re-prompt to ${agentOpenclawName} / ${ticketId}`);
    try {
      const result = await deliverMessageToAgent(agentOpenclawName, sessionKey, prompt, deliveryConfig);
      if (!result.dispatched) {
        log.error(
          `Stuck-delegate wake delivery failed for ${agentOpenclawName} / ${ticketId}: ` +
          (result.hookErrorSummary ?? "delivery not accepted"),
        );
        return false;
      }
      log.info(`Stuck-delegate wake delivered for ${agentOpenclawName} / ${ticketId} (runId=${result.runId ?? "ok"})`);
      return true;
    } catch (err) {
      log.error(
        `Stuck-delegate wake delivery threw for ${agentOpenclawName} / ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };
}

// ── Default candidate fetcher ────────────────────────────────────────────────

/**
 * Fetch stuck-delegate candidates from Linear for an agent.
 *
 * Queries for issues delegated to this agent that have a `state:*` label
 * (workflow ticket) but are NOT in a terminal state. For each, checks
 * whether the delegate posted comments after the state was entered but
 * no transition verb has fired since.
 *
 * Returns candidates matching the stuck pattern.
 */
async function defaultFetchStuckCandidates(agent: AgentConfig): Promise<StuckCandidate[]> {
  const token = getAccessToken(agent.name);
  if (!token) {
    log.warn(`No access token for agent ${agent.name}; skipping stuck-delegate check`);
    return [];
  }

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;

  // Query all issues delegated to this agent that have state:* labels
  const query = `
    query DelegatedIssues($delegateId: ID!) {
      issues(
        first: 50,
        filter: { delegate: { id: { eq: $delegateId } } }
      ) {
        nodes {
          identifier
          labels { nodes { name } }
          delegate { id }
          updatedAt
          state { name type }
          children(first: 50) {
            nodes {
              identifier
              state { type }
              labels { nodes { name } }
            }
          }
          comments(first: 20, orderBy: createdAt) {
            nodes {
              id
              createdAt
              body
              user { id name }
            }
          }
          history(
            first: 50,
            orderBy: createdAt
          ) {
            nodes {
              __typename
              createdAt
              actor { id }
              addedLabelIds
              removedLabelIds
              fromState { name }
              toState { name }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query, variables: { delegateId: agent.linearUserId } }),
    });

    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status} for agent ${agent.name}`);
    }

    const body = (await res.json()) as {
      data?: {
        issues?: {
          nodes?: Array<{
            identifier: string;
            labels: { nodes: Array<{ name: string }> };
            delegate: { id: string } | null;
            updatedAt: string;
            state: { name: string; type: string } | null;
            children?: {
              nodes?: Array<{
                identifier: string;
                state?: { type: string } | null;
                labels?: { nodes?: Array<{ name: string }> };
              }>;
            };
            comments: {
              nodes: Array<{
                id: string;
                createdAt: string;
                body: string;
                user: { id: string; name: string } | null;
              }>;
            };
            history: {
              nodes: Array<{
                __typename: string;
                createdAt?: string;
                actor?: { id: string } | null;
                addedLabelIds?: string | null;
                removedLabelIds?: string | null;
                fromState?: { name: string } | null;
                toState?: { name: string } | null;
              }>;
            };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (body.errors?.length) {
      throw new Error(`Linear API errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }

    const issues = body.data?.issues?.nodes ?? [];
    const candidates: StuckCandidate[] = [];

    for (const issue of issues) {
      const labelNames = issue.labels.nodes.map((l) => l.name);

      // Must be a workflow ticket with a state label
      const workflowId = getWorkflowId(labelNames);
      if (!workflowId) continue;

      const currentState = getCurrentState(labelNames);
      if (!currentState) continue;

      // Skip terminal states (done, escape)
      if (currentState === "done" || currentState === "escape") continue;

      // Find when the current state:* label was last set (state entry time)
      // In the new Linear schema, IssueLabelPayload no longer exists as a fragment type.
      // History entries are flat IssueHistory objects. We use the most recent history
      // entry as a best-effort state entry timestamp.
      const historySorted = issue.history.nodes
        .filter((h) => h.createdAt)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

      const stateEnteredAt = historySorted[0]?.createdAt ?? null;

      // Find delegate comments after state entry
      const delegateComments = issue.comments.nodes
        .filter((c) => {
          if (!stateEnteredAt) return false;
          const isDelegate = c.user?.id === agent.linearUserId;
          const afterEntry = c.createdAt >= stateEnteredAt;
          return isDelegate && afterEntry;
        })
        .map((c) => ({ id: c.id, createdAt: c.createdAt, body: c.body }));

      // Find transitions (state:* label changes) after state entry
      const transitionsAfterEntry = issue.history.nodes
        .filter((h) => {
          if (!stateEnteredAt) return false;
          if (!h.createdAt) return false;
          // A transition is a native Linear state change
          const hasStateChange = h.fromState?.name || h.toState?.name;
          if (!hasStateChange) return false;
          return h.createdAt > stateEnteredAt;
        })
        .map((h) => ({
          from: h.fromState?.name ?? "",
          to: h.toState?.name ?? "",
          at: h.createdAt ?? "",
        }));

      // AI-2129: resolve child terminality for barrier-held suppression. A child
      // is terminal if its native Linear state is completed/canceled OR it carries
      // a terminal workflow `state:*` label (done/escape). Native state is checked
      // first so a child closed without a workflow label still counts as terminal.
      const childNodes = issue.children?.nodes ?? [];
      const nonTerminalChildCount = childNodes.filter(
        (child) => !isChildTerminal(child.state?.type ?? null, (child.labels?.nodes ?? []).map((l) => l.name)),
      ).length;

      candidates.push({
        identifier: issue.identifier,
        currentState,
        labels: labelNames,
        delegateId: issue.delegate?.id ?? "",
        stateEnteredAt,
        delegateComments,
        transitionsAfterEntry,
        workflowId,
        totalChildren: childNodes.length,
        nonTerminalChildCount,
      });
    }

    return candidates;
  } catch (err) {
    log.error(
      `Failed to fetch stuck candidates for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
