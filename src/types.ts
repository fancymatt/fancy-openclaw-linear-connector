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
   * INF-38: the issue identifier that was live at routing time, resolved from
   * the stable issue UUID. `sessionKey` is built from this when present.
   * Absent when the event carried no issue UUID or the resolve failed — the
   * fail-open path, where the enqueue-time capture is used instead.
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


