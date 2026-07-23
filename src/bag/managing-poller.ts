/**
 * ManagingPoller — periodic stewardship-wake driver for Managing-state tickets.
 *
 * Every cycle, for each configured agent, queries Linear for issues delegated
 * to that agent in the `Managing` workflow state. For each such issue, decides
 * whether the agent is "due" for a stewardship wake based on:
 *
 *   - `lastDispatchedAt` (persisted in ManagingStateStore)
 *   - `Managing-interval: <duration>` parsed from the issue description body
 *     (defaults to 30m when absent or unparseable)
 *
 * All due tickets for a given agent are bundled into a single wake message
 * (so 4 due tickets become 1 stewardship prompt, not 4 separate ones).
 *
 * Configuration (env vars, all optional):
 *   MANAGING_POLLER_CYCLE_MS     — how often the poller runs (default: 60_000)
 *   MANAGING_POLLER_DEFAULT_MS   — default per-ticket interval (default: 1_800_000 = 30m)
 *
 * The first-wake-after-entering-Managing is always immediate (well: on the
 * next poller tick) because `lastDispatchedAt` is null until the first dispatch.
 */

import { createLogger, componentLogger } from "../logger.js";
import { getAccessToken, getAgents, isAgentLocal, isPolledForLinear, type AgentConfig } from "../agents.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { ManagingStateStore } from "../store/managing-state-store.js";
import type { DeliveryConfig } from "../delivery/index.js";
import { sendManagingWakeSignal, type ManagingWakeTicket } from "./managing-wake.js";
import { surfaceStalledChildren, evaluateBarrier, attemptBarrierTransition, isManagedBarrierFromLabels } from "../barrier.js";
import { notify } from "../alerts/alert-bus.js";

const log = componentLogger(createLogger(), "managing-poller");

// Singleton guard (AI-2624 AC5): prevents a second ManagingPoller from being
// instantiated while one is already active. If two pollers run independently,
// neither can see the other's persisted dispatch state during the same cycle
// (they don't share an in-memory buffer), but more importantly they each
// maintain their own setInterval — producing double ~1min wakes from the same
// process. The active-instance count lives on the module so require/import
// deduplication is the only guard; createApp() calls the constructor at most
// once per app instance.
//
// The guard is only enforced in production (NODE_ENV !== 'test') because
// test suites call createApp() many times, each creating a fresh ManagingPoller.
// Construction in test resets the guard automatically via _resetSingletonGuard().
let activeInstanceCount = 0;
export function _resetSingletonGuard(): void {
  activeInstanceCount = 0;
}

const DEFAULT_CYCLE_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export interface ManagingPollerConfig {
  cycleMs: number;
  defaultIntervalMs: number;
}

export interface ManagingPollerDeps {
  store: ManagingStateStore;
  operationalEventStore: OperationalEventStore;
  /**
   * Resolves the delivery config for a given agent. This is called per-agent
   * inside the poll loop so that containerized agents (with their own
   * hooksUrl) get wakes delivered to the right endpoint instead of the global
   * host hooks URL. (AI-1751)
   */
  resolveDeliveryConfig: (agentId: string) => DeliveryConfig;
  /** Overridable for testing — returns the agents to consider. */
  listAgents?: () => AgentConfig[];
  /** Overridable for testing — returns Managing-state tickets for an agent. */
  fetchManagingTickets?: (agent: AgentConfig) => Promise<LinearManagingIssue[]>;
  /** Overridable for testing — sends the bundled stewardship wake. */
  sendWake?: typeof sendManagingWakeSignal;
  /** Overridable for testing — clock source. */
  now?: () => number;
}

export interface LinearManagingIssue {
  identifier: string;
  title: string;
  description: string | null;
  /** Resolved issue label names (e.g. ["wf:sprint-spawner"]). */
  labels: string[];
  /** Current state name (lowercase), e.g. "managing". */
  stateName: string;
}

