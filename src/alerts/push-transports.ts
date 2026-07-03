import { componentLogger, createLogger, type Logger } from "../logger.js";

/**
 * Push transport chain for the alert bus (docs/alert-bus.md).
 *
 * Alerts must reach a human even when parts of the stack are degraded, so the
 * push sink tries transports in order and stops at the first success:
 *
 *   1. matrix-message  — deterministic channel post via the gateway `message`
 *                        tool (/tools/invoke). No model turn in the path.
 *                        Needs ALERT_GATEWAY_URL/TOKEN + ALERT_MATRIX_ROOM and
 *                        the `message` tool allowed on that gateway.
 *   2. hook-relay      — /hooks/agent turn that relays the alert text to the
 *                        Matrix room (deliver:true). Works with today's config
 *                        but depends on a successful model turn.
 *   3. push_notification — gateway notification tool (G-20 canary precedent).
 *
 * Every transport failure is logged; total failure is surfaced to the caller
 * so the bus can log "push undeliverable" (the alert is already stored).
 */

const PUSH_TIMEOUT_MS = 10_000;

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "alert-push");

async function postJson(url: string, token: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface Transport {
  name: string;
  /** Returns true when configured well enough to attempt. */
  available: () => boolean;
  send: (message: string) => Promise<void>;
}

export function matrixMessageTransport(): Transport {
  const gatewayUrl = (process.env.ALERT_GATEWAY_URL ?? "").replace(/\/$/, "");
  const token = process.env.ALERT_GATEWAY_TOKEN;
  const room = process.env.ALERT_MATRIX_ROOM;
  const account = process.env.ALERT_MATRIX_ACCOUNT;
  return {
    name: "matrix-message",
    available: () => Boolean(gatewayUrl && room),
    send: async (message: string) => {
      const args: Record<string, unknown> = { action: "send", channel: "matrix", target: room, message };
      if (account) args.accountId = account;
      const response = await postJson(`${gatewayUrl}/tools/invoke`, token, { tool: "message", args });
      const text = await response.text();
      if (!response.ok) throw new Error(`tools/invoke message returned ${response.status}: ${text.slice(0, 200)}`);
      const parsed = JSON.parse(text) as { ok?: boolean; error?: { message?: string } };
      if (parsed.ok === false) throw new Error(`message tool failed: ${parsed.error?.message ?? "unknown"}`);
    },
  };
}

export function hookRelayTransport(): Transport {
  const hookUrl = process.env.ALERT_HOOK_URL;
  const hookToken = process.env.ALERT_HOOK_TOKEN;
  const agentId = process.env.ALERT_HOOK_AGENT ?? "astrid";
  const room = process.env.ALERT_MATRIX_ROOM;
  return {
    name: "hook-relay",
    available: () => Boolean(hookUrl && hookToken && room),
    send: async (message: string) => {
      const response = await postJson(hookUrl!, hookToken, {
        agentId,
        message:
          `You are relaying a connector alert to Matt. Repeat the following alert verbatim as your entire reply ` +
          `(no preamble, no commentary):\n\n${message}`,
        deliver: true,
        channel: "matrix",
        to: room,
      });
      if (!response.ok) throw new Error(`hooks/agent relay returned ${response.status}`);
    },
  };
}

export function pushNotificationTransport(): Transport {
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789").replace(/\/$/, "");
  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_PASSWORD;
  return {
    name: "push-notification",
    available: () => true,
    send: async (message: string) => {
      const response = await postJson(`${gatewayUrl}/tools/invoke`, token, {
        tool: "push_notification",
        args: { message },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`tools/invoke push_notification returned ${response.status}: ${text.slice(0, 200)}`);
      const parsed = JSON.parse(text) as { ok?: boolean; error?: { message?: string } };
      if (parsed.ok === false) throw new Error(`push_notification failed: ${parsed.error?.message ?? "unknown"}`);
    },
  };
}

/** Try each transport in order; resolve on first success, throw if all fail. */
export async function sendThroughChain(message: string, transports?: Transport[]): Promise<string> {
  const chain = transports ?? [matrixMessageTransport(), hookRelayTransport(), pushNotificationTransport()];
  const errors: string[] = [];
  for (const transport of chain) {
    if (!transport.available()) {
      errors.push(`${transport.name}: not configured`);
      continue;
    }
    try {
      await transport.send(message);
      return transport.name;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${transport.name}: ${msg}`);
      log.warn(`push transport ${transport.name} failed: ${msg}`);
    }
  }
  throw new Error(`all push transports failed — ${errors.join(" | ")}`);
}
