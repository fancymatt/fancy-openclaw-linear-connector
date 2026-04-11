/**
 * Core type definitions for the connector service.
 */

import type { LinearEvent } from "./webhook/schema";

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
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Payload sent into OpenClaw as the delivery contract boundary. */
export interface OpenClawAssignmentPayload {
  version: 1;
  source: "linear";
  agentId: string;
  sessionKey: string;
  priority: number;
  eventType: string;
  action: string;
  issue?: {
    id?: string;
    identifier?: string;
    title?: string;
    url?: string;
    teamKey?: string;
    stateName?: string;
    assigneeName?: string;
    priority?: number;
  };
  summary: string;
  rawEvent: LinearEvent;
}

export interface OpenClawDeliveryRequest {
  destination: {
    agentId: string;
    sessionKey: string;
  };
  payload: OpenClawAssignmentPayload;
}

export interface OpenClawDeliveryResult {
  ok: boolean;
  destination: {
    agentId: string;
    sessionKey: string;
  };
  transport: "mock" | "http";
  requestBody: string;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}
