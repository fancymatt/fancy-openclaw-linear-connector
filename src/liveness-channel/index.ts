import type { DispatchRecord, DispatchRecordStore } from "./dispatch-record-store.js";
import type { GatewayDispatchAck } from "./gateway-ack-types.js";
import type { SessionHealthProbe, SessionHealthResult } from "./session-health.js";
import { normalizeSessionKey } from "../session-key.js";
import type { TurnLivenessProbe, TurnLivenessResult } from "./turn-liveness.js";

export interface LivenessChannelConfig {
  probeCadenceMs?: number;
  ackTimeoutMs?: number;
}

export interface LivenessSnapshot {
  ticketId: string;
  timestamp: string;
  dispatch: {
    sent: boolean;
    acknowledged: boolean;
    hasRecord: boolean;
    dispatchId?: string;
    agentId?: string;
    sessionKey?: string;
    status?: DispatchRecord["status"];
    createdAt?: string;
    ackedAt?: string;
    ack: GatewayDispatchAck | null;
    wrongTarget?: DispatchRecord["wrongTarget"];
  };
  sessionHealth: SessionHealthResult;
  turnLiveness: TurnLivenessResult;
}

export interface LivenessChannelEndpointOptions {
  dispatchRecordStore: Pick<DispatchRecordStore, "getDispatch" | "getDispatchesForTicket">;
  sessionHealthProbe: Pick<SessionHealthProbe, "check">;
  turnLivenessProbe: Pick<TurnLivenessProbe, "check">;
  config?: LivenessChannelConfig;
}

const DEFAULT_CONFIG: Required<LivenessChannelConfig> = {
  probeCadenceMs: 30_000,
  ackTimeoutMs: 60_000,
};

export class LivenessChannelEndpoint {
  private dispatchRecordStore: LivenessChannelEndpointOptions["dispatchRecordStore"];
  private sessionHealthProbe: LivenessChannelEndpointOptions["sessionHealthProbe"];
  private turnLivenessProbe: LivenessChannelEndpointOptions["turnLivenessProbe"];
  public readonly config: Required<LivenessChannelConfig>;

  constructor(options: LivenessChannelEndpointOptions) {
    this.dispatchRecordStore = options.dispatchRecordStore;
    this.sessionHealthProbe = options.sessionHealthProbe;
    this.turnLivenessProbe = options.turnLivenessProbe;
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  }

  snapshotForTicket(ticketId: string): LivenessSnapshot {
    const normalizedTicketId = this.normalizeTicketIdForSnapshot(ticketId);
    const record = this.findLatestDispatch(normalizedTicketId);
    const agentId = record?.agentId ?? "igor";
    const dispatch = record
      ? {
          sent: true,
          acknowledged: record.status === "acknowledged",
          hasRecord: true,
          dispatchId: record.dispatchId,
          agentId: record.agentId,
          sessionKey: record.sessionKey,
          status: record.status,
          createdAt: record.createdAt,
          ackedAt: record.ackedAt,
          ack: record.ack,
          wrongTarget: record.wrongTarget,
        }
      : {
          sent: false,
          acknowledged: false,
          hasRecord: false,
          ack: null,
        };

    return {
      ticketId: normalizedTicketId,
      timestamp: new Date().toISOString(),
      dispatch,
      sessionHealth: this.safeSessionHealth(agentId),
      turnLiveness: this.safeTurnLiveness(agentId, normalizedTicketId),
    };
  }

  private normalizeTicketIdForSnapshot(ticketId: string): string {
    try {
      return normalizeSessionKey(ticketId);
    } catch {
      return ticketId;
    }
  }

  private findLatestDispatch(ticketId: string): DispatchRecord | null {
    if (typeof this.dispatchRecordStore.getDispatchesForTicket === "function") {
      const records = this.dispatchRecordStore.getDispatchesForTicket(ticketId);
      return records[0] ?? null;
    }
    if (typeof this.dispatchRecordStore.getDispatch === "function") {
      return this.dispatchRecordStore.getDispatch(ticketId);
    }
    return null;
  }

  private safeSessionHealth(agentId: string): SessionHealthResult {
    if (typeof this.sessionHealthProbe.check !== "function") {
      return { healthy: false, reason: "session health probe unavailable" };
    }
    return this.sessionHealthProbe.check(agentId);
  }

  private safeTurnLiveness(agentId: string, ticketId: string): TurnLivenessResult {
    if (typeof this.turnLivenessProbe.check !== "function") {
      return {
        active: false,
        hasInFlightTurn: false,
        hasRunningSubagent: false,
        sessionKey: ticketId,
      };
    }
    return this.turnLivenessProbe.check(agentId, ticketId);
  }
}
