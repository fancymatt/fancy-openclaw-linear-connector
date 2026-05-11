/**
 * Per-agent session state tracker.
 *
 * Tracks which (agent, ticket) pairs currently have active sessions. The connector
 * uses this to decide whether to send a wake-up signal immediately or defer.
 *
 * Each ticket gets its own independent session key (`linear-<TEAM>-<NUMBER>`).
 * An agent can have multiple concurrent active sessions — one per in-flight ticket.
 * Same-ticket dedup: a second webhook for the same ticket delivers into the existing
 * session immediately. Different-ticket webhooks always dispatch independently.
 *
 * Session-end detection: the connector exposes a POST /session-end endpoint
 * that the gateway (or a gateway plugin) calls when an agent's session ends.
 * The endpoint accepts an optional `sessionKey` for precise per-ticket tracking;
 * if omitted, all sessions for the agent are cleared (backward compat).
 * If no callback arrives within a timeout, sessions are assumed ended.
 */

import { createLogger, componentLogger } from "../logger.js";
import { normalizeSessionKey } from "../session-key.js";

const log = componentLogger(createLogger(), "session-tracker");

const DEFAULT_SESSION_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

export type StaleSessionHandler = (
  staleSessions: { agentId: string; pendingTickets: string[] }[],
) => void | Promise<void>;

export class SessionTracker {
  // agentId → (sessionKey → startedAt)
  private activeSessions: Map<string, Map<string, number>> = new Map();
  private sessionTimeoutMs: number;
  private pendingSignals: Map<string, string[]> = new Map(); // agentId → ticketIds[]
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private onStaleSessions?: StaleSessionHandler;

