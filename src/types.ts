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
  routingReason?: "delegate" | "assignee" | "mention" | "body-mention" | "department-prefix" | "steward-escalation";
  coalescedCount?: number;
  /**
   * INF-38: Canonical identifier resolved from the event UUID at delivery time.
   * When set, this is the live identifier (post-move) and should be used in
   * delivery messages instead of the event-captured identifier.
   */
  canonicalIdentifier?: string;
}

/** Connector service configuration. */
export interface ConnectorConfig {
  port: number;
  linearWebhookSecret: string;
  openclawGatewayUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
}


