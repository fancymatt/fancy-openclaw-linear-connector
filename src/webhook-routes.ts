/**
 * Static webhook route mapping.
 *
 * AI-2112: Replaces the `allowRequestSessionKey`-based dispatch (where the
 * inbound webhook payload specifies its own OpenClaw session key) with a
 * static config — each agent/webhook-source maps to a fixed session key.
 *
 * The connector's router (`router.ts`) derives session keys deterministically
 * as `linear-<TEAM>-<NUMBER>` from the issue identifier. This module provides
 * the canonical mapping from agent name → allowed session key patterns,
 * serving as an explicit allowlist. Any route whose session key does not match
 * a configured entry is rejected before delivery.
 *
 * Config file: `{instanceConfigRoot()}/config/webhook-routes.yaml`
 */

import fs from "node:fs";
import path from "node:path";
import { instanceConfigRoot } from "./instance-config.js";
import { createLogger, componentLogger } from "./logger.js";
import yaml from "js-yaml";

const log = componentLogger(createLogger(), "webhook-routes");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookRouteEntry {
  /** Agent name (matches agents.json `name` or `openclawAgent`). */
  agent: string;
  /**
   * Session key pattern for this agent's ticket routes.
   * Supports a single `{identifier}` placeholder, replaced with the
   * Linear issue identifier (e.g. "AI-2112") at runtime.
   * Example: "linear-{identifier}"
   */
  sessionKey: string;
  /** Optional description / human-readable note. */
  description?: string;
}

export interface WebhookRoutesConfig {
  routes: WebhookRouteEntry[];
  /**
   * When true, log a warning (but allow) for any route that doesn't match
   * a configured entry. Default: false (reject unmapped routes with 500).
   */
  allowUnmapped?: boolean;
}

// ---------------------------------------------------------------------------
// Default config path
// ---------------------------------------------------------------------------

function defaultRoutesPath(): string {
  return path.join(instanceConfigRoot(), "config", "webhook-routes.yaml");
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

let cachedRoutes: WebhookRouteEntry[] | null = null;
let cachedAllowUnmapped = false as boolean;



/**
 * Load the webhook routes config from disk.
 * Returns the parsed config, or null with a logged warning if the file
 * is missing (fail-open for gradual rollout — a missing config logs a
 * warning but doesn't crash).
 *
 * Note: this is a synchronous function for startup simplicity. If called
 * from an ESM-only context, it falls back to a synchronous best-effort parse;
 * CJS calls use the synchronous require-based path.
 */
export function loadWebhookRoutes(filePath?: string): WebhookRoutesConfig | null {
  const resolvedPath = filePath ?? process.env.WEBHOOK_ROUTES_PATH ?? defaultRoutesPath();
  try {
    if (!fs.existsSync(resolvedPath)) {
      log.warn(`Webhook routes config not found at ${resolvedPath} — no static route validation (routes fall back to default behavior)`);
      return null;
    }
    const raw = fs.readFileSync(resolvedPath, "utf8");
    
    const parsedRaw = yaml.load(raw) as Record<string, unknown>;
    
    if (!parsedRaw || typeof parsedRaw !== "object") {
      log.warn(`Webhook routes config at ${resolvedPath} is empty or invalid — no static route validation`);
      return null;
    }
    const routes = Array.isArray(parsedRaw.routes)
      ? parsedRaw.routes as WebhookRouteEntry[]
      : [];
    const allowUnmapped = parsedRaw.allowUnmapped === true;
    log.info(`Loaded ${routes.length} webhook route(s) from ${resolvedPath}${allowUnmapped ? " (allowUnmapped)" : ""}`);
    return { routes, allowUnmapped };
  } catch (err) {
    log.warn(`Failed to load webhook routes config from ${resolvedPath}: ${err instanceof Error ? err.message : String(err)} — no static route validation`);
    return null;
  }
}

/**
 * Load and cache the webhook routes config. Called at startup.
 */
export function initWebhookRoutes(filePath?: string): void {
  const cfg = loadWebhookRoutes(filePath);
  if (cfg) {
    cachedRoutes = cfg.routes;
    cachedAllowUnmapped = cfg.allowUnmapped === true;
  } else {
    cachedRoutes = null;
    cachedAllowUnmapped = false;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the session key for a given agent and issue identifier from the
 * static mapping. Returns the resolved session key string, or null if the
 * combination is not in the mapping (unmapped).
 *
 * If no routes are loaded (config missing or startup not yet complete),
 * returns the fallback session key — backward compatible for gradual rollout.
 *
 * @param agentId - Agent name (e.g. "grover", "ai").
 * @param identifier - Linear issue identifier (e.g. "AI-2112").
 * @param fallbackSessionKey - Session key to use when no static mapping is configured.
 * @returns The resolved session key, or null if unmapped.
 */
export function resolveMappedSessionKey(
  agentId: string,
  identifier: string | null,
  fallbackSessionKey: string,
): string | null {
  // No static mapping loaded — fall back to the computed session key.
  if (cachedRoutes === null) {
    return fallbackSessionKey;
  }

  if (!identifier) {
    // Can't map without an identifier. If allowUnmapped, use fallback.
    if (cachedAllowUnmapped) {
      return fallbackSessionKey;
    }
    log.warn(`Static route rejection: no identifier for agent ${agentId} — dropping`);

    return null;
  }

  // Find a matching entry for this agent.
  const entry = cachedRoutes.find((r) => r.agent === agentId);
  if (!entry) {
    if (cachedAllowUnmapped) {
      return fallbackSessionKey;
    }
    log.warn(`Static route rejection: agent "${agentId}" not in webhook-routes config — dropping`);
    return null;
  }

  // Resolve any {identifier} placeholder.
  const sessionKey = entry.sessionKey.replace(/\{identifier\}/g, identifier);
  return sessionKey;
}

/**
 * Validate that all currently-registered agents have route entries.
 * Returns a list of missing agent names (empty = all good).
 */
export function findUnmappedAgents(registeredAgentNames: string[]): string[] {
  if (cachedRoutes === null) return []; // No mapping loaded — can't validate
  return registeredAgentNames.filter(
    (name) => !cachedRoutes!.some((r) => r.agent === name),
  );
}

/** Reset cached routes (for testing). */
export function resetWebhookRoutes(): void {
  cachedRoutes = null;
  cachedAllowUnmapped = false;
}
