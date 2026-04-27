/**
 * Per-agent session state tracker.
 *
 * Tracks which agents currently have active sessions. The connector uses this
 * to decide whether to send a wake-up signal immediately (no active session)
 * or defer (agent is busy; signal after session ends).
 *
 * Session-end detection: the connector exposes a POST /session-end endpoint
 * that the gateway (or a gateway plugin) calls when an agent's session ends.
 * If no callback arrives within a timeout, the session is assumed ended.
 */

import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(), "session-tracker");

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class SessionTracker {
  private activeSessions: Map<
    string,
    { startedAt: number; agentId: string; sessionKey: string }
  > = new Map();
  private sessionTimeoutMs: number;
  private pendingSignals: Map<string, string[]> = new Map(); // agentId → ticketIds[]
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(sessionTimeoutMs?: number) {
    this.sessionTimeoutMs =
      sessionTimeoutMs ??
      parseInt(
        process.env.SESSION_TIMEOUT_MS ?? `${DEFAULT_SESSION_TIMEOUT_MS}`,
        10
      );

    // Periodic cleanup of stale sessions
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * Mark an agent's session as active. Returns false if the agent already
   * has an active session (caller should queue work instead).
   */
  startSession(agentId: string, sessionKey: string): boolean {
    if (this.activeSessions.has(agentId)) {
      return false;
    }
    this.activeSessions.set(agentId, {
      startedAt: Date.now(),
      agentId,
      sessionKey,
    });
    log.info(`Session started: ${agentId} [${sessionKey}]`);
    return true;
  }

  /**
   * Mark an agent's session as ended. If there are pending signals for this
   * agent, returns the ticket IDs that should trigger a new wake-up.
   */
  endSession(agentId: string): string[] | null {
    const session = this.activeSessions.get(agentId);
    if (!session) {
      return null;
    }
    const duration = Date.now() - session.startedAt;
    this.activeSessions.delete(agentId);
    log.info(
      `Session ended: ${agentId} [${session.sessionKey}] (duration: ${Math.round(duration / 1000)}s)`
    );

    // Check for pending signals
    const pending = this.pendingSignals.get(agentId);
    if (pending && pending.length > 0) {
      this.pendingSignals.delete(agentId);
      return pending;
    }
    return null;
  }

  /**
   * Check if an agent has an active session.
   */
  isActive(agentId: string): boolean {
    return this.activeSessions.has(agentId);
  }

  /**
   * Queue a signal for an agent that's currently busy.
   * Will be returned from endSession() when the session completes.
   */
  queueSignal(agentId: string, ticketIds: string[]): void {
    const existing = this.pendingSignals.get(agentId) ?? [];
    // Dedup
    const merged = [...new Set([...existing, ...ticketIds])];
    this.pendingSignals.set(agentId, merged);
    log.info(
      `Queued signal for ${agentId}: ${merged.length} ticket(s) (session active)`
    );
  }

  /** Get the session key for an active agent session, or null. */
  getActiveSessionKey(agentId: string): string | null {
    return this.activeSessions.get(agentId)?.sessionKey ?? null;
  }

  /** Get all currently active agent IDs. */
  getActiveAgents(): string[] {
    return [...this.activeSessions.keys()];
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [agentId, session] of this.activeSessions) {
      if (now - session.startedAt > this.sessionTimeoutMs) {
        log.warn(
          `Stale session detected for ${agentId} [${session.sessionKey}] (${Math.round(this.sessionTimeoutMs / 60000)}min timeout). Ending.`
        );
        this.activeSessions.delete(agentId);
      }
    }
  }
}
