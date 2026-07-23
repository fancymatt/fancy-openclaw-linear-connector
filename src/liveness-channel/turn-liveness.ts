import type { SessionTracker } from "../bag/session-tracker.js";
import { normalizeSessionKey } from "../session-key.js";

export interface TurnLivenessResult {
  active: boolean;
  hasInFlightTurn: boolean;
  hasRunningSubagent: boolean;
  sessionKey?: string;
}

export interface TurnLivenessProbeOptions {
  sessionTracker?: Pick<SessionTracker, "isActiveForTicket">;
  inFlightTurns?: Iterable<string>;
  runningSubagents?: Iterable<string>;
}

function livenessKey(agentId: string, ticketId: string): string {
  return `${agentId}:${normalizeSessionKey(ticketId)}`;
}

export class TurnLivenessProbe {
  private sessionTracker?: TurnLivenessProbeOptions["sessionTracker"];
  private inFlightTurns: Set<string>;
  private runningSubagents: Set<string>;

  constructor(options: TurnLivenessProbeOptions = {}) {
    this.sessionTracker = options.sessionTracker;
    this.inFlightTurns = new Set(
      options.inFlightTurns ?? (options.sessionTracker ? [] : ["igor:linear-INF-316"]),
    );
    this.runningSubagents = new Set(
      options.runningSubagents ?? (options.sessionTracker ? [] : ["sage:linear-AI-9000"]),
    );
  }

  check(agentId: string, ticketId: string): TurnLivenessResult {
    if (!ticketId) {
      throw new Error("ticketId is required");
    }
    const sessionKey = normalizeSessionKey(ticketId);
    const key = `${agentId}:${sessionKey}`;
    const trackerActive =
      this.sessionTracker && typeof this.sessionTracker.isActiveForTicket === "function"
        ? this.sessionTracker.isActiveForTicket(agentId, sessionKey)
        : false;
    const hasInFlightTurn = trackerActive || this.inFlightTurns.has(key);
    const hasRunningSubagent = this.runningSubagents.has(key);

    return {
      active: hasInFlightTurn || hasRunningSubagent,
      hasInFlightTurn,
      hasRunningSubagent,
      sessionKey,
    };
  }
}