export interface PollerCycleResult {
  agentsChecked: number;
  ticketsSeen: number;
  ticketsDispatched: number;
  agentsWaked: number;
  errors: number;
}

function parseEnvInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

/**
 * Parse a `Managing-interval: <duration>` marker from an issue description.
 * Returns the interval in ms, or null if absent / unparseable.
 *
 * Recognized formats:
 *   Managing-interval: 30m
 *   Managing-interval: 2h
 *   Managing-interval: 1d
 *   Managing-interval: 90 (treated as minutes for bare numbers)
 *
 * Case-insensitive on the key and unit; only the FIRST match wins (allows
 * the agent to update by adding a new line above the old one, or by replacing).
 */
const INTERVAL_MARKER_RE = /Managing-interval:\s*(\d+)\s*([smhd]?)\b/i;

export function parseManagingInterval(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = INTERVAL_MARKER_RE.exec(body);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n) || n <= 0) return null;
  const unit = (m[2] || "m").toLowerCase();
  switch (unit) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/**
 * Decide whether a ticket is due for a stewardship wake.
 *
 * - If never dispatched: due immediately.
 * - Otherwise: due when (now - lastDispatchedAt) >= intervalMs.
 */
export function isDue(
  now: number,
  lastDispatchedAt: number | null,
  intervalMs: number,
): boolean {
  if (lastDispatchedAt === null) return true;
  return now - lastDispatchedAt >= intervalMs;
}

/**
 * Fetch all Managing-state tickets delegated to an agent from Linear.
 * Uses the agent's own OAuth token. Returns identifier + title + body + labels + state.
 */
async function fetchManagingTicketsForAgent(agent: AgentConfig): Promise<LinearManagingIssue[]> {
  const token = getAccessToken(agent.name);
  if (!token) {
    log.warn(`No access token for agent ${agent.name}; skipping`);
    return [];
  }
  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  const query = `
    query ManagingForAgent($delegateId: ID!) {
      issues(first: 100, filter: {
        delegate: { id: { eq: $delegateId } },
        state: { name: { eq: "Managing" } }
      }) {
        nodes {
          identifier
          title
          description
          labels {
            nodes {
              name
            }
          }
          state {
            name
          }
        }
      }
    }
  `;
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
          title: string;
          description: string | null;
          labels?: { nodes?: Array<{ name: string }> };
          state?: { name: string } | null;
        }>;
      };
    };
    errors?: unknown;
  };
  if (body.errors) {
    throw new Error(`Linear API errors for agent ${agent.name}: ${JSON.stringify(body.errors)}`);
  }
  const raw = body.data?.issues?.nodes ?? [];
  return raw.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    labels: n.labels?.nodes?.map((l) => l.name) ?? [],
    stateName: n.state?.name?.toLowerCase() ?? "",
  }));
}

export class ManagingPoller {
  private timer?: ReturnType<typeof setInterval>;
  private config: ManagingPollerConfig;
  private deps: Required<Omit<ManagingPollerDeps, "fetchManagingTickets" | "listAgents" | "sendWake" | "now">> & {
    fetchManagingTickets: NonNullable<ManagingPollerDeps["fetchManagingTickets"]>;
    listAgents: NonNullable<ManagingPollerDeps["listAgents"]>;
    sendWake: NonNullable<ManagingPollerDeps["sendWake"]>;
    now: NonNullable<ManagingPollerDeps["now"]>;
  };

