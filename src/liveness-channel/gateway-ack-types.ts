export type GatewayDispatchStatus = "accepted" | "queued";

export interface GatewayDispatchAck {
  delivered: boolean;
  target_identity: string;
  status: GatewayDispatchStatus;
  queue_depth?: number;
  queue_age?: number;
  target_session_key?: string;
}