  constructor(sessionTimeoutMs?: number, onStaleSessions?: StaleSessionHandler) {
    this.sessionTimeoutMs =
      sessionTimeoutMs ??
      parseInt(
        process.env.SESSION_TIMEOUT_MS ?? `${DEFAULT_SESSION_TIMEOUT_MS}`,
        10
      );
    this.onStaleSessions = onStaleSessions;

    // Periodic cleanup of stale sessions. Returned pending work must be
    // re-signaled; otherwise stale cleanup silently strands queued tickets.
    this.cleanupTimer = setInterval(() => {
      const staleSessions = this.cleanupStale();
      if (staleSessions.length === 0 || !this.onStaleSessions) return;
      Promise.resolve(this.onStaleSessions(staleSessions)).catch((err) => {
        log.error(`Stale-session re-signal handler failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * Mark a per-ticket session as active.
   *
   * Returns false only if this exact (agentId, sessionKey) pair is already
   * tracked — same-ticket dedup. Different session keys for the same agent are
   * allowed concurrently; this method will return true for each distinct key.
   */
  startSession(agentId: string, sessionKey: string): boolean {
    let agentSessions = this.activeSessions.get(agentId);
    if (agentSessions?.has(sessionKey)) {
      return false; // This exact session key is already active
    }
    if (!agentSessions) {
      agentSessions = new Map<string, number>();
      this.activeSessions.set(agentId, agentSessions);
    }
    agentSessions.set(sessionKey, Date.now());
    log.info(`Session started: ${agentId} [${sessionKey}] (${agentSessions.size} active session(s))`);
    return true;
  }

  /**
   * Mark a session as ended.
   *
   * If sessionKey is provided, removes only that specific (agentId, sessionKey)
   * entry. Pending signals are returned only when the agent has no remaining
   * active sessions after this call.
   *
   * If sessionKey is omitted, all sessions for the agent are cleared (backward
   * compatibility for callers that don't track per-ticket session keys, e.g. the
   * existing gateway plugin which sends only agentId).
   */
  endSession(agentId: string, sessionKey?: string): string[] | null {
    const agentSessions = this.activeSessions.get(agentId);
    if (!agentSessions || agentSessions.size === 0) {
      if (agentSessions) this.activeSessions.delete(agentId);
      return null;
    }

    if (sessionKey) {
      const had = agentSessions.delete(sessionKey);
      if (!had) return null; // That specific session wasn't tracked as active
      if (agentSessions.size > 0) {
        // Other sessions still active for this agent — defer pending signals
        log.info(`Session ended: ${agentId} [${sessionKey}] (${agentSessions.size} session(s) still active)`);
        return null;
      }
      this.activeSessions.delete(agentId);
      log.info(`Session ended: ${agentId} [${sessionKey}] (no sessions remaining)`);
    } else {
      // End all sessions (backward compat — plugin sends only agentId)
      const keys = [...agentSessions.keys()].join(", ");
      this.activeSessions.delete(agentId);
      log.info(`All sessions ended: ${agentId} [${keys}]`);
    }

    // Return pending signals now that agent has no active sessions
    const pending = this.pendingSignals.get(agentId);
    if (pending && pending.length > 0) {
      this.pendingSignals.delete(agentId);
      return pending;
    }
    return null;
  }

  /**
   * Check if an agent has any active session.
   */
  isActive(agentId: string): boolean {
    const sessions = this.activeSessions.get(agentId);
    return sessions !== undefined && sessions.size > 0;
  }

  /**
   * Check if an agent has an active session for a specific ticket key.
   */
  isActiveForTicket(agentId: string, sessionKey: string): boolean {
    return this.activeSessions.get(agentId)?.has(sessionKey) ?? false;
  }

  /**
   * Queue a retry signal for a ticket whose delivery failed.
   * Will be returned from endSession() when all the agent's sessions complete.
   */
  queueSignal(agentId: string, ticketIds: string[]): void {
    const existing = this.pendingSignals.get(agentId) ?? [];
    // Dedup
    const merged = [...new Set([...existing, ...ticketIds])];
    this.pendingSignals.set(agentId, merged);
    log.info(
      `Queued signal for ${agentId}: ${merged.length} ticket(s) (delivery retry)`
    );
  }

  /** Remove a queued pending signal, optionally across all agents. */
  removePendingTicket(ticketId: string, agentId?: string): number {
    const normalizedTicketId = normalizeSessionKey(ticketId);
    let removed = 0;
    const targets = agentId ? [agentId] : [...this.pendingSignals.keys()];
    for (const target of targets) {
      const existing = this.pendingSignals.get(target);
      if (!existing?.length) continue;
      const next = existing.filter((id) => normalizeSessionKey(id) !== normalizedTicketId);
      removed += existing.length - next.length;
      if (next.length > 0) {
        this.pendingSignals.set(target, next);
      } else {
        this.pendingSignals.delete(target);
      }
    }
    return removed;
  }

  /** Get the first active session key for an agent, or null. */
  getActiveSessionKey(agentId: string): string | null {
    const sessions = this.activeSessions.get(agentId);
    if (!sessions || sessions.size === 0) return null;
    return sessions.keys().next().value ?? null;
  }

  /** Get all active session keys for an agent. */
  getActiveSessionKeys(agentId: string): string[] {
    const sessions = this.activeSessions.get(agentId);
    if (!sessions) return [];
    return [...sessions.keys()];
  }

  /** Get active-session metadata for the first session (diagnostics/metrics). */
  getActiveSessionInfo(agentId: string): { agentId: string; sessionKey: string; startedAt: number; ageMs: number } | null {
    const sessions = this.activeSessions.get(agentId);
    if (!sessions || sessions.size === 0) return null;
    const entry = sessions.entries().next().value;
    if (!entry) return null;
    const [sessionKey, startedAt] = entry as [string, number];
    return {
      agentId,
      sessionKey,
      startedAt,
      ageMs: Date.now() - startedAt,
    };
  }

  /** Get all currently active agent IDs. */
  getActiveAgents(): string[] {
    return [...this.activeSessions.entries()]
      .filter(([, sessions]) => sessions.size > 0)
      .map(([agentId]) => agentId);
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Clean up stale sessions that exceeded the timeout.
   * Returns an array of { agentId, pendingTickets } for agents that lost all
   * sessions due to staleness and had queued pending signals — the caller can
   * re-signal them.
   */
  cleanupStale(): { agentId: string; pendingTickets: string[] }[] {
    const now = Date.now();
    const needsResignal: { agentId: string; pendingTickets: string[] }[] = [];
    for (const [agentId, sessions] of this.activeSessions) {
      for (const [sessionKey, startedAt] of sessions) {
        if (now - startedAt > this.sessionTimeoutMs) {
          log.warn(
            `Stale session detected for ${agentId} [${sessionKey}] (${Math.round(this.sessionTimeoutMs / 60000)}min timeout). Ending.`
          );
          sessions.delete(sessionKey);
        }
      }
      if (sessions.size === 0) {
        this.activeSessions.delete(agentId);
        const pending = this.pendingSignals.get(agentId);
        if (pending && pending.length > 0) {
          this.pendingSignals.delete(agentId);
          needsResignal.push({ agentId, pendingTickets: pending });
        }
      }
    }
    return needsResignal;
  }
}
