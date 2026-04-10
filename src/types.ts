/**
 * Core type definitions for the connector service.
 */

/** Normalized Linear event after ingestion and parsing. */
export interface LinearEvent {
  id: string;
  type: string;
  action: string;
  createdAt: string;
  data: Record<string, unknown>;
}

/** Routing decision mapping an event to an OpenClaw agent. */
export interface RouteResult {
  agentId: string;
  sessionKey: string;
  priority: number;
  event: LinearEvent;
}

/** Connector service configuration. */
export interface ConnectorConfig {
  port: number;
  linearWebhookSecret: string;
  openclawGatewayUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