  constructor(deps: ManagingPollerDeps, config?: Partial<ManagingPollerConfig>) {
    // Singleton guard: prevent double instantiation within the same process
    // (the leading hypothesis for the duplicate ~1min wakes observed on AI-2573).
    // app.create() is called once in production, but defensive code here catches
    // a test/packaging/import mistake that creates two active pollers.
    // Enforced only in production (NODE_ENV !== 'test'); test suites call
    // createApp() many times and auto-reset via _resetSingletonGuard().
    if (process.env.NODE_ENV !== "test") {
      if (activeInstanceCount > 0) {
        throw new Error(
          "ManagingPoller already instantiated — a second instance would create " +
          "an independent timer and lose visibility into the first instance's " +
          "dispatch state. This is likely a packaging/import bug. See AI-2624.",
        );
      }
    }
    activeInstanceCount++;
    this.config = {
      cycleMs: config?.cycleMs ?? parseEnvInt("MANAGING_POLLER_CYCLE_MS", DEFAULT_CYCLE_MS),
      defaultIntervalMs:
        config?.defaultIntervalMs ?? parseEnvInt("MANAGING_POLLER_DEFAULT_MS", DEFAULT_INTERVAL_MS),
    };
    this.deps = {
      store: deps.store,
      operationalEventStore: deps.operationalEventStore,
      resolveDeliveryConfig: deps.resolveDeliveryConfig,
      listAgents: deps.listAgents ?? (() => getAgents().filter(isAgentLocal).filter(isPolledForLinear)),
      fetchManagingTickets: deps.fetchManagingTickets ?? fetchManagingTicketsForAgent,
      sendWake: deps.sendWake ?? sendManagingWakeSignal,
      now: deps.now ?? (() => Date.now()),
    };
  }

