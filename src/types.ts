/**
 * Core type definitions for the connector service.
 */

import type { LinearEvent } from "./webhook/schema.js";

/** Routing decision mapping an event to an OpenClaw agent. */
export interface RouteResult {
  agentId: string;
  sessionKey: string;
  priority: number;
  event: LinearEvent;
  routingReason?: "delegate" | "assignee" | "mention" | "body-mention";
}

/** Connector service configuration. */
export interface ConnectorConfig {
  port: number;
  linearWebhookSecret: string;
  openclawGatewayUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
}


