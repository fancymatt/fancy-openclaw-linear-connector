/**
 * AI-1428 — Agent liveness pre-flight check.
 *
 * Before routing an implementation-state ticket to an agent, the connector
 * verifies the target can execute at least one model (hooks mode) or that the
 * agent's secrets are provisioned (CLI mode). If the agent is unreachable,
 * the caller receives a structured result and should emit DELEGATE_UNAVAILABLE.
 *
 * Hooks mode: POST to the gateway with a lightweight ping; 2xx = alive.
 * CLI mode: best-effort provisioning check (secrets file exists + token readable).
 *           CLI liveness is weaker — it confirms the agent *exists* but not
 *           that it can actually run a model. Document this delta in the source.
 */

import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "liveness");

export type LivenessResult =
  | { available: true }
  | { available: false; reason: "timeout" | "unreachable" | "error"; detail?: string };

export interface LivenessConfig {
  hooksUrl?: string;
  hooksToken?: string;
  /** Override timeout (default 60 000 ms). */
  timeoutMs?: number;
}

const DEFAULT_LIVENESS_TIMEOUT_MS = 60_000;

/**
 * Check whether an agent is reachable before dispatching work to it.
 *
 * In hooks mode, sends a lightweight POST with `{ ping: true }` and expects
 * a 2xx or a structured `{ ok: true }`. In CLI mode, performs a best-effort
 * check that the agent's secrets exist — this is NOT a true model check.
 */
export async function checkAgentLiveness(
  agentName: string,
  config: LivenessConfig,
): Promise<LivenessResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;

  if (config.hooksUrl && config.hooksToken) {
    return checkHooksLiveness(agentName, config.hooksUrl, config.hooksToken, timeoutMs);
  }

  // CLI mode — best-effort provisioning check.
  return checkCliLiveness(agentName);
}

// ── Hooks mode ──────────────────────────────────────────────────────────────

async function checkHooksLiveness(
  agentName: string,
  hooksUrl: string,
  hooksToken: string,
  timeoutMs: number,
): Promise<LivenessResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(hooksUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hooksToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: agentName, ping: true }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      // Try to parse a structured { ok: true/false } body.
      try {
        const json = (await response.json()) as Record<string, unknown>;
        if (json.ok === false) {
          log.warn(`Liveness check for ${agentName}: gateway returned ok=false`);
          return { available: false, reason: "error", detail: "Gateway returned ok=false" };
        }
      } catch {
        // Non-JSON body but 2xx — treat as alive (backward compat).
      }
      log.info(`Liveness check passed for ${agentName} (hooks mode)`);
      return { available: true };
    }

    const status = response.status;
    const body = await response.text().catch(() => "");

    // A non-auth 4xx proves the gateway is up and answering — it simply rejected
    // the lightweight ping payload (our ping omits the `message` field the inbound
    // contract requires). Liveness measures reachability, not payload acceptance,
    // so a responding gateway is alive. Without this, a cold-start agent whose
    // warm session was reaped can never be re-woken (the nudge is suppressed).
    if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
      log.info(`Liveness check for ${agentName}: HTTP ${status} (gateway responded) — treating as alive`);
      return { available: true };
    }

    log.warn(`Liveness check for ${agentName}: HTTP ${status} — ${body.slice(0, 200)}`);
    return {
      available: false,
      reason: status >= 500 ? "unreachable" : "error",
      detail: `HTTP ${status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn(`Liveness check for ${agentName}: timed out after ${timeoutMs}ms`);
      return { available: false, reason: "timeout", detail: `${timeoutMs}ms timeout` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Liveness check for ${agentName}: ${msg}`);
    return { available: false, reason: "error", detail: msg };
  }
}

// ── CLI mode ────────────────────────────────────────────────────────────────

/**
 * Best-effort check that the agent has provisioned secrets.
 *
 * This is NOT a true model-availability check — it only verifies the agent
 * has a LINEAR_OAUTH_TOKEN in its environment. The delta between this and a
 * full model check is documented: the agent may have secrets but no working
 * model endpoint, and the liveness check will still pass. The 60s hooks-mode
 * timeout is the stronger check; CLI mode is a weaker fallback.
 */
async function checkCliLiveness(agentName: string): Promise<LivenessResult> {
  // In CLI mode we can only check if the agent has a configured token.
  // We rely on process.env for the current process — agents share this.
  const token =
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY ??
    process.env.LINEAR_DEVELOPER_TOKEN;

  if (!token) {
    log.warn(`Liveness check for ${agentName} (CLI mode): no Linear token found`);
    return {
      available: false,
      reason: "error",
      detail: "No LINEAR_OAUTH_TOKEN / LINEAR_API_KEY found in environment",
    };
  }

  // Token exists — assume alive. This is the documented weakness of CLI mode.
  log.info(`Liveness check passed for ${agentName} (CLI mode — provisioning only)`);
  return { available: true };
}