  start(): void {
    if (this.timer) return;
    log.info(
      `Managing poller started — cycle=${this.config.cycleMs}ms defaultInterval=${this.config.defaultIntervalMs}ms`,
    );
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        log.error(`Managing poller cycle error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.cycleMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Expose live poller state for /health and ac-validate (AI-2624 AC7).
   * Without waiting for a wake to fire, an operator or test can confirm
   * the scheduler is running, the cycle cadence, and the default interval
   * — and detect at a glance whether the poller was wired at bootstrap
   * (running=true) or never started (running=false).
   */
  liveness(): { running: boolean; cycleMs: number; defaultIntervalMs: number } {
    return {
      running: this.timer !== undefined,
      cycleMs: this.config.cycleMs,
      defaultIntervalMs: this.config.defaultIntervalMs,
    };
  }

  /**
   * Run one poll cycle. Returns a summary of what happened — useful for tests
   * and operator visibility.
   */
  async runCycle(): Promise<PollerCycleResult> {
    const { store, operationalEventStore, resolveDeliveryConfig, listAgents, fetchManagingTickets, sendWake, now } = this.deps;
    const agents = listAgents();
    const result: PollerCycleResult = {
      agentsChecked: 0,
      ticketsSeen: 0,
      ticketsDispatched: 0,
      agentsWaked: 0,
      errors: 0,
    };

    for (const agent of agents) {
      result.agentsChecked++;
      let issues: LinearManagingIssue[] = [];
      try {
        issues = await fetchManagingTickets(agent);
      } catch (err) {
        result.errors++;
        log.error(
          `Managing fetch failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      result.ticketsSeen += issues.length;

      // Prune store entries that no longer belong (ticket left Managing or was reassigned).
      store.pruneAgent(agent.name, issues.map((i) => i.identifier));

      const dueTickets: ManagingWakeTicket[] = [];
      const tsNow = now();

      for (const issue of issues) {
        const intervalMs = parseManagingInterval(issue.description) ?? this.config.defaultIntervalMs;
        const lastDispatchedAt = store.getLastDispatched(agent.name, issue.identifier);
        if (!isDue(tsNow, lastDispatchedAt, intervalMs)) {
          store.ensure(agent.name, issue.identifier);
          continue;
        }
        dueTickets.push({
          identifier: issue.identifier,
          title: issue.title,
          lastDispatchedAt,
          labels: issue.labels,
          stateName: issue.stateName,
        });
      }

      if (dueTickets.length === 0) continue;

      const openclawAgent = agent.openclawAgent ?? agent.name;

      // §5.5 stall detection: surface stalled children via tripwire comments
      // before sending the stewardship wake. This wires the stall detection
      // to a real production trigger (the managing-wake cycle).
      const stallToken = getAccessToken(agent.name);
      if (stallToken) {
        for (const ticket of dueTickets) {
          try {
            const stallResult = await surfaceStalledChildren(
              ticket.identifier,
              /^Bearer\s+/i.test(stallToken) ? stallToken : `Bearer ${stallToken}`,
            );
            if (stallResult.surfaced > 0) {
              log.info(
                `§5.5 tripwire: ${stallResult.surfaced} stalled child(ren) surfaced on ${ticket.identifier}`,
              );
            }
          } catch (err) {
            log.warn(
              `Stall detection failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // INF-122: Barrier-stuck detection — check if any due ticket is in a
      // barrier state with all children terminal but hasn't advanced.
      // This catches the case where a dropped webhook (during a firefight or
      // cron blackout) left the barrier stranded. If detected, attempt the
      // barrier transition to self-heal.
      if (stallToken) {
        for (const ticket of dueTickets) {
          try {
            const barrier = await evaluateBarrier(
              ticket.identifier,
              /^Bearer\s+/i.test(stallToken) ? stallToken : `Bearer ${stallToken}`,
            );
            if (barrier.allTerminal) {
              // All children are terminal but the parent is still in the
              // barrier state — the barrier webhook was missed. Attempt
              // self-healing via the standard barrier transition path.
              log.warn(
                `INF-122 barrier-stuck: ${ticket.identifier} — all ${barrier.totalChildren} child(ren) ` +
                `terminal but still in barrier state; attempting self-heal advance`,
              );
              const transitionResult = await attemptBarrierTransition(
                ticket.identifier,
                /^Bearer\s+/i.test(stallToken) ? stallToken : `Bearer ${stallToken}`,
              );
              if (transitionResult.transitioned) {
                log.info(
                  `INF-122 barrier-stuck self-heal: ${ticket.identifier} — ` +
                  `advanced (${barrier.terminalCount}/${barrier.totalChildren} children terminal)`,
                );
                result.ticketsDispatched++; // count the auto-advance
              } else {
                log.warn(
                  `INF-122 barrier-stuck self-heal FAILED for ${ticket.identifier}: ` +
                  `${transitionResult.error ?? "unknown error"}`,
                );
              }
            }
          } catch (err) {
            log.warn(
              `INF-122 barrier-stuck detection failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      try {
        const agentDeliveryConfig = resolveDeliveryConfig(openclawAgent);
        await sendWake(openclawAgent, dueTickets, agentDeliveryConfig);
        result.ticketsDispatched += dueTickets.length;
        result.agentsWaked++;
        const stamp = now();
        for (const t of dueTickets) {
          store.recordDispatch(agent.name, t.identifier, stamp);
        }
        operationalEventStore.append({
          outcome: "delivered",
          type: "managing-wake",
          agent: openclawAgent,
          key: dueTickets[0].identifier,
          sessionKey: `linear-${dueTickets[0].identifier}`,
          deliveryMode: "managing-poll",
          attemptCount: dueTickets.length,
          detail: { tickets: dueTickets.map((t) => t.identifier) },
        });
      } catch (err) {
        result.errors++;
        log.error(
          `Managing wake delivery failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        notify({
          severity: "warning",
          source: "dispatch",
          title: `managing-wake delivery failed for ${agent.name}`,
          detail: err instanceof Error ? err.message : String(err),
          agent: openclawAgent,
          ticket: dueTickets[0].identifier,
        });
        operationalEventStore.append({
          outcome: "delivery-failed",
          type: "managing-wake",
          agent: openclawAgent,
          key: dueTickets[0].identifier,
          sessionKey: `linear-${dueTickets[0].identifier}`,
          deliveryMode: "managing-poll",
          attemptCount: dueTickets.length,
          errorSummary: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }
}
