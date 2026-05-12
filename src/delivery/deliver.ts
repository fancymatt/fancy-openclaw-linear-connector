import { spawn } from "child_process";
import type { RouteResult } from "../types.js";
import { createLogger, componentLogger } from "../logger.js";
import { buildDeliveryMessage } from "./build-message.js";

const log = componentLogger(createLogger(), "delivery");

export interface DeliveryConfig {
  nodeBin: string;
  hooksUrl?: string;
  hooksToken?: string;
  hooksThinking?: string;
  hooksModel?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface DeliveryResult {
  dispatched: boolean;
  runId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRIES = 1;

/**
 * Deliver a routed event to an OpenClaw agent.
 *
 * Two modes:
 * 1. **HTTP hooks** — POST to an isolated agent endpoint (when hooksUrl + hooksToken configured).
 * 2. **CLI spawn** — run `openclaw agent` as a detached child process (default).
 *
 * Both modes include retry with configurable timeout/delay/attempts.
 * Errors are logged, never thrown.
 */
export async function deliverToAgent(
  route: RouteResult,
  config: DeliveryConfig,
): Promise<DeliveryResult> {
  return await deliverMessageToAgent(
    route.agentId,
    route.sessionKey,
    buildDeliveryMessage(route),
    config,
  );
}

/** Deliver an explicit operator-authored message to an existing OpenClaw session. */
export async function deliverMessageToAgent(
  agentName: string,
  sessionId: string,
  message: string,
  config: DeliveryConfig,
): Promise<DeliveryResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

  if (config.hooksUrl && config.hooksToken) {
    return deliverViaHooks(agentName, sessionId, config, { message, timeoutMs, retryDelayMs, maxRetries });
  }
  return deliverViaCli(agentName, sessionId, config, { message, timeoutMs, retryDelayMs, maxRetries });
}

// ── HTTP Hooks Mode ──────────────────────────────────────────────────────────

async function deliverViaHooks(
  agentName: string,
  sessionId: string,
  config: DeliveryConfig,
  opts: { message: string; timeoutMs: number; retryDelayMs: number; maxRetries: number },
): Promise<DeliveryResult> {

  let result: DeliveryResult = { dispatched: false };
  for (let attempt = 0; attempt <= opts.maxRetries && !result.dispatched; attempt++) {
    if (attempt > 0) {
      log.info(
        `Retrying isolated delivery for ${agentName} [${sessionId}] (attempt ${attempt + 1}/${opts.maxRetries + 1}) after ${opts.retryDelayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, opts.retryDelayMs));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      const response = await fetch(config.hooksUrl!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.hooksToken!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: agentName,
          sessionKey: sessionId,
          message: opts.message,
          thinking: config.hooksThinking || undefined,
          model: config.hooksModel || undefined,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const errBody = await response.text().catch(() => "no body");
        throw new Error(`hooks responded with ${response.status}: ${errBody}`);
      }
      const json = (await response.json()) as { runId?: string };
      log.info(
        `Isolated delivery dispatched for ${agentName} [${sessionId}]: runId=${json.runId ?? "ok"}`,
      );
      result = { dispatched: true, runId: json.runId };
    } catch (err) {
      log.error(
        `Isolated delivery attempt ${attempt + 1} failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!result.dispatched) {
    log.error(`All delivery attempts exhausted for ${agentName} [${sessionId}]`);
  }
  return result;
}

// ── CLI Spawn Mode ───────────────────────────────────────────────────────────

async function deliverViaCli(
  agentName: string,
  sessionId: string,
  config: DeliveryConfig,
  opts: { message: string; timeoutMs: number; retryDelayMs: number; maxRetries: number },
): Promise<DeliveryResult> {

  let result: DeliveryResult = { dispatched: false };
  for (let attempt = 0; attempt <= opts.maxRetries && !result.dispatched; attempt++) {
    if (attempt > 0) {
      log.info(
        `Retrying CLI delivery for ${agentName} [${sessionId}] (attempt ${attempt + 1}/${opts.maxRetries + 1}) after ${opts.retryDelayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, opts.retryDelayMs));
    }
    try {
      result = { dispatched: await new Promise<boolean>((resolve) => {
        const child = spawn(
          config.nodeBin,
          ["openclaw", "agent", "--agent", agentName, "--message", opts.message, "--channel", "telegram", "--deliver"],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.unref();

        const timer = setTimeout(() => {
          log.warn(
            `CLI delivery timed out after ${opts.timeoutMs}ms for ${agentName} — killing child`,
          );
          child.kill("SIGKILL");
          resolve(false);
        }, opts.timeoutMs);

        child.on("exit", (code: number | null) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve(true);
          } else {
            log.error(`CLI delivery exited with code ${code} for ${agentName}`);
            resolve(false);
          }
        });
        child.on("error", (err: Error) => {
          clearTimeout(timer);
          log.error(`CLI delivery spawn error for ${agentName}: ${err.message}`);
          resolve(false);
        });
      }) };
    } catch (err) {
      log.error(
        `CLI delivery attempt ${attempt + 1} threw for ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (result.dispatched) {
    log.info(`Delivery spawned for ${agentName} [${sessionId}]`);
  } else {
    log.error(`All CLI delivery attempts exhausted for ${agentName} [${sessionId}]`);
  }
  return result;
}
